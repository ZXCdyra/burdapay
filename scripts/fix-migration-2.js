#!/usr/bin/env node
/**
 * Apply migration 2_add_deposit_requests that failed in production.
 * Runs raw SQL directly against the database (one statement at a time).
 */
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function run(sql, desc) {
  console.log(`  → ${desc}...`);
  await prisma.$executeRawUnsafe(sql);
  console.log(`  ✓ ${desc}`);
}

async function applyMigration() {
  console.log('Applying migration 2_add_deposit_requests via raw SQL...\n');

  // 1. Enable pgcrypto extension
  await run(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`, 'Enable pgcrypto extension');

  // 2. Add accountId to Merchant (single statement - DO block)
  await run(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'Merchant' AND column_name = 'accountId'
      ) THEN
        ALTER TABLE "Merchant" ADD COLUMN "accountId" text NOT NULL DEFAULT gen_random_uuid();
        CREATE UNIQUE INDEX "Merchant_accountId_key" ON "Merchant" ("accountId");
      END IF;
    END $$;
  `, 'Add accountId to Merchant');

  // 3. Backfill existing Merchant rows
  await run(`
    UPDATE "Merchant" SET "accountId" = gen_random_uuid()
    WHERE "accountId" IS NULL OR "accountId" = '';
  `, 'Backfill Merchant.accountId');

  // 4. Add accountId to Trader
  await run(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'Trader' AND column_name = 'accountId'
      ) THEN
        ALTER TABLE "Trader" ADD COLUMN "accountId" text NOT NULL DEFAULT gen_random_uuid();
        CREATE UNIQUE INDEX "Trader_accountId_key" ON "Trader" ("accountId");
      END IF;
    END $$;
  `, 'Add accountId to Trader');

  // 5. Backfill existing Trader rows
  await run(`
    UPDATE "Trader" SET "accountId" = gen_random_uuid()
    WHERE "accountId" IS NULL OR "accountId" = '';
  `, 'Backfill Trader.accountId');

  // 6. Add accountId to AdminUser
  await run(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'AdminUser' AND column_name = 'accountId'
      ) THEN
        ALTER TABLE "AdminUser" ADD COLUMN "accountId" text NOT NULL DEFAULT gen_random_uuid();
        CREATE UNIQUE INDEX "AdminUser_accountId_key" ON "AdminUser" ("accountId");
      END IF;
    END $$;
  `, 'Add accountId to AdminUser');

  // 7. Backfill existing AdminUser rows
  await run(`
    UPDATE "AdminUser" SET "accountId" = gen_random_uuid()
    WHERE "accountId" IS NULL OR "accountId" = '';
  `, 'Backfill AdminUser.accountId');

  // 8. Create DepositRequest table
  await run(`
    CREATE TABLE IF NOT EXISTS "DepositRequest" (
      "id" text PRIMARY KEY DEFAULT gen_random_uuid(),
      "traderId" text NOT NULL,
      "amount" numeric(18,2) NOT NULL,
      "currency" text NOT NULL DEFAULT 'USD',
      "address" text NOT NULL,
      "txHash" text,
      "status" text NOT NULL DEFAULT 'PENDING',
      "createdAt" timestamptz NOT NULL DEFAULT now()
    );
  `, 'Create DepositRequest table');

  // 9. Add FK constraint
  await run(`
    DO $$ BEGIN
      ALTER TABLE "DepositRequest"
        ADD CONSTRAINT "DepositRequest_trader_fkey"
        FOREIGN KEY ("traderId") REFERENCES "Trader" ("id") ON DELETE CASCADE;
    EXCEPTION WHEN duplicate_object THEN null;
    END $$;
  `, 'Add DepositRequest FK');

  // 10. Add indexes
  await run(`
    CREATE INDEX IF NOT EXISTS "DepositRequest_trader_idx" ON "DepositRequest" ("traderId");
  `, 'Create DepositRequest_trader_idx');

  await run(`
    CREATE INDEX IF NOT EXISTS "DepositRequest_trader_status_idx" ON "DepositRequest" ("traderId", "status");
  `, 'Create DepositRequest_trader_status_idx');

  // 11. Mark migration as applied in Prisma's table
  await run(`
    INSERT INTO "_prisma_migrations" ("checksum", "finished_at", "migration_name", "logs", "rolled_back", "started_at", "draft")
    VALUES (md5(random()::text), NOW(), '2_add_deposit_requests', NULL, FALSE, NOW(), FALSE)
    ON CONFLICT ("migration_name") DO NOTHING;
  `, 'Mark migration as applied');

  console.log('\nMigration applied successfully!');
}

applyMigration()
  .then(() => console.log('Done'))
  .catch((e) => {
    console.error('Error:', e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
