import { Injectable, ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PartyStatus, Prisma } from '@prisma/client';
import { UserRole } from '../common/types/user-role.type';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfig } from '../common/config/app-config.service';
import { CryptoUtil } from '../common/utils/crypto.util';

export interface LoginResult {
  accessToken: string;
  role: UserRole;
  email: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly cfg: AppConfig,
  ) {}

  private sign(sub: string, email: string, role: UserRole): string {
    return this.jwt.sign({ sub, email, role }, { secret: this.cfg.jwtSecret, expiresIn: this.cfg.jwtTtl });
  }

  async registerMerchant(name: string, email: string, password: string): Promise<{
    accessToken: string;
    apiKey: { publicKey: string; secret: string };
  }> {
    const existing = await this.prisma.merchant.findUnique({ where: { email } });
    if (existing) throw new ConflictException('Merchant with this email already exists');

    const callbackSecret = CryptoUtil.randomHex(32);
    const merchant = await this.prisma.merchant.create({
      data: {
        name,
        email,
        passwordHash: await bcrypt.hash(password, 10),
        status: PartyStatus.ACTIVE,
        callbackSecretEncrypted: CryptoUtil.encrypt(callbackSecret, this.cfg.encryptionKey),
      },
    });

    const publicKey = `pk_${CryptoUtil.randomHex(16)}`;
    const secret = `sk_${CryptoUtil.randomHex(32)}`;
    await this.prisma.apiKey.create({
      data: {
        merchantId: merchant.id,
        name: 'default',
        publicKey,
        secretEncrypted: CryptoUtil.encrypt(secret, this.cfg.encryptionKey),
        secretPrefix: `${secret.slice(0, 8)}...`,
      },
    });

    return {
      accessToken: this.sign(merchant.id, merchant.email, UserRole.MERCHANT),
      apiKey: { publicKey, secret },
    };
  }

  async registerTrader(email: string, password: string, displayName: string): Promise<{ accessToken: string }> {
    const existing = await this.prisma.trader.findUnique({ where: { email } });
    if (existing) throw new ConflictException('Trader with this email already exists');

    const trader = await this.prisma.trader.create({
      data: {
        email,
        displayName,
        passwordHash: await bcrypt.hash(password, 10),
      },
    });
    return { accessToken: this.sign(trader.id, trader.email, UserRole.TRADER) };
  }

  async bootstrapAdmin(email: string, password: string): Promise<LoginResult> {
    const adminCount = await this.prisma.adminUser.count();
    if (adminCount > 0) {
      throw new ConflictException('An administrator already exists. Bootstrap is disabled.');
    }

    const existing = await this.prisma.adminUser.findUnique({ where: { email } });
    if (existing) throw new ConflictException('Administrator with this email already exists');

    const admin = await this.prisma.adminUser.create({
      data: { email, passwordHash: await bcrypt.hash(password, 12) },
    });
    return { accessToken: this.sign(admin.id, admin.email, UserRole.ADMIN), role: UserRole.ADMIN, email };
  }

  async login(email: string, password: string): Promise<LoginResult> {
    const merchant = await this.prisma.merchant.findUnique({ where: { email } });
    if (merchant && (await bcrypt.compare(password, merchant.passwordHash))) {
      if (merchant.status === PartyStatus.BLOCKED) throw new UnauthorizedException('Account blocked');
      return { accessToken: this.sign(merchant.id, merchant.email, UserRole.MERCHANT), role: UserRole.MERCHANT, email };
    }

    const trader = await this.prisma.trader.findUnique({ where: { email } });
    if (trader && (await bcrypt.compare(password, trader.passwordHash))) {
      if (trader.status === PartyStatus.BLOCKED) throw new UnauthorizedException('Account blocked');
      return { accessToken: this.sign(trader.id, trader.email, UserRole.TRADER), role: UserRole.TRADER, email };
    }

    const admin = await this.prisma.adminUser.findUnique({ where: { email } });
    if (admin && (await bcrypt.compare(password, admin.passwordHash))) {
      return { accessToken: this.sign(admin.id, admin.email, UserRole.ADMIN), role: UserRole.ADMIN, email };
    }

    throw new UnauthorizedException('Invalid credentials');
  }

  async me(user: { id: string; role: UserRole }): Promise<Record<string, unknown>> {
    switch (user.role) {
      case UserRole.MERCHANT: {
        const merchant = await this.prisma.merchant.findUnique({ where: { id: user.id } });
        if (!merchant) throw new UnauthorizedException('Merchant not found');
        return {
          ...this.sanitize(merchant, ['passwordHash', 'callbackSecretEncrypted']),
          role: UserRole.MERCHANT,
        };
      }
      case UserRole.TRADER: {
        const trader = await this.prisma.trader.findUnique({ where: { id: user.id } });
        if (!trader) throw new UnauthorizedException('Trader not found');
        return {
          ...this.sanitize(trader, ['passwordHash']),
          role: UserRole.TRADER,
        };
      }
      default: {
        const admin = await this.prisma.adminUser.findUnique({ where: { id: user.id } });
        if (!admin) throw new UnauthorizedException('Admin not found');
        return {
          ...this.sanitize(admin, ['passwordHash']),
          role: UserRole.ADMIN,
        };
      }
    }
  }

  private sanitize(entity: Record<string, unknown>, removeKeys: string[]): Record<string, unknown> {
    const clone = { ...entity } as Record<string, unknown>;
    for (const key of removeKeys) delete clone[key];
    return clone;
  }
}

export type MerchantWithKeys = Prisma.MerchantGetPayload<{ include: { apiKeys: true } }>;
