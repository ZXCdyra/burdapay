import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import configuration from './common/config/configuration';
import { AppConfig } from './common/config/app-config.service';
import { CommonModule } from './common/common.module';
import { AuthModule } from './auth/auth.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { QueuesModule } from './queues/queue.service';
import { EventsModule } from './websocket/events.module';
import { AntifraudModule } from './antifraud/antifraud.module';
import { RoutingModule } from './routing/routing.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { PaymentMethodsModule } from './payment-methods/payment-methods.module';
import { OrdersModule } from './orders/orders.module';
import { MerchantsModule } from './merchants/merchants.module';
import { TradersModule } from './traders/traders.module';
import { AdminModule } from './admin/admin.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    ThrottlerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (cfg: AppConfig) => ({
        throttlers: [{ name: 'default', ttl: cfg.throttleTtlMs, limit: cfg.throttleLimit }],
      }),
    }),
    CommonModule,
    PrismaModule,
    RedisModule,
    QueuesModule,
    EventsModule,
    AuthModule,
    AntifraudModule,
    RoutingModule,
    WebhooksModule,
    PaymentMethodsModule,
    OrdersModule,
    MerchantsModule,
    TradersModule,
    AdminModule,
    HealthModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
