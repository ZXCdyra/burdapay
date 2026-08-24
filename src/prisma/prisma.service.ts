import { Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AppConfig } from '../common/config/app-config.service';

@Injectable()
export class PrismaService extends PrismaClient {
  private readonly logger = new Logger(PrismaService.name);

  constructor(private readonly cfg: AppConfig) {
    super();
  }

  async onModuleInit(): Promise<void> {
    const maxAttempts = this.cfg.isProd ? this.cfg.prismaConnectRetries : 1;
    let connected = false;

    for (let attempt = 1; attempt <= maxAttempts && !connected; attempt++) {
      try {
        await this.$connect();
        connected = true;
        this.logger.log('Database connected');
      } catch (e) {
        const delay = Math.min(attempt * 2000, 10000);
        this.logger.warn(
          `DB connect attempt ${attempt}/${maxAttempts} failed: ${(e as Error).message}. Retrying in ${delay}ms`,
        );
        if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, delay));
      }
    }

    if (!connected) {
      const message = 'Could not connect to database after multiple attempts';
      if (this.cfg.isProd) throw new Error(message);
      this.logger.warn(`${message}; continuing in development mode`);
    }
  }
}
