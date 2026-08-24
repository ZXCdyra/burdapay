import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { ApiKeyStatus, Merchant, PartyStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AppConfig } from '../config/app-config.service';
import { CryptoUtil } from '../utils/crypto.util';
import { HmacUtil } from '../utils/hmac.util';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RawBodyRequest<Request>>();
    const publicKey = req.headers['x-api-key'];
    const signature = req.headers['x-signature'];

    if (typeof publicKey !== 'string' || typeof signature !== 'string') {
      throw new UnauthorizedException('Missing x-api-key or x-signature headers');
    }

    const rawBody = req.rawBody ? req.rawBody.toString('utf8') : '';

    const apiKey = await this.prisma.apiKey.findUnique({
      where: { publicKey },
      include: { merchant: true },
    });

    if (!apiKey || apiKey.status !== ApiKeyStatus.ACTIVE) {
      throw new UnauthorizedException('Unknown or revoked API key');
    }
    if (apiKey.merchant.status !== PartyStatus.ACTIVE) {
      throw new UnauthorizedException('Merchant account is not active');
    }

    let secret: string;
    try {
      secret = CryptoUtil.decrypt(apiKey.secretEncrypted, this.cfg.encryptionKey);
    } catch {
      throw new UnauthorizedException('API key integrity failure');
    }

    if (!HmacUtil.verifySignatureHeader(secret, rawBody, signature)) {
      throw new UnauthorizedException('Invalid HMAC signature');
    }

    req.merchant = apiKey.merchant as Merchant;
    void this.prisma.apiKey
      .update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);

    return true;
  }
}
