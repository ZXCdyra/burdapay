import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { LedgerKind, LedgerPartyType, Order, OrderStatus, OrderType, PaymentMethod, Prisma } from '@prisma/client';
import { AppConfig } from '../common/config/app-config.service';
import { CryptoUtil } from '../common/utils/crypto.util';
import { hashCard } from '../payment-methods/payment-methods.validators';
import { EventsService } from '../websocket/events.service';
import { CreateDepositDto, CreateOrderDto, CreateWithdrawalDto, RequestMeta } from './orders.dto';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queues/queue.service';
import { QUEUES } from '../queues/queues.constants';
import { RoutingFailedError, SmartRoutingService } from '../routing/smart-routing.service';
import { AntifraudService } from '../antifraud/antifraud.service';
import { WebhooksService, WebhookEvent } from '../webhooks/webhooks.service';

const MAX_REROUTES = 2;
const OPEN_STATUSES: OrderStatus[] = ['PENDING', 'ASSIGNED', 'DISPUTED'];

function todayStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

type Tx = Prisma.TransactionClient;

export interface SanitizedOrder {
  id: string;
  merchantId: string;
  traderId: string | null;
  traderCode: string | null;
  type: OrderType;
  method: PaymentMethod;
  status: OrderStatus;
  amount: string;
  currency: string;
  fee: string;
  feePlatform: string;
  merchantOrderId: string | null;
  description: string | null;
  metadata: unknown;
  paymentDetails: unknown;
  payoutRequisites: unknown;
  rerouteCount: number;
  expiresAt: Date;
  confirmedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  createdAt: Date;
}

@Injectable()
export class OrdersService implements OnModuleInit {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly routing: SmartRoutingService,
    private readonly antifraud: AntifraudService,
    private readonly queues: QueueService,
    private readonly events: EventsService,
    private readonly webhooks: WebhooksService,
    private readonly cfg: AppConfig,
  ) {}

  onModuleInit(): void {
    this.queues.registerProcessor(QUEUES.ORDER_EXPIRY, async (job) => {
      await this.handleExpiration(job.data.orderId);
    });
  }

  async createDeposit(
    merchant: { id: string; feePercent: Prisma.Decimal },
    dto: CreateDepositDto,
    meta: RequestMeta,
  ): Promise<{ order: SanitizedOrder; replayed: boolean }> {
    const existing = await this.prisma.order.findUnique({
      where: { merchantId_idempotencyKey: { merchantId: merchant.id, idempotencyKey: dto.idempotencyKey } },
    });
    if (existing) return { order: this.sanitize(existing), replayed: true };

    await this.antifraud.assertOrderAllowed({
      merchantId: merchant.id,
      ip: meta.ip,
      deviceId: meta.deviceId,
      cardHash: dto.payer?.cardNumber ? hashCard(dto.payer.cardNumber, this.cfg.cardPepper) : undefined,
    });

    const amount = new Prisma.Decimal(dto.amount).toDecimalPlaces(2);
    const expiresAt = new Date(Date.now() + this.cfg.orderTtlSeconds * 1000);
    const refCode = this.generateRefCode();

    let created: Order;
    try {
      created = await this.prisma.$transaction(
        async (tx: Tx) => {
          const trader = await this.routing.pickAndLock(tx, { method: dto.method, amount, type: 'DEPOSIT' });

          const requisite = await this.pickRequisite(tx, trader.id, dto.method, amount);
          if (!requisite) throw new RoutingFailedError();

          const feeMerchant = this.fee(amount, merchant.feePercent);
          const feeTrader = this.fee(amount, trader.feePercent);

          return tx.order.create({
            data: {
              merchantId: merchant.id,
              traderId: trader.id,
              requisiteId: requisite.id,
              type: 'DEPOSIT',
              method: dto.method,
              amount,
              currency: dto.currency,
              feeMerchant,
              feeTrader,
              feePlatform: feeMerchant.add(feeTrader),
              status: 'PENDING',
              merchantOrderId: dto.externalId ?? null,
              idempotencyKey: dto.idempotencyKey,
              description: dto.description ?? null,
              metadata: (dto.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
              paymentDetails: this.buildPaymentDetails(requisite, amount, refCode),
              payerIp: meta.ip ?? null,
              payerDeviceId: meta.deviceId ?? null,
              payerCardHash: dto.payer?.cardNumber ? hashCard(dto.payer.cardNumber, this.cfg.cardPepper) : null,
              expiresAt,
            },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (err) {
      if (err instanceof RoutingFailedError || err instanceof ServiceUnavailableException) {
        throw new ServiceUnavailableException({ code: 'NO_LIQUIDITY', message: 'No trader available for this order' });
      }
      throw err;
    }

    await this.finalizeCreated(created);
    return { order: this.sanitize(created), replayed: false };
  }

  async createWithdrawal(
    merchant: { id: string; balance: Prisma.Decimal },
    dto: CreateWithdrawalDto,
  ): Promise<{ order: SanitizedOrder; replayed: boolean }> {
    const existing = await this.prisma.order.findUnique({
      where: { merchantId_idempotencyKey: { merchantId: merchant.id, idempotencyKey: dto.idempotencyKey } },
    });
    if (existing) return { order: this.sanitize(existing), replayed: true };

    const amount = new Prisma.Decimal(dto.amount).toDecimalPlaces(2);
    const expiresAt = new Date(Date.now() + this.cfg.orderTtlSeconds * 1000);
    const payoutRequisites = this.buildPayoutRequisites(dto.requisites);

    let created: Order;
    try {
      created = await this.prisma.$transaction(
        async (tx: Tx) => {
          const freshMerchant = await tx.merchant.findUniqueOrThrow({ where: { id: merchant.id } });

          const trader = await this.routing.pickAndLock(tx, { method: dto.method, amount, type: 'WITHDRAWAL' });

          const feeMerchant = this.fee(amount, freshMerchant.feePercent);
          const feeTrader = this.fee(amount, trader.feePercent);
          const totalDebit = amount.add(feeMerchant);

          const debited = await tx.merchant.updateMany({
            where: { id: merchant.id, balance: { gte: totalDebit } },
            data: { balance: { decrement: totalDebit } },
          });
          if (debited.count === 0) {
            throw new BadRequestException({ code: 'INSUFFICIENT_FUNDS', message: 'Insufficient merchant balance' });
          }
          const balanceAfter = freshMerchant.balance.sub(totalDebit);

          const order = await tx.order.create({
            data: {
              merchantId: merchant.id,
              traderId: trader.id,
              type: 'WITHDRAWAL',
              method: dto.method,
              amount,
              currency: dto.currency,
              feeMerchant,
              feeTrader,
              feePlatform: feeMerchant.add(feeTrader),
              status: 'PENDING',
              merchantOrderId: dto.externalId ?? null,
              idempotencyKey: dto.idempotencyKey,
              description: dto.description ?? null,
              metadata: (dto.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
              payoutRequisites: payoutRequisites as Prisma.InputJsonValue,
              expiresAt,
            },
          });

          await this.ledger(tx, 'MERCHANT', merchant.id, order.id, 'ORDER_DEBIT', amount.neg(), balanceAfter, 'Withdrawal hold');
          await this.ledger(tx, 'PLATFORM', 'platform', order.id, 'FEE', feeMerchant, feeMerchant, 'Withdrawal merchant fee');

          return order;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (err) {
      if (err instanceof RoutingFailedError || err instanceof ServiceUnavailableException) {
        throw new ServiceUnavailableException({ code: 'NO_LIQUIDITY', message: 'No trader available for this order' });
      }
      throw err;
    }

    await this.finalizeCreated(created);
    return { order: this.sanitize(created), replayed: false };
  }

  async createOrder(
    merchant: { id: string; balance: Prisma.Decimal; feePercent: Prisma.Decimal },
    dto: CreateOrderDto,
    meta: RequestMeta,
  ): Promise<{ order: SanitizedOrder; replayed: boolean }> {
    if (dto.type === 'DEPOSIT') return this.createDeposit(merchant, dto, meta);
    return this.createWithdrawal(merchant, dto);
  }

  private async finalizeCreated(order: Order): Promise<void> {
    await this.logEvent(order.id, 'ORDER_CREATED', { status: order.status, traderId: order.traderId });
    await this.queues.scheduleOrderExpiry(order.id, order.expiresAt.getTime() - Date.now());

    const sanitized = this.sanitize(order);
    // Fetch traderCode for response
    if (order.traderId) {
      const trader = await this.prisma.trader.findUnique({ where: { id: order.traderId }, select: { traderCode: true } });
      sanitized.traderCode = trader?.traderCode ?? null;
    }

    this.events.emitToUser('MERCHANT', order.merchantId, 'order.updated', sanitized);
    this.events.emitToAdmins('order.updated', sanitized);
    if (order.traderId) {
      this.events.emitToUser('TRADER', order.traderId, 'order.new', this.forTrader(order));
    }
    // For deposits: include trader's payment details in webhook so merchant knows where to send
    const webhookPayload = this.webhooks.buildOrderPayload('order.created', order);
    if (order.type === 'DEPOSIT' && order.paymentDetails) {
      (webhookPayload as any).traderRequisites = this.decryptPaymentDetails(order.paymentDetails);
      (webhookPayload as any).traderId = order.traderId;
    }
    await this.webhooks.dispatch(
      'order.created',
      webhookPayload,
      order.merchantId,
    );
  }

  async getForMerchant(merchantId: string, orderId: string): Promise<SanitizedOrder> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, merchantId },
      include: { events: { orderBy: { createdAt: 'desc' }, take: 20 }, trader: { select: { traderCode: true, displayName: true } } },
    });
    if (!order) throw new NotFoundException('Order not found');
    const sanitized = this.sanitize(order);
    sanitized.traderCode = order.trader?.traderCode ?? null;
    return sanitized;
  }

  async listForTrader(traderId: string): Promise<SanitizedOrder[]> {
    const orders = await this.prisma.order.findMany({
      where: { traderId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return orders.map((o) => this.sanitize(o));
  }

  async acceptByTrader(traderId: string, orderId: string): Promise<SanitizedOrder> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.traderId !== traderId) throw new NotFoundException('Order not found');
    const acceptWindowMs = 10 * 60 * 1000;
    if (Date.now() - order.createdAt.getTime() > acceptWindowMs) {
      throw new ConflictException('Acceptance window expired');
    }
    const updated = await this.transition(orderId, ['PENDING'], 'ASSIGNED', {}, { traderId });
    if (!updated) throw new ConflictException('Order cannot be accepted in current state');

    await this.logEvent(orderId, 'ORDER_ACCEPTED', { traderId });
    this.events.emitToUser('MERCHANT', updated.merchantId, 'order.updated', this.sanitize(updated));
    await this.webhooks.dispatch(
      'order.assigned',
      this.webhooks.buildOrderPayload('order.assigned', updated),
      updated.merchantId,
    );
    return this.sanitize(updated);
  }

  async declineByTrader(traderId: string, orderId: string, reason?: string): Promise<{ rerouted: boolean }> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.traderId !== traderId) throw new NotFoundException('Order not found');
    if (order.status !== 'PENDING') throw new ConflictException('Only PENDING orders can be declined');

    const result = await this.prisma.$transaction(
      async (tx: Tx) => {
        await this.routing.unlock(tx, traderId);
        await this.routing.bumpStats(tx, traderId, false);

        if (order.rerouteCount < MAX_REROUTES) {
          try {
            const newTrader = await this.routing.pickAndLock(tx, {
              method: order.method,
              amount: order.amount,
              type: order.type,
              excludeTraderIds: [traderId],
            });
            const updateData: Prisma.OrderUpdateInput = {
              trader: { connect: { id: newTrader.id } },
              rerouteCount: { increment: 1 },
              status: 'PENDING',
              feeTrader: this.fee(order.amount, newTrader.feePercent),
              feePlatform: order.feeMerchant.add(this.fee(order.amount, newTrader.feePercent)),
            };
            if (order.type === 'DEPOSIT') {
              const requisite = await this.pickRequisite(tx, newTrader.id, order.method, order.amount);
              if (requisite) {
                updateData.requisiteId = requisite.id;
                updateData.paymentDetails = this.buildPaymentDetails(
                  requisite,
                  order.amount,
                  this.refFromOrderId(order.id),
                );
              }
            }
            const updated = await tx.order.update({ where: { id: order.id }, data: updateData });
            return { order: updated, rerouted: true };
          } catch (err) {
            if (!(err instanceof RoutingFailedError)) throw err;
          }
        }

        const cancelled = await tx.order.updateMany({
          where: { id: order.id, status: 'PENDING' },
          data: {
            status: 'CANCELLED',
            cancelledAt: new Date(),
            cancelReason: reason ?? 'Declined by all traders',
          },
        });
        if (cancelled.count === 0) throw new ConflictException('Order state changed concurrently');
        const finalOrder = await tx.order.findUniqueOrThrow({ where: { id: order.id } });
        await this.applyTerminalRefunds(tx, finalOrder);
        return { order: finalOrder, rerouted: false };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    await this.logEvent(order.id, result.rerouted ? 'ORDER_REROUTED' : 'ORDER_CANCELLED', {
      declinedBy: traderId,
      reason,
    });
    this.events.emitToUser('MERCHANT', order.merchantId, 'order.updated', this.sanitize(result.order));
    this.events.emitToAdmins('order.updated', this.sanitize(result.order));
    if (result.rerouted && result.order.traderId) {
      this.events.emitToUser('TRADER', result.order.traderId, 'order.new', this.forTrader(result.order));
    }
    const event: WebhookEvent = result.rerouted ? 'order.assigned' : 'order.cancelled';
    await this.webhooks.dispatch(event, this.webhooks.buildOrderPayload(event, result.order), order.merchantId);
    return { rerouted: result.rerouted };
  }

  async confirmDepositByTrader(
    traderId: string,
    orderId: string,
    dto: { payerName?: string; note?: string },
  ): Promise<SanitizedOrder> {
    const completed = await this.prisma.$transaction(
      async (tx: Tx) => {
        const order = await tx.order.findUnique({ where: { id: orderId } });
        if (!order || order.traderId !== traderId) throw new NotFoundException('Order not found');
        if (order.type !== 'DEPOSIT') throw new BadRequestException('Not a deposit order');

        const res = await tx.order.updateMany({
          where: { id: orderId, status: 'ASSIGNED', traderId },
          data: { status: 'COMPLETED', confirmedAt: new Date(), completedAt: new Date() },
        });
        if (res.count === 0) throw new ConflictException('Order is not in ASSIGNED state');

        await this.completeDepositSideEffects(tx, order);
        return tx.order.findUniqueOrThrow({ where: { id: orderId } });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    await this.logEvent(orderId, 'DEPOSIT_CONFIRMED', { traderId, ...dto });
    this.events.emitToUser('MERCHANT', completed.merchantId, 'order.updated', this.sanitize(completed));
    this.events.emitToAdmins('order.completed', this.sanitize(completed));
    await this.webhooks.dispatch(
      'order.completed',
      this.webhooks.buildOrderPayload('order.completed', completed),
      completed.merchantId,
    );
    return this.sanitize(completed);
  }

  async markWithdrawalPaidByTrader(traderId: string, orderId: string, note?: string): Promise<SanitizedOrder> {
    const completed = await this.prisma.$transaction(
      async (tx: Tx) => {
        const order = await tx.order.findUnique({ where: { id: orderId } });
        if (!order || order.traderId !== traderId) throw new NotFoundException('Order not found');
        if (order.type !== 'WITHDRAWAL') throw new BadRequestException('Not a withdrawal order');

        const res = await tx.order.updateMany({
          where: { id: orderId, status: 'ASSIGNED', traderId },
          data: { status: 'COMPLETED', completedAt: new Date() },
        });
        if (res.count === 0) throw new ConflictException('Order is not in ASSIGNED state');

        const net = order.amount.sub(order.feeTrader);
        const trader = await tx.trader.findUniqueOrThrow({ where: { id: traderId } });
        await tx.trader.update({
          where: { id: traderId },
          data: { balance: { increment: net }, successCount: { increment: 1 } },
        });
        await this.ledger(
          tx,
          'TRADER',
          traderId,
          orderId,
          'ORDER_CREDIT',
          net,
          trader.balance.add(net),
          'Withdrawal paid out',
        );
        await this.routing.unlock(tx, traderId);

        return tx.order.findUniqueOrThrow({ where: { id: orderId } });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    await this.logEvent(orderId, 'WITHDRAWAL_PAID', { traderId, note });
    this.events.emitToUser('MERCHANT', completed.merchantId, 'order.updated', this.sanitize(completed));
    this.events.emitToAdmins('order.completed', this.sanitize(completed));
    await this.webhooks.dispatch(
      'order.completed',
      this.webhooks.buildOrderPayload('order.completed', completed),
      completed.merchantId,
    );
    return this.sanitize(completed);
  }

  async cancelByMerchant(merchantId: string, orderId: string, reason?: string): Promise<SanitizedOrder> {
    const cancelled = await this.prisma.$transaction(
      async (tx: Tx) => {
        const res = await tx.order.updateMany({
          where: { id: orderId, merchantId, status: 'PENDING' },
          data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason ?? 'Cancelled by merchant' },
        });
        if (res.count === 0) throw new ConflictException('Only PENDING orders can be cancelled');
        const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
        if (order.traderId) await this.routing.unlock(tx, order.traderId);
        await this.applyTerminalRefunds(tx, order);
        return order;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    await this.logEvent(orderId, 'ORDER_CANCELLED', { by: 'merchant', reason });
    this.events.emitToUser('MERCHANT', merchantId, 'order.updated', this.sanitize(cancelled));
    this.events.emitToAdmins('order.cancelled', this.sanitize(cancelled));
    await this.webhooks.dispatch(
      'order.cancelled',
      this.webhooks.buildOrderPayload('order.cancelled', cancelled),
      merchantId,
    );
    return this.sanitize(cancelled);
  }

  async openDisputeByTrader(traderId: string, orderId: string, reason?: string): Promise<SanitizedOrder> {
    const disputed = await this.prisma.$transaction(
      async (tx: Tx) => {
        const order = await tx.order.findUnique({ where: { id: orderId } });
        if (!order || order.traderId !== traderId) throw new NotFoundException('Order not found');
        if (order.type !== 'DEPOSIT') throw new BadRequestException('Disputes are only supported on deposit orders');

        const res = await tx.order.updateMany({
          where: { id: orderId, status: 'ASSIGNED', traderId },
          data: { status: 'DISPUTED' },
        });
        if (res.count === 0) throw new ConflictException('Only ASSIGNED orders can be disputed');

        return tx.order.findUniqueOrThrow({ where: { id: orderId } });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    await this.logEvent(orderId, 'ORDER_DISPUTED', { traderId, reason });
    this.events.emitToUser('MERCHANT', disputed.merchantId, 'order.updated', this.sanitize(disputed));
    this.events.emitToAdmins('order.disputed', this.sanitize(disputed));
    this.events.emitToUser('TRADER', traderId, 'order.updated', this.forTrader(disputed));
    await this.webhooks.dispatch(
      'order.disputed',
      this.webhooks.buildOrderPayload('order.disputed', disputed),
      disputed.merchantId,
    );
    return this.sanitize(disputed);
  }

  async adminResolve(
    orderId: string,
    action: 'complete' | 'cancel',
    actor: string,
    reason?: string,
  ): Promise<SanitizedOrder> {
    const resolved = await this.prisma.$transaction(
      async (tx: Tx) => {
        const order = await tx.order.findUnique({ where: { id: orderId } });
        if (!order) throw new NotFoundException('Order not found');
        if (!OPEN_STATUSES.includes(order.status)) {
          throw new ConflictException(`Order already terminal (${order.status})`);
        }

        if (action === 'complete') {
          const res = await tx.order.updateMany({
            where: { id: orderId, status: { in: OPEN_STATUSES } },
            data: { status: 'COMPLETED', completedAt: new Date() },
          });
          if (res.count === 0) throw new ConflictException('State race on complete');
          if (order.type === 'DEPOSIT') {
            await this.completeDepositSideEffects(tx, order);
          } else if (order.traderId) {
            const net = order.amount.sub(order.feeTrader);
            const trader = await tx.trader.findUniqueOrThrow({ where: { id: order.traderId } });
            await tx.trader.update({
              where: { id: order.traderId },
              data: { balance: { increment: net }, successCount: { increment: 1 } },
            });
            await this.ledger(
              tx,
              'TRADER',
              order.traderId,
              orderId,
              'ORDER_CREDIT',
              net,
              trader.balance.add(net),
              'Admin force-complete',
            );
            await this.routing.unlock(tx, order.traderId);
          }
        } else {
          const res = await tx.order.updateMany({
            where: { id: orderId, status: { in: OPEN_STATUSES } },
            data: {
              status: 'CANCELLED',
              cancelledAt: new Date(),
              cancelReason: reason ?? `Force-cancelled by admin ${actor}`,
            },
          });
          if (res.count === 0) throw new ConflictException('State race on cancel');
          if (order.traderId) await this.routing.unlock(tx, order.traderId);
          await this.applyTerminalRefunds(tx, order);
        }

        return tx.order.findUniqueOrThrow({ where: { id: orderId } });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    await this.logEvent(orderId, `ADMIN_${action.toUpperCase()}`, { actor, reason });
    this.events.emitToUser('MERCHANT', resolved.merchantId, 'order.updated', this.sanitize(resolved));
    this.events.emitToAdmins('order.updated', this.sanitize(resolved));
    const event: WebhookEvent = action === 'complete' ? 'order.completed' : 'order.cancelled';
    await this.webhooks.dispatch(event, this.webhooks.buildOrderPayload(event, resolved), resolved.merchantId);
    return this.sanitize(resolved);
  }

  async adminArchive(orderId: string, actor: string): Promise<SanitizedOrder> {
    const archived = await this.prisma.$transaction(
      async (tx: Tx) => {
        const order = await tx.order.findUnique({ where: { id: orderId } });
        if (!order) throw new NotFoundException('Order not found');
        if (!['PENDING', 'ASSIGNED'].includes(order.status)) {
          throw new ConflictException(`Order already terminal (${order.status})`);
        }

        const res = await tx.order.updateMany({
          where: { id: orderId, status: { in: ['PENDING', 'ASSIGNED'] } },
          data: { status: 'EXPIRED' },
        });
        if (res.count === 0) throw new ConflictException('State race on archive');
        const fresh = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
        if (fresh.traderId) await this.routing.unlock(tx, fresh.traderId);
        await this.applyTerminalRefunds(tx, fresh);
        return fresh;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    await this.logEvent(orderId, 'ADMIN_ARCHIVE', { actor });
    this.events.emitToUser('MERCHANT', archived.merchantId, 'order.updated', this.sanitize(archived));
    this.events.emitToAdmins('order.updated', this.sanitize(archived));
    await this.webhooks.dispatch('order.expired', this.webhooks.buildOrderPayload('order.expired', archived), archived.merchantId);
    return this.sanitize(archived);
  }

  async handleExpiration(orderId: string): Promise<void> {
    const expired = await this.prisma.$transaction(
      async (tx: Tx) => {
        const order = await tx.order.findUnique({ where: { id: orderId } });
        if (!order || !['PENDING', 'ASSIGNED'].includes(order.status)) return null;

        const res = await tx.order.updateMany({
          where: { id: orderId, status: { in: ['PENDING', 'ASSIGNED'] } },
          data: { status: 'EXPIRED' },
        });
        if (res.count === 0) return null;

        const fresh = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
        if (fresh.traderId) await this.routing.unlock(tx, fresh.traderId);
        await this.applyTerminalRefunds(tx, fresh);
        return fresh;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    if (!expired) return;
    this.logger.warn(`Order ${orderId} expired`);
    await this.logEvent(orderId, 'ORDER_EXPIRED', {});
    this.events.emitToUser('MERCHANT', expired.merchantId, 'order.updated', this.sanitize(expired));
    this.events.emitToAdmins('order.expired', this.sanitize(expired));
    if (expired.traderId) this.events.emitToUser('TRADER', expired.traderId, 'order.expired', { orderId });
    await this.webhooks.dispatch(
      'order.expired',
      this.webhooks.buildOrderPayload('order.expired', expired),
      expired.merchantId,
    );
  }

  async getForTrader(traderId: string, orderId: string): Promise<Record<string, unknown>> {
    const order = await this.prisma.order.findFirst({ where: { id: orderId, traderId } });
    if (!order) throw new NotFoundException('Order not found');
    const base = this.sanitize(order);
    if (order.type === 'WITHDRAWAL' && order.status === 'ASSIGNED') {
      return { ...base, payoutRequisites: this.decryptPayoutRequisites(order.payoutRequisites) };
    }
    return { ...base };
  }

  private async completeDepositSideEffects(tx: Tx, order: Order): Promise<void> {
    const netMerchant = order.amount.sub(order.feeMerchant);
    const netTrader = order.amount.sub(order.feeTrader);

    const merchant = await tx.merchant.findUniqueOrThrow({ where: { id: order.merchantId } });
    await tx.merchant.update({
      where: { id: order.merchantId },
      data: { balance: { increment: netMerchant } },
    });
    await this.ledger(
      tx,
      'MERCHANT',
      order.merchantId,
      order.id,
      'ORDER_CREDIT',
      netMerchant,
      merchant.balance.add(netMerchant),
      'Deposit credited',
    );

    if (order.traderId) {
      const trader = await tx.trader.findUniqueOrThrow({ where: { id: order.traderId } });
      await tx.trader.update({
        where: { id: order.traderId },
        data: { balance: { decrement: netTrader }, successCount: { increment: 1 } },
      });
      await this.ledger(
        tx,
        'TRADER',
        order.traderId,
        order.id,
        'ORDER_DEBIT',
        netTrader.neg(),
        trader.balance.sub(netTrader),
        'Deposit settled to platform',
      );
      await this.routing.unlock(tx, order.traderId);
    }

    await this.ledger(
      tx,
      'PLATFORM',
      'platform',
      order.id,
      'FEE',
      order.feePlatform,
      order.feePlatform,
      'Platform fees',
    );

    await this.touchRequisiteAfterCompletion(tx, order);
  }

  private async touchRequisiteAfterCompletion(tx: Tx, order: Order): Promise<void> {
    if (!order.requisiteId) return;
    const requisite = await tx.traderRequisite.findUnique({ where: { id: order.requisiteId } });
    if (!requisite) return;

    const now = new Date();
    const sameDay = Boolean(requisite.usageDay && requisite.usageDay >= todayStartUtc(now));
    await tx.traderRequisite.update({
      where: { id: requisite.id },
      data: {
        usedToday: sameDay ? { increment: order.amount } : order.amount,
        usageDay: sameDay ? requisite.usageDay : now,
        cooldownUntil: new Date(now.getTime() + requisite.cooldownSec * 1000),
      },
    });
  }

  private async pickRequisite(
    tx: Tx,
    traderId: string,
    method: PaymentMethod,
    amount: Prisma.Decimal,
  ) {
    const now = new Date();
    const dayStart = todayStartUtc(now);
    const candidates = await tx.traderRequisite.findMany({
      where: {
        traderId,
        method,
        isActive: true,
        OR: [{ cooldownUntil: null }, { cooldownUntil: { lte: now } }],
      },
      orderBy: { createdAt: 'asc' },
    });

    return (
      candidates.find((r) => {
        if (r.cooldownUntil && r.cooldownUntil > now) return false;
        if (r.dailyLimit === null) return true;
        const used = r.usageDay && r.usageDay >= dayStart ? r.usedToday : new Prisma.Decimal(0);
        return used.plus(amount).lte(r.dailyLimit);
      }) ?? null
    );
  }

  private async applyTerminalRefunds(tx: Tx, order: Order): Promise<void> {
    if (order.type !== 'WITHDRAWAL') return;
    const totalDebit = order.amount.add(order.feeMerchant);
    const merchant = await tx.merchant.findUniqueOrThrow({ where: { id: order.merchantId } });
    await tx.merchant.update({
      where: { id: order.merchantId },
      data: { balance: { increment: totalDebit } },
    });
    await this.ledger(
      tx,
      'MERCHANT',
      order.merchantId,
      order.id,
      'REFUND',
      totalDebit,
      merchant.balance.add(totalDebit),
      'Withdrawal refunded',
    );
  }

  private async ledger(
    tx: Tx,
    partyType: LedgerPartyType,
    partyId: string,
    orderId: string | null,
    kind: LedgerKind,
    amount: Prisma.Decimal,
    balanceAfter: Prisma.Decimal,
    memo?: string,
  ): Promise<void> {
    await tx.ledgerEntry.create({ data: { partyType, partyId, orderId, kind, amount, balanceAfter, memo } });
  }

  private async transition(
    orderId: string,
    from: OrderStatus[],
    to: OrderStatus,
    extraData: Prisma.OrderUpdateManyMutationInput = {},
    guard?: { traderId?: string },
  ): Promise<Order | null> {
    const res = await this.prisma.order.updateMany({
      where: {
        id: orderId,
        status: { in: from },
        ...(guard?.traderId ? { traderId: guard.traderId } : {}),
      },
      data: { status: to, ...extraData },
    });
    if (res.count === 0) return null;
    return this.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  }

  private fee(amount: Prisma.Decimal, percent: Prisma.Decimal): Prisma.Decimal {
    return amount.times(percent).div(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  }

  private generateRefCode(): string {
    return `PF-${CryptoUtil.randomHex(5).toUpperCase()}`;
  }

  private refFromOrderId(orderId: string): string {
    return `PF-${orderId.slice(-8).toUpperCase()}`;
  }

  private buildPaymentDetails(
    requisite: {
      method: PaymentMethod;
      bankName: string;
      receiverName: string;
      cardNumberEncrypted: string | null;
      cardLast4: string | null;
      sbpPhone: string | null;
    },
    amount: Prisma.Decimal,
    refCode: string,
  ): Prisma.InputJsonValue {
    if (requisite.method === 'CARD') {
      // cardNumberEncrypted уже AES-256-GCM зашифрован при создании реквизита
      return {
        method: 'CARD',
        bank: requisite.bankName,
        receiver: requisite.receiverName,
        cardNumberEncrypted: requisite.cardNumberEncrypted ?? null,
        cardLast4: requisite.cardLast4,
        amount: amount.toFixed(2),
        comment: refCode,
      } as Prisma.InputJsonValue;
    }
    return {
      method: 'SBP',
      bank: requisite.bankName,
      receiver: requisite.receiverName,
      phone: requisite.sbpPhone,
      amount: amount.toFixed(2),
      comment: refCode,
    } as Prisma.InputJsonValue;
  }

  private buildPayoutRequisites(
    req:
      | { method: 'CARD'; cardNumber: string; receiverName: string }
      | { method: 'SBP'; phone: string; bankName: string; receiverName: string },
  ): Record<string, unknown> {
    if (req.method === 'CARD') {
      const digits = req.cardNumber.replace(/\D/g, '');
      return {
        method: 'CARD',
        receiverName: req.receiverName,
        cardNumberEncrypted: CryptoUtil.encrypt(digits, this.cfg.encryptionKey),
        cardMasked: `**** **** **** ${digits.slice(-4)}`,
      };
    }
    return {
      method: 'SBP',
      receiverName: req.receiverName,
      sbpPhone: req.phone,
      bankName: req.bankName,
    };
  }

  private decryptPayoutRequisites(json: Prisma.JsonValue | null): Record<string, unknown> | null {
    if (!json || typeof json !== 'object') return null;
    const clone = { ...(json as Record<string, unknown>) };
    if (typeof clone['cardNumberEncrypted'] === 'string') {
      try {
        clone['cardNumber'] = CryptoUtil.decrypt(clone['cardNumberEncrypted'] as string, this.cfg.encryptionKey);
      } catch {
        clone['cardNumber'] = null;
      }
      delete clone['cardNumberEncrypted'];
    }
    return clone;
  }

  /**
   * Decrypts paymentDetails for DEPOSIT orders — returns trader's card/phone
   * so the merchant knows where to send money.
   * Handles both new (encrypted) and old (plaintext) DB formats.
   */
  private decryptPaymentDetails(json: Prisma.JsonValue | null): Record<string, unknown> | null {
    if (!json || typeof json !== 'object') return null;
    const data = json as Record<string, unknown>;
    // SBP — phone stored in plain text
    if (data['method'] === 'SBP') return data;
    // CARD — handle both encrypted and plaintext formats
    if (data['cardNumberEncrypted'] && typeof data['cardNumberEncrypted'] === 'string') {
      // New format: card is encrypted
      try {
        (data as any)['cardNumber'] = CryptoUtil.decrypt(data['cardNumberEncrypted'] as string, this.cfg.encryptionKey);
      } catch {
        (data as any)['cardNumber'] = null;
      }
      delete (data as any)['cardNumberEncrypted'];
    }
    // Old format: cardNumber already in plaintext — return as-is
    return data;
  }

  private async logEvent(orderId: string, type: string, payload: Record<string, unknown>): Promise<void> {
    await this.prisma.orderEvent
      .create({ data: { orderId, type, payload: payload as Prisma.InputJsonValue } })
      .catch(() => undefined);
  }

  sanitize(order: Order): SanitizedOrder {
    return {
      id: order.id,
      merchantId: order.merchantId,
      traderId: order.traderId,
      traderCode: null, // will be set after trader join
      type: order.type,
      method: order.method,
      status: order.status,
      amount: order.amount.toFixed(2),
      currency: order.currency,
      fee: order.feeMerchant.toFixed(2),
      feePlatform: order.feePlatform.toFixed(2),
      merchantOrderId: order.merchantOrderId,
      description: order.description,
      metadata: order.metadata ?? null,
      paymentDetails: this.decryptPaymentDetails(order.paymentDetails),
      payoutRequisites:
        order.type === 'WITHDRAWAL' && order.status === 'ASSIGNED'
          ? this.decryptPayoutRequisites(order.payoutRequisites)
          : null,
      rerouteCount: order.rerouteCount,
      expiresAt: order.expiresAt,
      confirmedAt: order.confirmedAt,
      completedAt: order.completedAt,
      cancelledAt: order.cancelledAt,
      cancelReason: order.cancelReason,
      createdAt: order.createdAt,
    };
  }

  forTrader(order: Order): Record<string, unknown> {
    return {
      orderId: order.id,
      type: order.type,
      method: order.method,
      amount: order.amount.toFixed(2),
      currency: order.currency,
      fee: order.feeTrader.toFixed(2),
      status: order.status,
      expiresAt: order.expiresAt,
    };
  }
}
