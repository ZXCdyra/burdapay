import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { ApiKeyStatus, Merchant, PartyStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const publicKey = req.headers['x-api-key'];

    if (typeof publicKey !== 'string') {
      throw new UnauthorizedException('Missing x-api-key header');
    }

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

    req.merchant = apiKey.merchant as Merchant;
    void this.prisma.apiKey
      .update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);

    return true;
  }
}
