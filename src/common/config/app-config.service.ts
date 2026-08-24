import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from './configuration';

@Injectable()
export class AppConfig {
  constructor(private cs: ConfigService<Env, true>) {}

  get nodeEnv(): string {
    return this.cs.get('NODE_ENV', { infer: true });
  }
  get isProd(): boolean {
    return this.nodeEnv === 'production';
  }
  get port(): number {
    return this.cs.get('PORT', { infer: true });
  }
  get redisUrl(): string {
    return this.cs.get('REDIS_URL', { infer: true });
  }
  get jwtSecret(): string {
    return this.cs.get('JWT_SECRET', { infer: true });
  }
  get jwtTtl(): string {
    return this.cs.get('JWT_TTL', { infer: true });
  }
  get encryptionKey(): string {
    return this.cs.get('APP_ENCRYPTION_KEY', { infer: true });
  }
  get cardPepper(): string {
    return this.cs.get('CARD_HASH_PEPPER', { infer: true });
  }
  get orderTtlSeconds(): number {
    return this.cs.get('DEFAULT_ORDER_TTL_SECONDS', { infer: true });
  }
  get webhookAttempts(): number {
    return this.cs.get('WEBHOOK_ATTEMPTS', { infer: true });
  }
  get webhookBackoffSeconds(): number {
    return this.cs.get('WEBHOOK_BACKOFF_BASE_SECONDS', { infer: true });
  }
  get afWindowSeconds(): number {
    return this.cs.get('AF_WINDOW_SECONDS', { infer: true });
  }
  get afMaxPerIp(): number {
    return this.cs.get('AF_MAX_PER_IP', { infer: true });
  }
  get afMaxPerDevice(): number {
    return this.cs.get('AF_MAX_PER_DEVICE', { infer: true });
  }
  get corsOrigin(): string {
    return this.cs.get('CORS_ORIGIN', { infer: true });
  }
  get throttleTtlMs(): number {
    return this.cs.get('THROTTLE_TTL_MILLISECONDS', { infer: true });
  }
  get throttleLimit(): number {
    return this.cs.get('THROTTLE_LIMIT', { infer: true });
  }
  get prismaConnectRetries(): number {
    return this.cs.get('PRISMA_CONNECT_RETRIES', { infer: true });
  }
}
