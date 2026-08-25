const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const traders = await prisma.trader.findMany({
    select: {
      id: true,
      displayName: true,
      isOnline: true,
      status: true,
      methodCard: true,
      methodSbp: true,
      minOrderAmount: true,
      maxOrderAmount: true,
      lockedOrders: true,
      maxConcurrentOrders: true,
    },
  });
  console.log(JSON.stringify(traders, null, 2));
}

main()
  .catch((e) => {
    console.error('Query failed:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
