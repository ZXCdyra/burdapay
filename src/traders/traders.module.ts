import { Module } from '@nestjs/common';
import { TradersController } from './traders.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { CommonModule } from '../common/common.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { EventsModule } from '../websocket/events.module';

@Module({
  imports: [PrismaModule, CommonModule, WebhooksModule, EventsModule],
  controllers: [TradersController],
})
export class TradersModule {}
