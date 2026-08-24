/* Create accountId columns and DepositRequest table */
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

ALTER TABLE "Merchant" ADD COLUMN IF NOT EXISTS "accountId" text NOT NULL DEFAULT gen_random_uuid();
DO $$ BEGIN
    BEGIN
        CREATE UNIQUE INDEX "Merchant_accountId_key" ON "Merchant" ("accountId");
    EXCEPTION WHEN duplicate_table THEN NULL; END;
END $$;

ALTER TABLE "Trader" ADD COLUMN IF NOT EXISTS "accountId" text NOT NULL DEFAULT gen_random_uuid();
DO $$ BEGIN
    BEGIN
        CREATE UNIQUE INDEX "Trader_accountId_key" ON "Trader" ("accountId");
    EXCEPTION WHEN duplicate_table THEN NULL; END;
END $$;

ALTER TABLE "AdminUser" ADD COLUMN IF NOT EXISTS "accountId" text NOT NULL DEFAULT gen_random_uuid();
DO $$ BEGIN
    BEGIN
        CREATE UNIQUE INDEX "AdminUser_accountId_key" ON "AdminUser" ("accountId");
    EXCEPTION WHEN duplicate_table THEN NULL; END;
END $$;

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

ALTER TABLE "DepositRequest" ADD CONSTRAINT IF NOT EXISTS "DepositRequest_trader_fkey" FOREIGN KEY ("traderId") REFERENCES "Trader" ("id") ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS "DepositRequest_trader_idx" ON "DepositRequest" ("traderId");
CREATE INDEX IF NOT EXISTS "DepositRequest_trader_status_idx" ON "DepositRequest" ("traderId", "status");
