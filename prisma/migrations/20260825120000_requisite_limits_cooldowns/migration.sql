-- Requisite daily limits and cooldowns; order -> requisite link
ALTER TABLE "TraderRequisite" ADD COLUMN     "dailyLimit" DECIMAL(18,2),
ADD COLUMN     "usedToday" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN     "usageDay" TIMESTAMP(3),
ADD COLUMN     "cooldownSec" INTEGER NOT NULL DEFAULT 600,
ADD COLUMN     "cooldownUntil" TIMESTAMP(3);

ALTER TABLE "Order" ADD COLUMN     "requisiteId" TEXT;
