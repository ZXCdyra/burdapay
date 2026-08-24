-- Add missing trader limit fields
ALTER TABLE "Trader" ADD COLUMN "dealsPerDay" integer NOT NULL DEFAULT 100;
ALTER TABLE "Trader" ADD COLUMN "dealCooldownSeconds" integer NOT NULL DEFAULT 30;
