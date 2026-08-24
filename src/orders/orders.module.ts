import { Module } from '@nestjs/common';
import { OrdersMerchantController } from './orders-merchant.controller';
import { OrdersTraderController } from './orders-trader.controller';
import { OrdersService } from './orders.service';

@Module({
  controllers: [OrdersMerchantController, OrdersTraderController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
