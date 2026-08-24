import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from './configuration';

@Injectable()
export class AppConfig {
  private readonly logger = new Logger(AppConfig.name);

  constructor(private cs: ConfigService<Env, true>) {}

  private getEnv<K extends keyof Env>(key: K): Env[K] {
    const val = this.cs.get(key, { infer: true });
    if (val === undefined || val === null) {
      this.logger.fatal(`FATAL: Environment variable "${String(key)}" is not set. Application cannot start.`);
      process.exit(1);
    }
    return val;
  }

  get nodeEnv(): string {
    return this.getEnv('NODE_ENV');
  }
  get isProd(): boolean {
    return this.nodeEnv === 'production';
  }
  get port(): number {
    return this.getEnv('PORT');
  }
  get redisUrl(): string {
    return this.getEnv('REDIS_URL');
  }
  get jwtSecret(): string {
    return this.getEnv('JWT_SECRET');
  }
  get jwtTtl(): string {
    return this.getEnv('JWT_TTL');
  }
  get encryptionKey(): string {
    return this.getEnv('APP_ENCRYPTION_KEY');
  }
  get cardPepper(): string {
    return this.getEnv('CARD_HASH_PEPPER');
  }
  get orderTtlSeconds(): number {
    return this.getEnv('DEFAULT_ORDER_TTL_SECONDS');
  }
  get webhookAttempts(): number {
    return this.getEnv('WEBHOOK_ATTEMPTS');
  }
  get webhookBackoffSeconds(): number {
    return this.getEnv('WEBHOOK_BACKOFF_BASE_SECONDS');
  }
  get afWindowSeconds(): number {
    return this.getEnv('AF_WINDOW_SECONDS');
  }
  get afMaxPerIp(): number {
    return this.getEnv('AF_MAX_PER_IP');
  }
  get afMaxPerDevice(): number {
    return this.getEnv('AF_MAX_PER_DEVICE');
  }
  get corsOrigin(): string {
    return this.getEnv('CORS_ORIGIN');
  }
  get throttleTtlMs(): number {
    return this.getEnv('THROTTLE_TTL_MILLISECONDS');
  }
  get throttleLimit(): number {
    return this.getEnv('THROTTLE_LIMIT');
  }
  get prismaConnectRetries(): number {
    return this.getEnv('PRISMA_CONNECT_RETRIES');
  }
  get paymentsGateSecret(): string | null {
    return this.cs.get('PAYMENTS_GATE_SECRET', { infer: true }) ?? null;
  }
  get webhookMerchantRegisterSecret(): string {
    return this.getEnv('WEBHOOK_MERCHANT_REGISTER_SECRET');
  }
}
