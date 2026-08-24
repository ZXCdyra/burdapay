import { Injectable, Logger } from '@nestjs/common';
import { PaymentMethod, Prisma, Trader } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface RoutingRequest {
  method: PaymentMethod;
  amount: Prisma.Decimal;
  type: 'DEPOSIT' | 'WITHDRAWAL';
  excludeTraderIds?: string[];
}

export class RoutingFailedError extends Error {
  constructor() {
    super('No suitable trader available for this order');
    this.name = 'RoutingFailedError';
  }
}

@Injectable()
export class SmartRoutingService {
  private readonly logger = new Logger(SmartRoutingService.name);

  constructor(private readonly prisma: PrismaService) {}

  async pickAndLock(
    tx: Prisma.TransactionClient,
    req: RoutingRequest,
  ): Promise<Trader> {
    const amount = new Prisma.Decimal(req.amount);

    const candidates = await tx.trader.findMany({
      where: {
        status: 'ACTIVE',
        isOnline: true,
        ...(req.method === 'CARD' ? { methodCard: true } : { methodSbp: true }),
        ...(req.excludeTraderIds?.length ? { id: { notIn: req.excludeTraderIds } } : {}),
        AND: [
          { minOrderAmount: { lte: amount } },
          { maxOrderAmount: { gte: amount } },
        ],
        ...(req.type === 'WITHDRAWAL' ? { balance: { gte: new Prisma.Decimal(0) } } : {}),
      },
      take: 25,
    });

    if (candidates.length === 0) throw new RoutingFailedError();

    const scored = candidates
      .map((t) => ({
        trader: t,
        score:
          this.successRate(t) * 0.6 +
          (1 - t.lockedOrders / Math.max(t.maxConcurrentOrders, 1)) * 0.25 +
          Math.random() * 0.15,
      }))
      .sort((a, b) => b.score - a.score);

    for (const { trader } of scored) {
      const locked = await this.tryLock(tx, trader.id);
      if (locked) {
        this.logger.log(`Order routed to trader ${trader.id} (${trader.displayName}), score=${scored.find((s) => s.trader.id === trader.id)?.score.toFixed(3)}`);
        return locked;
      }
    }

    throw new RoutingFailedError();
  }

  async unlock(tx: Prisma.TransactionClient, traderId: string): Promise<void> {
    await tx.trader.updateMany({
      where: { id: traderId, lockedOrders: { gt: 0 } },
      data: { lockedOrders: { decrement: 1 } },
    });
  }

  async bumpStats(tx: Prisma.TransactionClient, traderId: string, success: boolean): Promise<void> {
    await tx.trader.update({
      where: { id: traderId },
      data: success ? { successCount: { increment: 1 } } : { failCount: { increment: 1 } },
    });
  }

  private successRate(t: Trader): number {
    const total = t.successCount + t.failCount;
    if (total === 0) return 0.8;
    return (t.successCount + 1) / (total + 2);
  }

  private async tryLock(tx: Prisma.TransactionClient, traderId: string): Promise<Trader | null> {
    const updated = await tx.trader.updateMany({
      where: {
        id: traderId,
        status: 'ACTIVE',
        isOnline: true,
      },
      data: { lockedOrders: { increment: 1 } },
    });
    if (updated.count === 0) return null;

    const fresh = await tx.trader.findUniqueOrThrow({ where: { id: traderId } });
    if (fresh.lockedOrders > fresh.maxConcurrentOrders) {
      await tx.trader.updateMany({
        where: { id: traderId, lockedOrders: { gt: 0 } },
        data: { lockedOrders: { decrement: 1 } },
      });
      return null;
    }
    return fresh;
  }
}
