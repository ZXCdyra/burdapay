import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16),
  JWT_TTL: z.string().default('12h'),
  APP_ENCRYPTION_KEY: z.string().min(16),
  CARD_HASH_PEPPER: z.string().min(8),
  DEFAULT_ORDER_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  WEBHOOK_ATTEMPTS: z.coerce.number().int().positive().default(5),
  WEBHOOK_BACKOFF_BASE_SECONDS: z.coerce.number().int().positive().default(30),
  AF_WINDOW_SECONDS: z.coerce.number().int().positive().default(600),
  AF_MAX_PER_IP: z.coerce.number().int().positive().default(10),
  AF_MAX_PER_DEVICE: z.coerce.number().int().positive().default(15),
  CORS_ORIGIN: z.string().default('*'),
  THROTTLE_TTL_MILLISECONDS: z.coerce.number().int().positive().default(60000),
  THROTTLE_LIMIT: z.coerce.number().int().positive().default(120),
  PRISMA_CONNECT_RETRIES: z.coerce.number().int().positive().default(10),
  PAYMENTS_GATE_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export default function configuration(): Env {
  return envSchema.parse(process.env);
}
