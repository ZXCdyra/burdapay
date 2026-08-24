import { Global, Injectable, Logger, Module, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfig } from '../common/config/app-config.service';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis | null = null;

  constructor(private readonly cfg: AppConfig) {}

  getConnection(): Redis {
    if (!this.client) {
      this.client = new Redis(this.cfg.redisUrl, {
        maxRetriesPerRequest: null,
        lazyConnect: false,
      });
      this.client.on('error', (err) => this.logger.warn(`Redis error: ${err.message}`));
    }
    return this.client;
  }

  async ping(): Promise<boolean> {
    try {
      const result = await this.getConnection().ping();
      return result === 'PONG';
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) await this.client.quit().catch(() => undefined);
  }
}

@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
