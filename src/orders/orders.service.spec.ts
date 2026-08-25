import { BadRequestException, ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { OrdersService } from './orders.service';
import { RoutingFailedError } from '../routing/smart-routing.service';
import { AppConfig } from '../common/config/app-config.service';

const D = (v: number | string) => new Prisma.Decimal(v);
const NOW = new Date('2026-01-01T00:00:00Z');

type Mocked<T> = Record<keyof T, jest.Mock>;

function makeOrder(overrides: Record<string, unknown> = {}): Prisma.OrderGetPayload<{ include: {} }> {
  return {
    id: 'ord-1',
    merchantId: 'm-1',
    traderId: 't-1',
    requisiteId: 'req-1',
    type: 'DEPOSIT',
    method: 'CARD',
    amount: D('1000'),
    currency: 'RUB',
    feeMerchant: D('30'),
    feeTrader: D('25'),
    feePlatform: D('55'),
    status: 'ASSIGNED',
    merchantOrderId: 'casino-1',
    idempotencyKey: 'idem-key-1',
    description: null,
    metadata: null,
    paymentDetails: { method: 'CARD', cardMasked: '**** 1234' },
    payoutRequisites: null,
    payerIp: null,
    payerDeviceId: null,
    payerCardHash: null,
    rerouteCount: 0,
    expiresAt: new Date(NOW.getTime() + 900_000),
    confirmedAt: null,
    completedAt: null,
    cancelledAt: null,
    cancelReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...(overrides as object),
  } as never;
}

const merchant = () => ({ id: 'm-1', name: 'Casino', feePercent: D('3'), balance: D('500') });
const trader = (overrides: Record<string, unknown> = {}) => ({
  id: 't-1',
  displayName: 'Trader One',
  feePercent: D('2.5'),
  balance: D('200'),
  maxConcurrentOrders: 3,
  lockedOrders: 0,
  successCount: 0,
  failCount: 0,
  status: 'ACTIVE',
  isOnline: true,
  ...overrides,
});
const requisite = (overrides: Record<string, unknown> = {}) => ({
  id: 'req-1',
  traderId: 't-1',
  method: 'CARD' as const,
  bankName: 'T-Bank',
  receiverName: 'IVAN IVANOV',
  cardNumberEncrypted: null,
  cardLast4: '1234',
  sbpPhone: null,
  isActive: true,
  dailyLimit: null,
  usedToday: D('0'),
  usageDay: null,
  cooldownSec: 600,
  cooldownUntil: null,
  createdAt: NOW,
  ...overrides,
});

describe('OrdersService', () => {
  let service: OrdersService;
  let db: {
    order: Mocked<Record<string, never>> & Record<string, jest.Mock>;
    orderEvent: Record<string, jest.Mock>;
    merchant: Record<string, jest.Mock>;
    trader: Record<string, jest.Mock>;
    traderRequisite: Record<string, jest.Mock>;
    ledgerEntry: Record<string, jest.Mock>;
  };
  let prismaRoot: Record<string, unknown>;
  let routing: { pickAndLock: jest.Mock; unlock: jest.Mock; bumpStats: jest.Mock };
  let antifraud: { assertOrderAllowed: jest.Mock };
  let queues: { registerProcessor: jest.Mock; scheduleOrderExpiry: jest.Mock; enqueueWebhook: jest.Mock };
  let events: { emitToUser: jest.Mock; emitToAdmins: jest.Mock };
  let webhooks: { dispatch: jest.Mock; buildOrderPayload: jest.Mock };

  const cfgMock = {
    orderTtlSeconds: 900,
    cardPepper: 'test-pepper',
    encryptionKey: 'a'.repeat(64),
  } as unknown as AppConfig;

  const depositDto = {
    type: 'DEPOSIT' as const,
    method: 'CARD' as const,
    amount: 1000,
    currency: 'RUB',
    idempotencyKey: 'idem-key-1',
    externalId: 'casino-1',
  };

  const meta = { ip: '127.0.0.1' };

  const ledgerCalls = () => db.ledgerEntry.create.mock.calls.map((c) => c[0].data);

  beforeEach(() => {
    db = {
      order: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      orderEvent: { create: jest.fn().mockResolvedValue({}) },
      merchant: {
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      trader: {
        findUniqueOrThrow: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      traderRequisite: {
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([requisite()]),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      ledgerEntry: { create: jest.fn().mockResolvedValue({}) },
    };

    prismaRoot = { ...db, $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(db)) };

    routing = {
      pickAndLock: jest.fn().mockResolvedValue(trader()),
      unlock: jest.fn().mockResolvedValue(undefined),
      bumpStats: jest.fn().mockResolvedValue(undefined),
    };
    antifraud = { assertOrderAllowed: jest.fn().mockResolvedValue(undefined) };
    queues = { registerProcessor: jest.fn(), scheduleOrderExpiry: jest.fn(), enqueueWebhook: jest.fn() };
    events = { emitToUser: jest.fn(), emitToAdmins: jest.fn() };
    webhooks = {
      dispatch: jest.fn().mockResolvedValue(undefined),
      buildOrderPayload: jest.fn((event: string) => ({ event })),
    };

    service = new OrdersService(
      prismaRoot as never,
      routing as never,
      antifraud as never,
      queues as never,
      events as never,
      webhooks as never,
      cfgMock,
    );
  });

  describe('createDeposit', () => {
    it('создаёт PENDING ордер с реквизитами, комиссиями и планированием истечения', async () => {
      const created = makeOrder({ status: 'PENDING' });
      db.order.findUnique.mockResolvedValue(null);
      db.traderRequisite.findFirst.mockResolvedValue(requisite());
      db.order.create.mockResolvedValue(created);

      const { order, replayed } = await service.createDeposit(merchant(), depositDto, meta);

      expect(replayed).toBe(false);
      expect(order.status).toBe('PENDING');
      expect(routing.pickAndLock).toHaveBeenCalledWith(
        db,
        expect.objectContaining({ method: 'CARD', type: 'DEPOSIT' }),
      );
      const data = db.order.create.mock.calls[0][0].data;
      expect(data.amount.toFixed(2)).toBe('1000.00');
      expect(data.feeMerchant.toFixed(2)).toBe('30.00');
      expect(data.feeTrader.toFixed(2)).toBe('25.00');
      expect(data.feePlatform.toFixed(2)).toBe('55.00');
      expect(data.paymentDetails.cardMasked).toBe('**** **** **** 1234');
      expect(String(data.paymentDetails.comment)).toMatch(/^PF-[0-9A-F]{10}$/);
      expect(queues.scheduleOrderExpiry).toHaveBeenCalledWith('ord-1', expect.any(Number));
      expect(webhooks.dispatch).toHaveBeenCalledWith('order.created', expect.anything(), 'm-1');
    });

    it('возвращает существующий ордер при повторе idempotencyKey', async () => {
      const existing = makeOrder({ status: 'PENDING' });
      db.order.findUnique.mockResolvedValue(existing);

      const { replayed } = await service.createDeposit(merchant(), depositDto, meta);

      expect(replayed).toBe(true);
      expect(prismaRoot.$transaction).not.toHaveBeenCalled();
      expect(antifraud.assertOrderAllowed).not.toHaveBeenCalled();
    });

    it('NO_LIQUIDITY когда нет доступного трейдера', async () => {
      db.order.findUnique.mockResolvedValue(null);
      routing.pickAndLock.mockRejectedValue(new RoutingFailedError());

      const err = await service
        .createDeposit(merchant(), depositDto, meta)
        .catch((e) => e as ServiceUnavailableException);

      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect(
        ((err as ServiceUnavailableException).getResponse() as { code: string }).code,
      ).toBe('NO_LIQUIDITY');
      expect(db.order.create).not.toHaveBeenCalled();
    });

    it('пропускает реквизит в кулдауне и берёт следующий свободный', async () => {
      db.order.findUnique.mockResolvedValue(null);
      db.traderRequisite.findMany.mockResolvedValue([
        requisite({ id: 'req-busy', cooldownUntil: new Date(Date.now() + 300_000) }),
        requisite({ id: 'req-2' }),
      ]);
      db.order.create.mockResolvedValue(makeOrder({ status: 'PENDING' }));

      const { order } = await service.createDeposit(merchant(), depositDto, meta);

      expect(order.status).toBe('PENDING');
      expect(db.order.create.mock.calls[0][0].data.requisiteId).toBe('req-2');
    });

    it('пропускает реквизит с исчерпанным дневным лимитом', async () => {
      db.order.findUnique.mockResolvedValue(null);
      db.traderRequisite.findMany.mockResolvedValue([
        requisite({
          id: 'req-limited',
          dailyLimit: D('1500'),
          usedToday: D('1000'),
          usageDay: new Date(Date.now() - 3_600_000),
        }),
        requisite({ id: 'req-2' }),
      ]);
      db.order.create.mockResolvedValue(makeOrder({ status: 'PENDING' }));

      await service.createDeposit(merchant(), depositDto, meta);

      expect(db.order.create.mock.calls[0][0].data.requisiteId).toBe('req-2');
    });

    it('учитывает использованный лимит только за сегодня (сброс на новый день)', async () => {
      db.order.findUnique.mockResolvedValue(null);
      db.traderRequisite.findMany.mockResolvedValue([
        requisite({
          dailyLimit: D('1000'),
          usedToday: D('999'),
          usageDay: new Date(Date.UTC(2020, 0, 1)),
        }),
      ]);
      db.order.create.mockResolvedValue(makeOrder({ status: 'PENDING' }));

      await service.createDeposit(merchant(), depositDto, meta);

      expect(db.order.create.mock.calls[0][0].data.requisiteId).toBe('req-1');
    });

    it('NO_LIQUIDITY если у трейдера нет реквизитов, проходящих по лимитам', async () => {
      db.order.findUnique.mockResolvedValue(null);
      db.traderRequisite.findMany.mockResolvedValue([
        requisite({ cooldownUntil: new Date(Date.now() + 600_000) }),
      ]);

      const err = await service
        .createDeposit(merchant(), depositDto, meta)
        .catch((e) => e as ServiceUnavailableException);

      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect(((err as ServiceUnavailableException).getResponse() as { code: string }).code).toBe('NO_LIQUIDITY');
    });
  });

  describe('createWithdrawal', () => {
    const withdrawalDto = {
      type: 'WITHDRAWAL' as const,
      method: 'CARD' as const,
      amount: 100,
      currency: 'RUB',
      idempotencyKey: 'wd-key-12345',
      requisites: { method: 'CARD' as const, cardNumber: '4111111111111111', receiverName: 'IVAN IVANOV' },
    };

    it('списывает баланс мерчанта и пишет ORDER_DEBIT + FEE в ledger', async () => {
      db.order.findUnique.mockResolvedValue(null);
      db.merchant.findUniqueOrThrow.mockResolvedValue(merchant());
      db.order.create.mockImplementation(async ({ data }) =>
        makeOrder({ type: 'WITHDRAWAL', status: 'PENDING', ...data }),
      );

      const { order } = await service.createWithdrawal(merchant(), withdrawalDto);

      expect(order.status).toBe('PENDING');
      expect(db.merchant.updateMany).toHaveBeenCalledWith({
        where: { id: 'm-1', balance: { gte: D('103') } },
        data: { balance: { decrement: D('103') } },
      });

      const entries = ledgerCalls();
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({
        partyType: 'MERCHANT',
        kind: 'ORDER_DEBIT',
        amount: D('-100'),
        balanceAfter: D('397'),
      });
      expect(entries[1]).toMatchObject({ partyType: 'PLATFORM', kind: 'FEE', amount: D('3') });

      const stored = db.order.create.mock.calls[0][0].data.payoutRequisites;
      expect(stored.cardMasked).toBe('**** **** **** 1111');
      expect(stored.cardNumberEncrypted).not.toContain('4111111111111111');
    });

    it('INSUFFICIENT_FUNDS при нехватке баланса и без записи в ledger', async () => {
      db.order.findUnique.mockResolvedValue(null);
      db.merchant.findUniqueOrThrow.mockResolvedValue(merchant());
      db.merchant.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.createWithdrawal(merchant(), withdrawalDto)).rejects.toMatchObject({
        response: { code: 'INSUFFICIENT_FUNDS' },
      });
      expect(db.order.create).not.toHaveBeenCalled();
      expect(db.ledgerEntry.create).not.toHaveBeenCalled();
    });
  });

  describe('acceptByTrader', () => {
    it('переводит PENDING → ASSIGNED и шлёт вебхук order.assigned', async () => {
      db.order.findUnique.mockResolvedValue(
        makeOrder({ status: 'PENDING', createdAt: new Date() }),
      );
      const assigned = makeOrder({ status: 'ASSIGNED' });
      db.order.updateMany.mockResolvedValueOnce({ count: 1 });
      db.order.findUniqueOrThrow.mockResolvedValueOnce(assigned);

      const order = await service.acceptByTrader('t-1', 'ord-1');

      expect(order.status).toBe('ASSIGNED');
      expect(db.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'ord-1', status: { in: ['PENDING'] }, traderId: 't-1' },
        data: { status: 'ASSIGNED' },
      });
      expect(webhooks.dispatch).toHaveBeenCalledWith('order.assigned', expect.anything(), 'm-1');
    });

    it('ConflictException если ордер не в PENDING', async () => {
      db.order.findUnique.mockResolvedValue(
        makeOrder({ status: 'ASSIGNED', createdAt: new Date() }),
      );
      db.order.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(service.acceptByTrader('t-1', 'ord-1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('NotFoundException если ордер чужой или не существует', async () => {
      db.order.findUnique.mockResolvedValue(null);
      await expect(service.acceptByTrader('t-1', 'ord-1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('ConflictException если истекло окно приёма (10 мин)', async () => {
      db.order.findUnique.mockResolvedValue(
        makeOrder({ status: 'PENDING', createdAt: new Date(Date.now() - 11 * 60_000) }),
      );
      await expect(service.acceptByTrader('t-1', 'ord-1')).rejects.toThrow('Acceptance window expired');
    });
  });

  describe('confirmDepositByTrader', () => {
    it('завершает депозит: мерчанту +970, трейдер −975, платформа +55, разблокировка', async () => {
      db.order.findUnique.mockResolvedValue(makeOrder());
      db.merchant.findUniqueOrThrow.mockResolvedValue(merchant());
      db.trader.findUniqueOrThrow.mockResolvedValue(trader());
      db.order.findUniqueOrThrow.mockResolvedValue(makeOrder({ status: 'COMPLETED' }));
      db.traderRequisite.findUnique.mockResolvedValue(
        requisite({ usedToday: D('300'), usageDay: new Date(Date.now() - 3_600_000) }),
      );

      const order = await service.confirmDepositByTrader('t-1', 'ord-1', {});

      expect(order.status).toBe('COMPLETED');
      expect(db.merchant.update).toHaveBeenCalledWith({
        where: { id: 'm-1' },
        data: { balance: { increment: D('970') } },
      });
      expect(db.trader.update).toHaveBeenCalledWith({
        where: { id: 't-1' },
        data: { balance: { decrement: D('975') }, successCount: { increment: 1 } },
      });

      const entries = ledgerCalls();
      expect(entries).toHaveLength(3);
      expect(entries[0]).toEqual(
        expect.objectContaining({ partyType: 'MERCHANT', kind: 'ORDER_CREDIT', amount: D('970'), balanceAfter: D('1470') }),
      );
      expect(entries[1]).toEqual(
        expect.objectContaining({ partyType: 'TRADER', kind: 'ORDER_DEBIT', amount: D('-975'), balanceAfter: D('-775') }),
      );
      expect(entries[2]).toEqual(expect.objectContaining({ partyType: 'PLATFORM', kind: 'FEE', amount: D('55') }));

      expect(routing.unlock).toHaveBeenCalledWith(db, 't-1');
      expect(webhooks.dispatch).toHaveBeenCalledWith('order.completed', expect.anything(), 'm-1');

      expect(db.traderRequisite.update).toHaveBeenCalledWith({
        where: { id: 'req-1' },
        data: {
          usedToday: { increment: D('1000') },
          usageDay: expect.any(Date),
          cooldownUntil: expect.any(Date),
        },
      });
    });

    it('ConflictException если ордер не в ASSIGNED', async () => {
      db.order.findUnique.mockResolvedValue(makeOrder());
      db.order.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(service.confirmDepositByTrader('t-1', 'ord-1', {})).rejects.toBeInstanceOf(ConflictException);
    });

    it('NotFoundException для чужого трейдера', async () => {
      db.order.findUnique.mockResolvedValue(makeOrder({ traderId: 'someone-else' }));
      await expect(service.confirmDepositByTrader('t-1', 'ord-1', {})).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('markWithdrawalPaidByTrader', () => {
    it('кредитует трейдера на amount − feeTrader и снимает лок', async () => {
      db.order.findUnique.mockResolvedValue(makeOrder({ type: 'WITHDRAWAL' }));
      db.trader.findUniqueOrThrow.mockResolvedValue(trader());
      db.order.findUniqueOrThrow.mockResolvedValue(makeOrder({ type: 'WITHDRAWAL', status: 'COMPLETED' }));

      const order = await service.markWithdrawalPaidByTrader('t-1', 'ord-1');

      expect(order.status).toBe('COMPLETED');
      expect(db.trader.update).toHaveBeenCalledWith({
        where: { id: 't-1' },
        data: { balance: { increment: D('975') }, successCount: { increment: 1 } },
      });
      expect(ledgerCalls()[0]).toEqual(
        expect.objectContaining({ partyType: 'TRADER', kind: 'ORDER_CREDIT', amount: D('975'), balanceAfter: D('1175') }),
      );
      expect(routing.unlock).toHaveBeenCalledWith(db, 't-1');
    });
  });

  describe('declineByTrader', () => {
    it('перенаправляет ордер другому трейдеру до лимита рерутов', async () => {
      const pending = makeOrder({ status: 'PENDING', traderId: 't-1' });
      db.order.findUnique.mockResolvedValue(pending);
      routing.pickAndLock.mockResolvedValue(trader({ id: 't-2', displayName: 'Two', feePercent: D('5') }));
      db.traderRequisite.findMany.mockResolvedValue([requisite()]);
      db.order.update.mockImplementation(async ({ data }) =>
        makeOrder({ status: 'PENDING', traderId: 't-2', rerouteCount: 1, ...data }),
      );

      const { rerouted } = await service.declineByTrader('t-1', 'ord-1', 'busy');

      expect(rerouted).toBe(true);
      expect(routing.bumpStats).toHaveBeenCalledWith(db, 't-1', false);
      const data = db.order.update.mock.calls[0][0].data;
      expect(data.rerouteCount).toEqual({ increment: 1 });
      expect(data.feeTrader.toFixed(2)).toBe('50.00');
      expect(webhooks.dispatch).toHaveBeenCalledWith('order.assigned', expect.anything(), 'm-1');
    });

    it('отменяет ордер и возвращает деньги, если трейдеров больше нет', async () => {
      db.order.findUnique.mockResolvedValue(makeOrder({ type: 'WITHDRAWAL', status: 'PENDING' }));
      routing.pickAndLock.mockRejectedValue(new RoutingFailedError());
      db.merchant.findUniqueOrThrow.mockResolvedValue(merchant());
      db.order.findUniqueOrThrow.mockResolvedValue(makeOrder({ type: 'WITHDRAWAL', status: 'CANCELLED' }));

      const { rerouted } = await service.declineByTrader('t-1', 'ord-1');

      expect(rerouted).toBe(false);
      const entries = ledgerCalls();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual(
        expect.objectContaining({ partyType: 'MERCHANT', kind: 'REFUND', amount: D('1030'), balanceAfter: D('1530') }),
      );
      expect(webhooks.dispatch).toHaveBeenCalledWith('order.cancelled', expect.anything(), 'm-1');
    });
  });

  describe('cancelByMerchant', () => {
    it('отменяет PENDING вывод и рефандит холд мерчанту', async () => {
      db.order.findUniqueOrThrow.mockResolvedValue(makeOrder({ type: 'WITHDRAWAL', status: 'PENDING' }));
      db.merchant.findUniqueOrThrow.mockResolvedValue(merchant());

      const order = await service.cancelByMerchant('m-1', 'ord-1', 'test');

      expect(order.status).toBe('PENDING');
      expect(routing.unlock).toHaveBeenCalledWith(db, 't-1');
      const entries = ledgerCalls();
      expect(entries[0]).toEqual(expect.objectContaining({ kind: 'REFUND', amount: D('1030') }));
      expect(webhooks.dispatch).toHaveBeenCalledWith('order.cancelled', expect.anything(), 'm-1');
    });

    it('ConflictException если ордер не в PENDING', async () => {
      db.order.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(service.cancelByMerchant('m-1', 'ord-1')).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('handleExpiration', () => {
    it('переводит открытый вывод в EXPIRED с рефандом', async () => {
      db.order.findUnique.mockResolvedValue(makeOrder({ type: 'WITHDRAWAL', status: 'ASSIGNED' }));
      db.order.findUniqueOrThrow.mockResolvedValue(makeOrder({ type: 'WITHDRAWAL', status: 'EXPIRED' }));
      db.merchant.findUniqueOrThrow.mockResolvedValue(merchant());

      await service.handleExpiration('ord-1');

      expect(webhooks.dispatch).toHaveBeenCalledWith('order.expired', expect.anything(), 'm-1');
      expect(ledgerCalls()[0]).toEqual(expect.objectContaining({ kind: 'REFUND', amount: D('1030') }));
      expect(routing.unlock).toHaveBeenCalledWith(db, 't-1');
    });

    it('игнорирует уже терминальные ордера', async () => {
      db.order.findUnique.mockResolvedValue(makeOrder({ status: 'COMPLETED' }));

      await service.handleExpiration('ord-1');

      expect(webhooks.dispatch).not.toHaveBeenCalled();
      expect(db.ledgerEntry.create).not.toHaveBeenCalled();
    });
  });

  describe('openDisputeByTrader', () => {
    it('переводит ASSIGNED депозит в DISPUTED, лок сохраняется', async () => {
      db.order.findUnique.mockResolvedValue(makeOrder({ status: 'ASSIGNED' }));
      db.order.findUniqueOrThrow.mockResolvedValue(makeOrder({ status: 'DISPUTED' }));

      const order = await service.openDisputeByTrader('t-1', 'ord-1', 'payment not received');

      expect(order.status).toBe('DISPUTED');
      expect(db.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'ord-1', status: 'ASSIGNED', traderId: 't-1' },
        data: { status: 'DISPUTED' },
      });
      expect(routing.unlock).not.toHaveBeenCalled();
      expect(db.ledgerEntry.create).not.toHaveBeenCalled();
      expect(webhooks.dispatch).toHaveBeenCalledWith('order.disputed', expect.anything(), 'm-1');
    });

    it('ConflictException если ордер не в ASSIGNED', async () => {
      db.order.findUnique.mockResolvedValue(makeOrder({ status: 'COMPLETED' }));
      db.order.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(service.openDisputeByTrader('t-1', 'ord-1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('NotFoundException для чужого ордера', async () => {
      db.order.findUnique.mockResolvedValue(null);
      await expect(service.openDisputeByTrader('t-1', 'nope')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('adminResolve', () => {
    it('форс-комплит PENDING депозита проводит все денежные стороны', async () => {
      db.order.findUnique.mockResolvedValue(makeOrder({ status: 'PENDING' }));
      db.merchant.findUniqueOrThrow.mockResolvedValue(merchant());
      db.trader.findUniqueOrThrow.mockResolvedValue(trader());
      db.order.findUniqueOrThrow.mockResolvedValue(makeOrder({ status: 'COMPLETED' }));

      const order = await service.adminResolve('ord-1', 'complete', 'admin@payflow.io');

      expect(order.status).toBe('COMPLETED');
      expect(ledgerCalls()).toHaveLength(3);
      expect(webhooks.dispatch).toHaveBeenCalledWith('order.completed', expect.anything(), 'm-1');
    });

    it('форс-отмена ASSIGNED вывода рефандит мерчанту', async () => {
      db.order.findUnique.mockResolvedValue(makeOrder({ type: 'WITHDRAWAL', status: 'ASSIGNED' }));
      db.merchant.findUniqueOrThrow.mockResolvedValue(merchant());
      db.order.findUniqueOrThrow.mockResolvedValue(makeOrder({ type: 'WITHDRAWAL', status: 'CANCELLED' }));

      const order = await service.adminResolve('ord-1', 'cancel', 'admin@payflow.io', 'fraud suspect');

      expect(order.status).toBe('CANCELLED');
      expect(ledgerCalls()[0]).toEqual(expect.objectContaining({ kind: 'REFUND', amount: D('1030') }));
      expect(webhooks.dispatch).toHaveBeenCalledWith('order.cancelled', expect.anything(), 'm-1');
    });

    it('разрешает DISPUTED ордер в complete с денежными проводками', async () => {
      db.order.findUnique.mockResolvedValue(makeOrder({ status: 'DISPUTED' }));
      db.merchant.findUniqueOrThrow.mockResolvedValue(merchant());
      db.trader.findUniqueOrThrow.mockResolvedValue(trader());
      db.order.findUniqueOrThrow.mockResolvedValue(makeOrder({ status: 'COMPLETED' }));

      const order = await service.adminResolve('ord-1', 'complete', 'admin@payflow.io', 'trader right');

      expect(order.status).toBe('COMPLETED');
      expect(ledgerCalls()).toHaveLength(3);
      expect(routing.unlock).toHaveBeenCalledWith(db, 't-1');
    });

    it('ConflictException на терминальном ордере', async () => {
      db.order.findUnique.mockResolvedValue(makeOrder({ status: 'COMPLETED' }));
      await expect(service.adminResolve('ord-1', 'complete', 'admin')).rejects.toBeInstanceOf(ConflictException);
    });
  });
});
