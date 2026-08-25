import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { AuthUser } from '../common/types/auth-user.type';
import { ConfirmDepositSchema, TraderActionSchema } from './orders.dto';
import { OrdersService } from './orders.service';

@ApiTags('trader')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('TRADER')
@Controller('trader/orders')
export class OrdersTraderController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  @ApiOperation({ summary: 'List orders assigned to this trader' })
  list(@CurrentUser() user: AuthUser) {
    return this.orders.listForTrader(user.id);
  }

  @Get(':orderId')
  @ApiOperation({ summary: 'Trader order details (incl. payout requisites when ASSIGNED)' })
  get(@CurrentUser() user: AuthUser, @Param('orderId') orderId: string) {
    return this.orders.getForTrader(user.id, orderId);
  }

  @Post(':orderId/accept')
  @ApiOperation({ summary: 'Accept PENDING order' })
  accept(@CurrentUser() user: AuthUser, @Param('orderId') orderId: string) {
    return this.orders.acceptByTrader(user.id, orderId);
  }

  @Post(':orderId/decline')
  @ApiOperation({ summary: 'Decline order (platform reroutes or cancels)' })
  decline(
    @CurrentUser() user: AuthUser,
    @Param('orderId') orderId: string,
    @Body(new ZodValidationPipe(TraderActionSchema)) dto: z.infer<typeof TraderActionSchema>,
  ) {
    return this.orders.declineByTrader(user.id, orderId, dto.reason);
  }

  @Post(':orderId/confirm')
  @ApiOperation({ summary: 'Confirm deposit received (ASSIGNED -> COMPLETED)' })
  confirm(
    @CurrentUser() user: AuthUser,
    @Param('orderId') orderId: string,
    @Body(new ZodValidationPipe(ConfirmDepositSchema)) dto: z.infer<typeof ConfirmDepositSchema>,
  ) {
    return this.orders.confirmDepositByTrader(user.id, orderId, dto);
  }

  @Post(':orderId/dispute')
  @ApiOperation({ summary: 'Open a dispute on an ASSIGNED order (freezes it for admin review)' })
  dispute(
    @CurrentUser() user: AuthUser,
    @Param('orderId') orderId: string,
    @Body(new ZodValidationPipe(TraderActionSchema)) dto: z.infer<typeof TraderActionSchema>,
  ) {
    return this.orders.openDisputeByTrader(user.id, orderId, dto.reason);
  }

  @Post(':orderId/mark-paid')
  @ApiOperation({ summary: 'Mark withdrawal paid out (ASSIGNED -> COMPLETED)' })
  markPaid(
    @CurrentUser() user: AuthUser,
    @Param('orderId') orderId: string,
    @Body(new ZodValidationPipe(ConfirmDepositSchema)) dto: z.infer<typeof ConfirmDepositSchema>,
  ) {
    return this.orders.markWithdrawalPaidByTrader(user.id, orderId, dto.note);
  }
}
