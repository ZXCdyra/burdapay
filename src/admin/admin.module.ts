import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { AdminController } from './admin.controller';

@Module({
  imports: [OrdersModule],
  controllers: [AdminController],
})
export class AdminModule {}
