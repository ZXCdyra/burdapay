#!/usr/bin/env node
const { PrismaClient } = require('@prisma/client');
const { randomUUID } = require('crypto');

const prisma = new PrismaClient();

async function main() {
  console.log('Starting backfill of accountId for Merchant, Trader, AdminUser');
  const models = [
    { name: 'Merchant', client: prisma.merchant },
    { name: 'Trader', client: prisma.trader },
    { name: 'AdminUser', client: prisma.adminUser },
  ];

  for (const m of models) {
    try {
      // find records that have null or empty accountId (defensive)
      const rows = await m.client.findMany({ where: { OR: [{ accountId: null }, { accountId: '' }] }, select: { id: true } });
      console.log(`${m.name}: found ${rows.length} rows to backfill`);
      for (const r of rows) {
        await m.client.update({ where: { id: r.id }, data: { accountId: randomUUID() } });
      }
    } catch (err) {
      console.warn(`Skipping ${m.name}:`, err.message);
    }
  }

  console.log('Backfill complete');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
