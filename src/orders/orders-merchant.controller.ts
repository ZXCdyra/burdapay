import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  RawBodyRequest,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Merchant } from '@prisma/client';
import { z } from 'zod';
import { ApiKeyGuard } from '../common/guards/api-key.guard';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { CreateOrderSchema, RequestMeta, TraderActionSchema } from './orders.dto';
import { OrdersService } from './orders.service';

@ApiTags('orders')
@ApiSecurity('api-key')
@UseGuards(ApiKeyGuard)
@Controller('orders')
export class OrdersMerchantController {
  constructor(private readonly orders: OrdersService) {}

  private meta(req: RawBodyRequest<Request>): RequestMeta {
    const forwarded = req.headers['x-forwarded-for'];
    const ip =
      (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : undefined) ??
      req.ip ??
      undefined;
    const deviceId = typeof req.headers['x-device-id'] === 'string' ? req.headers['x-device-id'] : undefined;
    return { ip, deviceId };
  }

  @Post()
  @ApiOperation({ summary: 'Create deposit or withdrawal order (idempotent)' })
  create(@Req() req: RawBodyRequest<Request>, @Body(new ZodValidationPipe(CreateOrderSchema)) dto: z.infer<typeof CreateOrderSchema>) {
    const merchant = req.merchant!;
    return this.orders.createOrder(merchant, dto, this.meta(req));
  }

  @Get(':orderId')
  @ApiOperation({ summary: 'Get order by id with event history' })
  get(@Req() req: RawBodyRequest<Request>, @Param('orderId') orderId: string) {
    const merchant = req.merchant!;
    return this.orders.getForMerchant(merchant.id, orderId);
  }

  @Post(':orderId/cancel')
  @ApiOperation({ summary: 'Cancel PENDING order' })
  cancel(
    @Req() req: RawBodyRequest<Request>,
    @Param('orderId') orderId: string,
    @Body(new ZodValidationPipe(TraderActionSchema)) dto: z.infer<typeof TraderActionSchema>,
  ) {
    const merchant = req.merchant!;
    return this.orders.cancelByMerchant(merchant.id, orderId, dto.reason);
  }
}
