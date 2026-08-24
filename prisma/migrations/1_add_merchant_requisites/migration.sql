-- CreateTable
CREATE TABLE "MerchantRequisite" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "traderRequisiteId" TEXT NOT NULL,
    "traderId" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "label" TEXT,
    "bankName" TEXT NOT NULL,
    "receiverName" TEXT NOT NULL,
    "cardLast4" TEXT,
    "sbpPhone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MerchantRequisite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MerchantRequisite_merchantId_traderId_idx" ON "MerchantRequisite"("merchantId", "traderId");

-- CreateIndex
CREATE INDEX "MerchantRequisite_traderRequisiteId_idx" ON "MerchantRequisite"("traderRequisiteId");

-- AddForeignKey
ALTER TABLE "MerchantRequisite" ADD CONSTRAINT "MerchantRequisite_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantRequisite" ADD CONSTRAINT "MerchantRequisite_traderId_fkey" FOREIGN KEY ("traderId") REFERENCES "Trader"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantRequisite" ADD CONSTRAINT "MerchantRequisite_traderRequisiteId_fkey" FOREIGN KEY ("traderRequisiteId") REFERENCES "TraderRequisite"("id") ON DELETE CASCADE ON UPDATE CASCADE;
