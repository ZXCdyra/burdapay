import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WebhooksService } from './webhooks.service';
import { PaymentsGateController } from './payments-gate.controller';
import { WebhookMerchantController } from './webhook-merchant.controller';
import { OrdersModule } from '../orders/orders.module';

@Global()
@Module({
  providers: [WebhooksService],
  controllers: [PaymentsGateController, WebhookMerchantController],
  imports: [OrdersModule, AuthModule],
  exports: [WebhooksService],
})
export class WebhooksModule {}
