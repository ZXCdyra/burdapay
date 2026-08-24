import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PartyStatus, PaymentMethod, Prisma } from '@prisma/client';
import { z } from 'zod';
import { AppConfig } from '../common/config/app-config.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { EventsService } from '../websocket/events.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { AuthUser } from '../common/types/auth-user.type';
import { CryptoUtil } from '../common/utils/crypto.util';
import {
  validateCardOrThrow,
  validateSbpPhoneOrThrow,
} from '../payment-methods/payment-methods.validators';
import { PrismaService } from '../prisma/prisma.service';

const UpdateTraderSchema = z.object({
  isOnline: z.boolean().optional(),
  methodCard: z.boolean().optional(),
  methodSbp: z.boolean().optional(),
  minOrderAmount: z.number().min(0).optional(),
  maxOrderAmount: z.number().min(0).optional(),
  maxConcurrentOrders: z.number().int().min(1).optional(),
});

const CreateRequisiteSchema = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('CARD'),
    label: z.string().max(60).optional(),
    bankName: z.string().min(2).max(60),
    receiverName: z.string().min(2).max(120),
    cardNumber: z.string().min(13).max(25),
  }),
  z.object({
    method: z.literal('SBP'),
    label: z.string().max(60).optional(),
    bankName: z.string().min(2).max(60),
    receiverName: z.string().min(2).max(120),
    phone: z.string().min(10).max(20),
  }),
]);

@ApiTags('trader')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('TRADER')
@Controller('trader')
export class TradersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: AppConfig,
    private readonly webhooks: WebhooksService,
    private readonly events: EventsService,
  ) {}

  private async requireTrader(userId: string) {
    const trader = await this.prisma.trader.findUnique({ where: { id: userId } });
    if (!trader) throw new NotFoundException('Trader not found');
    return trader;
  }

  @Get('me')
  @ApiOperation({ summary: 'Trader profile, limits, balance and stats' })
  async me(@CurrentUser() user: AuthUser) {
    const trader = await this.requireTrader(user.id);
    const { passwordHash: _p, ...rest } = trader;
    return rest;
  }

  @Patch('me')
  @ApiOperation({ summary: 'Toggle availability / supported methods' })
  async update(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(UpdateTraderSchema)) dto: z.infer<typeof UpdateTraderSchema>,
  ) {
    await this.requireTrader(user.id);
    const data: Prisma.TraderUpdateInput = {};
    if (dto.isOnline !== undefined) data.isOnline = dto.isOnline;
    if (dto.methodCard !== undefined) data.methodCard = dto.methodCard;
    if (dto.methodSbp !== undefined) data.methodSbp = dto.methodSbp;
    if (dto.minOrderAmount !== undefined) data.minOrderAmount = new Prisma.Decimal(dto.minOrderAmount);
    if (dto.maxOrderAmount !== undefined) data.maxOrderAmount = new Prisma.Decimal(dto.maxOrderAmount);
    if (dto.maxConcurrentOrders !== undefined) data.maxConcurrentOrders = dto.maxConcurrentOrders;
    const trader = await this.prisma.trader.update({ where: { id: user.id }, data });
    const { passwordHash: _p, ...rest } = trader;
    return rest;
  }

  @Get('me/balance')
  @ApiOperation({ summary: 'Balance and ledger' })
  async balance(@CurrentUser() user: AuthUser) {
    const trader = await this.requireTrader(user.id);
    const entries = await this.prisma.ledgerEntry.findMany({
      where: { partyType: 'TRADER', partyId: trader.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return { balance: trader.balance.toFixed(2), lockedOrders: trader.lockedOrders, entries };
  }

  @Get('me/requisites')
  @ApiOperation({ summary: 'List payment requisites' })
  async requisites(@CurrentUser() user: AuthUser) {
    await this.requireTrader(user.id);
    return this.prisma.traderRequisite.findMany({ where: { traderId: user.id }, orderBy: { createdAt: 'desc' } });
  }

  @Post('me/requisites')
  @ApiOperation({ summary: 'Add CARD or SBP requisite; card stored encrypted' })
  async addRequisite(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(CreateRequisiteSchema)) dto: z.infer<typeof CreateRequisiteSchema>,
  ) {
    const trader = await this.requireTrader(user.id);
    if (trader.status !== PartyStatus.ACTIVE) throw new ForbiddenException('Trader account is not active');

    if (dto.method === 'CARD') {
      const validated = validateCardOrThrow(dto.cardNumber, this.cfg.cardPepper);
      const created = await this.prisma.traderRequisite.create({
        data: {
          traderId: trader.id,
          method: PaymentMethod.CARD,
          label: dto.label,
          bankName: dto.bankName,
          receiverName: dto.receiverName,
          cardNumberEncrypted: CryptoUtil.encrypt(validated.normalized, this.cfg.encryptionKey),
          cardLast4: validated.last4,
        },
      });

      // notify merchants with webhooks configured about new trader requisite
      const merchants = await this.prisma.merchant.findMany({ where: { webhookUrl: { not: null } } });
      const payload = {
        traderId: trader.id,
        displayName: trader.displayName,
        requisite: {
          method: 'CARD',
          bankName: created.bankName,
          receiverName: created.receiverName,
          cardLast4: created.cardLast4,
          label: created.label,
          createdAt: created.createdAt,
        },
      };
      for (const m of merchants) {
        try {
          await this.webhooks.dispatch('trader.requisite.created', payload, m.id);
          // store copy for merchant so merchants have local record
          await this.prisma.merchantRequisite.create({
            data: {
              merchantId: m.id,
              traderRequisiteId: created.id,
              traderId: trader.id,
              method: created.method,
              label: created.label,
              bankName: created.bankName,
              receiverName: created.receiverName,
              cardLast4: created.cardLast4 ?? null,
              sbpPhone: created.sbpPhone ?? null,
            },
          });
        } catch {}
      }
      const { cardNumberEncrypted: _e, ...sel } = created as any;
      return sel;
    }
    const phone = validateSbpPhoneOrThrow(dto.phone);
    const created = await this.prisma.traderRequisite.create({
      data: {
        traderId: trader.id,
        method: PaymentMethod.SBP,
        label: dto.label,
        bankName: dto.bankName,
        receiverName: dto.receiverName,
        sbpPhone: phone,
      },
    });

    // notify merchants with webhooks configured about new trader requisite
    const merchants = await this.prisma.merchant.findMany({ where: { webhookUrl: { not: null } } });
    const payload = {
      traderId: trader.id,
      displayName: trader.displayName,
      requisite: {
        method: 'SBP',
        bankName: created.bankName,
        receiverName: created.receiverName,
        phone: created.sbpPhone,
        label: created.label,
        createdAt: created.createdAt,
      },
    };
    for (const m of merchants) {
      try {
        await this.webhooks.dispatch('trader.requisite.created', payload, m.id);
        // store copy for merchant
        await this.prisma.merchantRequisite.create({
          data: {
            merchantId: m.id,
            traderRequisiteId: created.id,
            traderId: trader.id,
            method: created.method,
            label: created.label,
            bankName: created.bankName,
            receiverName: created.receiverName,
            cardLast4: created.cardLast4 ?? null,
            sbpPhone: created.sbpPhone ?? null,
          },
        });
      } catch {
        // ignore dispatch or storage errors
      }
    }
    return created;
  }

  @Delete('me/requisites/:reqId')
  @ApiOperation({ summary: 'Deactivate requisite' })
  async removeRequisite(@CurrentUser() user: AuthUser, @Param('reqId') reqId: string) {
    const req = await this.prisma.traderRequisite.findFirst({ where: { id: reqId, traderId: user.id } });
    if (!req) throw new NotFoundException('Requisite not found');
    await this.prisma.traderRequisite.update({ where: { id: reqId }, data: { isActive: false } });
    return { deactivated: true };
  }

  @Get('me/deposits')
  @ApiOperation({ summary: 'List trader deposit requests' })
  async listDeposits(@CurrentUser() user: AuthUser) {
    await this.requireTrader(user.id);
    return this.prisma.depositRequest.findMany({ where: { traderId: user.id }, orderBy: { createdAt: 'desc' } });
  }

  @Post('me/deposits')
  @ApiOperation({ summary: 'Create deposit request (TRC-20)' })
  async createDeposit(@CurrentUser() user: AuthUser, @Body() body: any) {
    const trader = await this.requireTrader(user.id);
    const amount = Number(body.amount ?? 0);
    const MIN = 50;
    if (isNaN(amount) || amount < MIN) throw new ForbiddenException(`Минимальная сумма пополнения ${MIN}$`);
    const addr = 'TRC-20 TGC6SGLQoW5szUhJhBBAfMmp7QYLnc4Lix';
    const created = await this.prisma.depositRequest.create({
      data: {
        traderId: trader.id,
        amount: new Prisma.Decimal(amount),
        currency: 'USD',
        address: addr,
        txHash: body.txHash ?? null,
      },
    });
    // notify admins via websocket
    try { this.events.emitToAdmins('deposit.request.created', { id: created.id, traderId: trader.id, accountId: trader.accountId, amount: created.amount.toFixed(2), currency: created.currency, address: created.address, createdAt: created.createdAt }); } catch {}
    return created;
  }
}
