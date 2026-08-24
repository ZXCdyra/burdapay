-- Add missing fields to DepositRequest
ALTER TABLE "DepositRequest" ADD COLUMN "adminNote" TEXT;
ALTER TABLE "DepositRequest" ADD COLUMN "processedBy" TEXT;
ALTER TABLE "DepositRequest" ADD COLUMN "processedAt" TIMESTAMPTZ;
