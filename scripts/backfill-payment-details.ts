import { PrismaClient, OrderType, PaymentMethod } from '@prisma/client';
import * as CryptoUtil from '../src/common/utils/crypto.util';
import { ConfigModule, ConfigService } from '@nestjs/config';

const prisma = new PrismaClient();

async function main() {
  await ConfigModule.forRoot({ isGlobal: true }).done();
  const cfg = new ConfigService();
  const encKey = cfg.get('ENCRYPTION_KEY');

  console.log('🔍 Finding DEPOSIT orders without paymentDetails...');
  const orders = await prisma.order.findMany({
    where: { type: OrderType.DEPOSIT, paymentDetails: null as any },
    include: { traderRequisites: true },
  });

  console.log(`Found ${orders.length} orders`);

  for (const order of orders) {
    console.log(`  Processing order ${order.id} (traderId: ${order.traderId})`);

    // Try to get requisite from requisiteId first
    let requisite = null;
    if (order.requisiteId) {
      requisite = await prisma.traderRequisite.findUnique({ where: { id: order.requisiteId } });
    }

    // Fallback: find active requisite for this trader
    if (!requisite) {
      const requisites = await prisma.traderRequisite.findMany({
        where: { traderId: order.traderId, isActive: true },
        take: 1,
      });
      if (requisites.length > 0) requisite = requisites[0];
    }

    if (!requisite) {
      console.log(`    ⚠️ No requisite found for trader ${order.traderId}, skipping`);
      continue;
    }

    const refCode = `PF-${order.id.slice(-8).toUpperCase()}`;
    let paymentDetails: any;

    if (requisite.method === PaymentMethod.CARD) {
      let fullCard: string | null = null;
      if (requisite.cardNumberEncrypted) {
        try {
          fullCard = CryptoUtil.default.decrypt(requisite.cardNumberEncrypted, encKey);
        } catch {}
      }
      paymentDetails = {
        method: 'CARD',
        bank: requisite.bankName,
        receiver: requisite.receiverName,
        cardNumber: fullCard,
        cardLast4: requisite.cardLast4,
        amount: order.amount.toFixed(2),
        comment: refCode,
      };
    } else {
      paymentDetails = {
        method: 'SBP',
        bank: requisite.bankName,
        receiver: requisite.receiverName,
        phone: requisite.sbpPhone,
        amount: order.amount.toFixed(2),
        comment: refCode,
      };
    }

    await prisma.order.update({
      where: { id: order.id },
      data: { paymentDetails },
    });

    console.log(`    ✅ Updated with method=${requisite.method}, bank=${requisite.bankName}`);
  }

  console.log('\n✅ Done! Backfilled paymentDetails for all affected orders.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
