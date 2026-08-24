import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  ConflictException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PartyStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { AuthUser } from '../common/types/auth-user.type';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcryptjs';
import { OrdersService } from '../orders/orders.service';
import { EventsService } from '../websocket/events.service';

const ResolveOrderSchema = z.object({
  action: z.enum(['complete', 'cancel']),
  reason: z.string().max(500).optional(),
});

const UpdateMerchantSchema = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED', 'BLOCKED']).optional(),
  feePercent: z.number().min(0).max(50).optional(),
  webhookUrl: z.string().url().nullable().optional(),
});

const UpdateTraderSchema = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED', 'BLOCKED']).optional(),
  isOnline: z.boolean().optional(),
  methodCard: z.boolean().optional(),
  methodSbp: z.boolean().optional(),
  feePercent: z.number().min(0).max(50).optional(),
  minOrderAmount: z.number().positive().optional(),
  maxOrderAmount: z.number().positive().optional(),
  maxConcurrentOrders: z.number().int().min(1).max(100).optional(),
});

const BalanceAdjustSchema = z.object({
  partyType: z.enum(['MERCHANT', 'TRADER']),
  partyId: z.string().min(1),
  amount: z.number(),
  memo: z.string().max(300).default('Manual adjustment by admin'),
});

const BlacklistSchema = z.object({
  kind: z.enum(['IP', 'CARD_HASH', 'DEVICE_ID']),
  value: z.string().min(3).max(200),
  reason: z.string().min(3).max(300),
  expiresAt: z.coerce.date().optional().nullable(),
});

@ApiTags('admin')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
@Controller('admin')
export class AdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly events: EventsService,
  ) {}

  private CreateTraderSchema = z.object({
    email: z.string().email(),
    password: z.string().min(6),
    displayName: z.string().min(2).max(120),
  });

  private CreateMerchantSchema = z.object({
    name: z.string().min(2).max(120),
    email: z.string().email(),
    password: z.string().min(6),
  });

  private CreateAdminSchema = z.object({
    email: z.string().email(),
    password: z.string().min(6),
    name: z.string().max(120).optional(),
  });

  @Get('stats')
  @ApiOperation({ summary: 'Platform KPIs' })
  async stats() {
    const [ordersByStatus, completedAgg, merchants, traders, fraudLast24h] = await Promise.all([
      this.prisma.order.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.order.aggregate({
        where: { status: 'COMPLETED' },
        _count: { _all: true },
        _sum: { amount: true, feePlatform: true },
      }),
      this.prisma.merchant.count({ where: { status: PartyStatus.ACTIVE } }),
      this.prisma.trader.count({ where: { status: PartyStatus.ACTIVE, isOnline: true } }),
      this.prisma.fraudEvent.count({
        where: { createdAt: { gte: new Date(Date.now() - 86400_000) } },
      }),
    ]);

    return {
      ordersByStatus: Object.fromEntries(
        ordersByStatus.map((g) => [g.status, g._count._all]),
      ),
      completedOrders: completedAgg._count._all,
      completedVolume: completedAgg._sum.amount?.toFixed(2) ?? '0.00',
      platformFeesEarned: completedAgg._sum.feePlatform?.toFixed(2) ?? '0.00',
      activeMerchants: merchants,
      onlineTraders: traders,
      fraudEventsLast24h: fraudLast24h,
    };
  }

  @Get('orders')
  @ApiOperation({ summary: 'All orders with filters' })
  listOrders(@Query('status') status?: string, @Query('merchantId') merchantId?: string) {
    return this.prisma.order.findMany({
      where: {
        ...(status ? { status: status as Prisma.EnumOrderStatusFilter['equals'] as never } : {}),
        ...(merchantId ? { merchantId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  @Post('orders/:orderId/resolve')
  @ApiOperation({ summary: 'Force complete or cancel order' })
  resolveOrder(
    @CurrentUser() user: AuthUser,
    @Param('orderId') orderId: string,
    @Body(new ZodValidationPipe(ResolveOrderSchema)) dto: z.infer<typeof ResolveOrderSchema>,
  ) {
    return this.orders.adminResolve(orderId, dto.action, user.email, dto.reason);
  }

  @Post('orders/:orderId/archive')
  @ApiOperation({ summary: 'Archive order (mark expired) by admin' })
  async archiveOrder(@CurrentUser() user: AuthUser, @Param('orderId') orderId: string) {
    return this.orders.adminArchive(orderId, user.email);
  }

  @Get('merchants')
  listMerchants() {
    return this.prisma.merchant.findMany({
      select: { id: true, name: true, email: true, status: true, feePercent: true, balance: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  @Patch('merchants/:id')
  async updateMerchant(@Param('id') id: string, @Body(new ZodValidationPipe(UpdateMerchantSchema)) dto: z.infer<typeof UpdateMerchantSchema>) {
    const data: Prisma.MerchantUpdateInput = {};
    if (dto.status) data.status = dto.status;
    if (dto.feePercent !== undefined) data.feePercent = new Prisma.Decimal(dto.feePercent);
    if (dto.webhookUrl !== undefined) data.webhookUrl = dto.webhookUrl;
    const m = await this.prisma.merchant.update({ where: { id }, data });
    const { passwordHash: _p, callbackSecretEncrypted: _c, ...rest } = m;
    return rest;
  }

  @Get('traders')
  listTraders() {
    return this.prisma.trader.findMany({
      select: {
        id: true, email: true, displayName: true, status: true, isOnline: true,
        methodCard: true, methodSbp: true, feePercent: true, balance: true,
        lockedOrders: true, successCount: true, failCount: true, createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  @Post('traders')
  @ApiOperation({ summary: 'Create trader account' })
  async createTrader(@Body() body: any) {
    const dto = this.CreateTraderSchema.parse(body);
    const existing = await this.prisma.trader.findUnique({ where: { email: dto.email } });
    if (existing) throw new ConflictException('Trader with this email already exists');
    const trader = await this.prisma.trader.create({
      data: {
        email: dto.email,
        displayName: dto.displayName,
        passwordHash: await bcrypt.hash(dto.password, 10),
      },
    });
    const { passwordHash: _p, ...rest } = trader;
    this.events.emitToAdmins('user.created', { role: 'TRADER', ...rest });
    return rest;
  }

  @Patch('traders/:id')
  async updateTrader(@Param('id') id: string, @Body(new ZodValidationPipe(UpdateTraderSchema)) dto: z.infer<typeof UpdateTraderSchema>) {
    const data: Prisma.TraderUpdateInput = {};
    if (dto.status) data.status = dto.status;
    if (dto.isOnline !== undefined) data.isOnline = dto.isOnline;
    if (dto.methodCard !== undefined) data.methodCard = dto.methodCard;
    if (dto.methodSbp !== undefined) data.methodSbp = dto.methodSbp;
    if (dto.feePercent !== undefined) data.feePercent = new Prisma.Decimal(dto.feePercent);
    if (dto.minOrderAmount !== undefined) data.minOrderAmount = new Prisma.Decimal(dto.minOrderAmount);
    if (dto.maxOrderAmount !== undefined) data.maxOrderAmount = new Prisma.Decimal(dto.maxOrderAmount);
    if (dto.maxConcurrentOrders !== undefined) data.maxConcurrentOrders = dto.maxConcurrentOrders;
    const t = await this.prisma.trader.update({ where: { id }, data });
    const { passwordHash: _p, ...rest } = t;
    return rest;
  }

  @Post('merchants')
  @ApiOperation({ summary: 'Create merchant account' })
  async createMerchant(@Body() body: any) {
    const dto = this.CreateMerchantSchema.parse(body);
    const existing = await this.prisma.merchant.findUnique({ where: { email: dto.email } });
    if (existing) throw new ConflictException('Merchant with this email already exists');
    const callbackSecret = 'init';
    const merchant = await this.prisma.merchant.create({
      data: {
        name: dto.name,
        email: dto.email,
        passwordHash: await bcrypt.hash(dto.password, 10),
        status: PartyStatus.ACTIVE,
        callbackSecretEncrypted: callbackSecret,
      },
    });
    const { passwordHash: _p, callbackSecretEncrypted: _c, ...rest } = merchant;
    this.events.emitToAdmins('user.created', { role: 'MERCHANT', ...rest });
    return rest;
  }

  @Post('admins')
  @ApiOperation({ summary: 'Create admin/support account' })
  async createAdmin(@Body() body: any) {
    const dto = this.CreateAdminSchema.parse(body);
    const existing = await this.prisma.adminUser.findUnique({ where: { email: dto.email } });
    if (existing) throw new ConflictException('Admin with this email already exists');
    const admin = await this.prisma.adminUser.create({
      data: { email: dto.email, passwordHash: await bcrypt.hash(dto.password, 12), name: dto.name ?? 'Admin' },
    });
    const { passwordHash: _p, ...rest } = admin;
    this.events.emitToAdmins('user.created', { role: 'ADMIN', ...rest });
    return rest;
  }

  @Get('users')
  @ApiOperation({ summary: 'List all users (merchants, traders, admins)' })
  async listUsers() {
    const [merchants, traders, admins] = await Promise.all([
      this.prisma.merchant.findMany({ select: { id: true, name: true, email: true, status: true, createdAt: true } }),
      this.prisma.trader.findMany({ select: { id: true, displayName: true, email: true, status: true, createdAt: true } }),
      this.prisma.adminUser.findMany({ select: { id: true, name: true, email: true, createdAt: true } }),
    ]);
    const users = [] as any[];
    for (const m of merchants) users.push({ id: m.id, role: 'MERCHANT', name: m.name, email: m.email, status: m.status, createdAt: m.createdAt });
    for (const t of traders) users.push({ id: t.id, role: 'TRADER', name: t.displayName, email: t.email, status: t.status, createdAt: t.createdAt });
    for (const a of admins) users.push({ id: a.id, role: 'ADMIN', name: a.name, email: a.email, status: 'ACTIVE', createdAt: a.createdAt });
    users.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return users;
  }

  @Post('balance-adjust')
  @ApiOperation({ summary: 'Credit or debit merchant/trader balance' })
  async adjustBalance(@Body(new ZodValidationPipe(BalanceAdjustSchema)) dto: z.infer<typeof BalanceAdjustSchema>) {
    return this.prisma.$transaction(
      async (tx) => {
        const amount = new Prisma.Decimal(dto.amount).toDecimalPlaces(2);
        if (dto.partyType === 'MERCHANT') {
          const m = await tx.merchant.findUniqueOrThrow({ where: { id: dto.partyId } });
          await tx.merchant.update({ where: { id: m.id }, data: { balance: { increment: amount } } });
          await tx.ledgerEntry.create({
            data: {
              partyType: 'MERCHANT',
              partyId: m.id,
              kind: 'BALANCE_ADJUSTMENT',
              amount,
              balanceAfter: m.balance.add(amount),
              memo: dto.memo,
            },
          });
          return { ok: true, balanceAfter: m.balance.add(amount).toFixed(2) };
        }
        const t = await tx.trader.findUniqueOrThrow({ where: { id: dto.partyId } });
        await tx.trader.update({ where: { id: t.id }, data: { balance: { increment: amount } } });
        await tx.ledgerEntry.create({
          data: {
            partyType: 'TRADER',
            partyId: t.id,
            kind: 'BALANCE_ADJUSTMENT',
            amount,
            balanceAfter: t.balance.add(amount),
            memo: dto.memo,
          },
        });
        return { ok: true, balanceAfter: t.balance.add(amount).toFixed(2) };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  @Get('blacklist')
  listBlacklist() {
    return this.prisma.blacklistEntry.findMany({ orderBy: { createdAt: 'desc' }, take: 500 });
  }

  @Post('blacklist')
  addToBlacklist(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(BlacklistSchema)) dto: z.infer<typeof BlacklistSchema>) {
    return this.prisma.blacklistEntry.upsert({
      where: { kind_value: { kind: dto.kind, value: dto.value } },
      update: { reason: dto.reason, expiresAt: dto.expiresAt ?? null },
      create: { ...dto, createdBy: user.email, expiresAt: dto.expiresAt ?? null },
    });
  }

  @Get('fraud-events')
  fraudEvents() {
    return this.prisma.fraudEvent.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
  }

  @Get('webhook-deliveries')
  webhookDeliveries(@Query('merchantId') merchantId?: string) {
    return this.prisma.webhookDelivery.findMany({
      where: merchantId ? { merchantId } : {},
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  @Get('ledger')
  ledger(@Query('partyType') partyType?: string, @Query('partyId') partyId?: string) {
    return this.prisma.ledgerEntry.findMany({
      where: {
        ...(partyType ? { partyType: partyType as Prisma.EnumLedgerPartyTypeFilter['equals'] as never } : {}),
        ...(partyId ? { partyId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }
}
