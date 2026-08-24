import * as bcrypt from 'bcryptjs';
import { PrismaClient, PaymentMethod } from '@prisma/client';
import * as crypto from 'crypto';

function loadDotEnv(): void {
  const fs = require('fs');
  const path = require('path');
  const envPath = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

function aesEncrypt(plain: string, secret: string): string {
  const key = crypto.createHash('sha256').update(secret).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

function randomHex(n: number): string {
  return crypto.randomBytes(n).toString('hex');
}

async function main(): Promise<void> {
  loadDotEnv();
  const prisma = new PrismaClient();
  const encKey = process.env.APP_ENCRYPTION_KEY || 'dev-only-encryption-key-change-me';

  const admin = await prisma.adminUser.upsert({
    where: { email: 'admin@payflow.io' },
    update: {},
    create: {
      email: 'admin@payflow.io',
      passwordHash: await bcrypt.hash('ChangeMe_Admin123', 10),
      name: 'Platform Admin',
    },
  });

  let merchantKeyPlain = '';
  const merchant = await prisma.merchant.upsert({
    where: { email: 'merchant@demo-casino.io' },
    update: {},
    create: {
      name: 'Demo Casino',
      email: 'merchant@demo-casino.io',
      passwordHash: await bcrypt.hash('ChangeMe_Merchant123', 10),
      status: 'ACTIVE',
      feePercent: 3.0,
      webhookUrl: 'http://localhost:4000/mock-callback',
      callbackSecretEncrypted: aesEncrypt(randomHex(32), encKey),
    },
  });
  const existingKey = await prisma.apiKey.findFirst({ where: { merchantId: merchant.id } });
  if (!existingKey) {
    const pk = `pk_${randomHex(16)}`;
    const sk = `sk_${randomHex(32)}`;
    merchantKeyPlain = sk;
    await prisma.apiKey.create({
      data: {
        merchantId: merchant.id,
        name: 'default',
        publicKey: pk,
        secretEncrypted: aesEncrypt(sk, encKey),
        secretPrefix: sk.slice(0, 8) + '...',
      },
    });
  }

  const traderSeeds = [
    {
      email: 'trader1@demo.io',
      displayName: 'Trader One',
      requisites: [
        {
          method: 'CARD' as PaymentMethod,
          bankName: 'Sberbank',
          receiverName: 'IVAN IVANOV',
          cardNumberEncrypted: aesEncrypt('4242424242424242', encKey),
          cardLast4: '4242',
        },
        {
          method: 'SBP' as PaymentMethod,
          bankName: 'T-Bank',
          receiverName: 'IVAN IVANOV',
          sbpPhone: '+79001234567',
        },
      ],
    },
    {
      email: 'trader2@demo.io',
      displayName: 'Trader Two',
      requisites: [
        {
          method: 'CARD' as PaymentMethod,
          bankName: 'Alpha-Bank',
          receiverName: 'PETR PETROV',
          cardNumberEncrypted: aesEncrypt('5536913899999999', encKey),
          cardLast4: '9999',
        },
      ],
    },
  ];

  const traderPasswords: Record<string, string> = {};
  for (const t of traderSeeds) {
    const trader = await prisma.trader.upsert({
      where: { email: t.email },
      update: {},
      create: {
        email: t.email,
        passwordHash: await bcrypt.hash('ChangeMe_Trader123', 10),
        displayName: t.displayName,
        status: 'ACTIVE',
        isOnline: true,
      },
    });
    traderPasswords[t.email] = 'ChangeMe_Trader123';
    for (const r of t.requisites) {
      const exists = await prisma.traderRequisite.findFirst({
        where: { traderId: trader.id, method: r.method, isActive: true },
      });
      if (!exists) {
        await prisma.traderRequisite.create({ data: { traderId: trader.id, ...r } });
      }
    }
  }

  console.log('==================== SEED COMPLETE ====================');
  console.log(`Admin   : ${admin.email} / ChangeMe_Admin123`);
  console.log(`Merchant: ${merchant.email} / ChangeMe_Merchant123`);
  if (merchantKeyPlain) {
    console.log(`Merchant API Key (shown ONCE): ${merchantKeyPlain}`);
    const createdKey = await prisma.apiKey.findFirst({ where: { merchantId: merchant.id } });
    console.log(`Merchant API public key      : ${createdKey?.publicKey}`);
  }
  for (const [email, pass] of Object.entries(traderPasswords)) {
    console.log(`Trader  : ${email} / ${pass}`);
  }
  console.log('=======================================================');

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
