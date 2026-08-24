import { ForbiddenException, Injectable } from '@nestjs/common';
import { BlacklistKind, Prisma } from '@prisma/client';
import { AppConfig } from '../common/config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';

export interface OrderRiskContext {
  merchantId: string;
  ip?: string;
  deviceId?: string;
  cardHash?: string;
}

@Injectable()
export class AntifraudService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: AppConfig,
  ) {}

  async assertOrderAllowed(ctx: OrderRiskContext): Promise<void> {
    const now = new Date();
    const blacklistWhere = (kind: BlacklistKind, value: string): Prisma.BlacklistEntryWhereInput => ({
      kind,
      value,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    });

    if (ctx.ip) {
      const blocked = await this.prisma.blacklistEntry.findFirst({
        where: blacklistWhere(BlacklistKind.IP, ctx.ip),
      });
      if (blocked) throw await this.reject('BLACKLIST_IP', ctx, { ip: ctx.ip, reason: blocked.reason });
    }
    if (ctx.cardHash) {
      const blocked = await this.prisma.blacklistEntry.findFirst({
        where: blacklistWhere(BlacklistKind.CARD_HASH, ctx.cardHash),
      });
      if (blocked) throw await this.reject('BLACKLIST_CARD', ctx, { cardHash: ctx.cardHash, reason: blocked.reason });
    }
    if (ctx.deviceId) {
      const blocked = await this.prisma.blacklistEntry.findFirst({
        where: blacklistWhere(BlacklistKind.DEVICE_ID, ctx.deviceId),
      });
      if (blocked)
        throw await this.reject('BLACKLIST_DEVICE', ctx, { deviceId: ctx.deviceId, reason: blocked.reason });
    }

    if (ctx.ip) {
      const windowStart = new Date(now.getTime() - this.cfg.afWindowSeconds * 1000);
      const count = await this.prisma.order.count({
        where: { payerIp: ctx.ip, createdAt: { gte: windowStart } },
      });
      if (count >= this.cfg.afMaxPerIp) {
        throw await this.reject('VELOCITY_IP', ctx, {
          ip: ctx.ip,
          ordersInWindow: count,
          windowSeconds: this.cfg.afWindowSeconds,
          limit: this.cfg.afMaxPerIp,
        });
      }
    }

    if (ctx.deviceId) {
      const windowStart = new Date(now.getTime() - this.cfg.afWindowSeconds * 1000);
      const count = await this.prisma.order.count({
        where: { payerDeviceId: ctx.deviceId, createdAt: { gte: windowStart } },
      });
      if (count >= this.cfg.afMaxPerDevice) {
        throw await this.reject('VELOCITY_DEVICE', ctx, {
          deviceId: ctx.deviceId,
          ordersInWindow: count,
          windowSeconds: this.cfg.afWindowSeconds,
          limit: this.cfg.afMaxPerDevice,
        });
      }
    }
  }

  private async reject(rule: string, ctx: OrderRiskContext, details: Record<string, unknown>): Promise<never> {
    await this.prisma.fraudEvent.create({
      data: {
        merchantId: ctx.merchantId,
        rule,
        severity: rule.startsWith('BLACKLIST') ? 'HIGH' : 'MEDIUM',
        details: details as Prisma.InputJsonValue,
      },
    });
    throw new ForbiddenException({
      code: rule,
      message: `Order rejected by antifraud rule ${rule}`,
      details,
    });
  }
}
