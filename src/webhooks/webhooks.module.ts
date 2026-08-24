import { Global, Module } from '@nestjs/common';
import { WebhooksService } from './webhooks.service';
import { PaymentsGateController } from './payments-gate.controller';
import { OrdersModule } from '../orders/orders.module';

@Global()
@Module({
  providers: [WebhooksService],
  controllers: [PaymentsGateController],
  imports: [OrdersModule],
  exports: [WebhooksService],
})
export class WebhooksModule {}
