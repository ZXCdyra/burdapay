import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from './configuration';

@Injectable()
export class AppConfig {
  private readonly logger = new Logger(AppConfig.name);

  constructor(private cs: ConfigService<Env, true>) {}

  private getOrDie<K extends keyof Env>(key: K): Env[K] {
    const val = this.cs.get(key, { infer: true });
    if (!val && val !== 0) {
      this.logger.fatal(`FATAL: Environment variable "${String(key)}" is not set. Application cannot start.`);
      process.exit(1);
    }
    return val;
  }

  get nodeEnv(): string {
    return this.getOrDie('NODE_ENV') as string;
  }
  get isProd(): boolean {
    return this.nodeEnv === 'production';
  }
  get port(): number {
    return this.getOrDie('PORT') as number;
  }
  get redisUrl(): string {
    return this.getOrDie('REDIS_URL') as string;
  }
  get jwtSecret(): string {
    return this.getOrDie('JWT_SECRET') as string;
  }
  get jwtTtl(): string {
    return this.getOrDie('JWT_TTL') as string;
  }
  get encryptionKey(): string {
    return this.getOrDie('APP_ENCRYPTION_KEY') as string;
  }
  get cardPepper(): string {
    return this.getOrDie('CARD_HASH_PEPPER') as string;
  }
  get orderTtlSeconds(): number {
    return this.getOrDie('DEFAULT_ORDER_TTL_SECONDS') as number;
  }
  get webhookAttempts(): number {
    return this.getOrDie('WEBHOOK_ATTEMPTS') as number;
  }
  get webhookBackoffSeconds(): number {
    return this.getOrDie('WEBHOOK_BACKOFF_BASE_SECONDS') as number;
  }
  get afWindowSeconds(): number {
    return this.getOrDie('AF_WINDOW_SECONDS') as number;
  }
  get afMaxPerIp(): number {
    return this.getOrDie('AF_MAX_PER_IP') as number;
  }
  get afMaxPerDevice(): number {
    return this.getOrDie('AF_MAX_PER_DEVICE') as number;
  }
  get corsOrigin(): string {
    return this.getOrDie('CORS_ORIGIN') as string;
  }
  get throttleTtlMs(): number {
    return this.getOrDie('THROTTLE_TTL_MILLISECONDS') as number;
  }
  get throttleLimit(): number {
    return this.getOrDie('THROTTLE_LIMIT') as number;
  }
  get prismaConnectRetries(): number {
    return this.getOrDie('PRISMA_CONNECT_RETRIES') as number;
  }
  get paymentsGateSecret(): string | null {
    return this.cs.get('PAYMENTS_GATE_SECRET', { infer: true }) ?? null;
  }
}
