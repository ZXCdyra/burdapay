import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PartyStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import { AppConfig } from '../common/config/app-config.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { CryptoUtil } from '../common/utils/crypto.util';
import { AuthUser } from '../common/types/auth-user.type';
import { PrismaService } from '../prisma/prisma.service';

const UpdateProfileSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  webhookUrl: z.string().url().max(500).nullable().optional(),
});

const CreateApiKeySchema = z.object({
  name: z.string().min(1).max(60).default('default'),
});

@ApiTags('merchants')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('MERCHANT')
@Controller('merchant')
export class MerchantsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: AppConfig,
  ) {}

  @Get('me')
  @ApiOperation({ summary: 'Merchant profile, balance and fees' })
  async me(@CurrentUser() user: AuthUser) {
    const merchant = await this.prisma.merchant.findUnique({ where: { id: user.id } });
    if (!merchant) throw new NotFoundException();
    const { passwordHash: _p, callbackSecretEncrypted: _c, ...rest } = merchant;
    return rest;
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update profile / webhook URL' })
  async update(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(UpdateProfileSchema)) dto: z.infer<typeof UpdateProfileSchema>) {
    const data: Prisma.MerchantUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.webhookUrl !== undefined) data.webhookUrl = dto.webhookUrl;
    const merchant = await this.prisma.merchant.update({ where: { id: user.id }, data });
    const { passwordHash: _p, callbackSecretEncrypted: _c, ...rest } = merchant;
    return rest;
  }

  @Get('me/api-keys')
  @ApiOperation({ summary: 'List API keys' })
  listKeys(@CurrentUser() user: AuthUser) {
    return this.prisma.apiKey.findMany({
      where: { merchantId: user.id },
      select: { id: true, name: true, publicKey: true, secretPrefix: true, status: true, lastUsedAt: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  @Post('me/api-keys')
  @ApiOperation({ summary: 'Create API key; secret is returned ONCE' })
  async createKey(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(CreateApiKeySchema)) dto: z.infer<typeof CreateApiKeySchema>) {
    const publicKey = `pk_${CryptoUtil.randomHex(16)}`;
    const secret = `sk_${CryptoUtil.randomHex(32)}`;
    await this.prisma.merchant.update({
      where: { id: user.id },
      data: { status: PartyStatus.ACTIVE },
    });
    const key = await this.prisma.apiKey.create({
      data: {
        merchantId: user.id,
        name: dto.name,
        publicKey,
        secretEncrypted: CryptoUtil.encrypt(secret, this.cfg.encryptionKey),
        secretPrefix: `${secret.slice(0, 8)}...`,
      },
    });
    return {
      id: key.id,
      publicKey,
      secret,
      warning: 'Store the secret now. It is encrypted at rest and never shown again.',
    };
  }

  @Delete('me/api-keys/:keyId')
  @ApiOperation({ summary: 'Revoke API key' })
  async revokeKey(@CurrentUser() user: AuthUser, @Param('keyId') keyId: string) {
    const key = await this.prisma.apiKey.findFirst({ where: { id: keyId, merchantId: user.id } });
    if (!key) throw new NotFoundException('API key not found');
    await this.prisma.apiKey.update({ where: { id: keyId }, data: { status: 'REVOKED' } });
    return { revoked: true };
  }

  @Get('me/ledger')
  @ApiOperation({ summary: 'Balance ledger entries' })
  ledger(@CurrentUser() user: AuthUser) {
    return this.prisma.ledgerEntry.findMany({
      where: { partyType: 'MERCHANT', partyId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  @Get('orders')
  @ApiOperation({ summary: 'Own orders (dashboard)' })
  listOrders(@CurrentUser() user: AuthUser, @Query('status') status?: string) {
    return this.prisma.order.findMany({
      where: {
        merchantId: user.id,
        ...(status ? { status: status as Prisma.EnumOrderStatusFilter['equals'] as never } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true, type: true, method: true, status: true, amount: true, currency: true,
        feeMerchant: true, merchantOrderId: true, paymentDetails: true, expiresAt: true,
        completedAt: true, createdAt: true,
      },
    });
  }

  @Get('orders/:orderId')
  @ApiOperation({ summary: 'Own order details (dashboard)' })
  async getOwnOrder(@CurrentUser() user: AuthUser, @Param('orderId') orderId: string) {
    const order = await this.prisma.order.findFirst({ where: { id: orderId, merchantId: user.id } });
    if (!order) throw new NotFoundException('Order not found');
    const { payerIp: _ip, payerDeviceId: _dev, payerCardHash: _hash, ...rest } = order;
    return rest;
  }
}
