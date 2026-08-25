import { Prisma } from '@prisma/client';

export function getWebhookOrderCandidates(payload: any): string[] {
  const normalize = (value: unknown): string | null => {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    }

    if (typeof value === 'number' || typeof value === 'bigint') {
      return String(value);
    }

    return null;
  };

  const object = payload?.object ?? {};
  const candidates = [
    normalize(object.external_id),
    normalize(object.merchant_order_id),
    normalize(object.id),
    normalize(object.uuid),
  ];

  return [...new Set(candidates.filter((value): value is string => Boolean(value)))];
}

export function getWebhookAmount(payload: any): Prisma.Decimal | null {
  const raw = payload?.object?.amount;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    try {
      return new Prisma.Decimal(raw);
    } catch {
      return null;
    }
  }
  if (typeof raw === 'string') {
    const normalized = raw.trim().replace(/\s+/g, '').replace(',', '.');
    if (!normalized || !/^\d+(\.\d+)?$/.test(normalized)) return null;
    try {
      return new Prisma.Decimal(normalized);
    } catch {
      return null;
    }
  }
  return null;
}

export function getWebhookCurrency(payload: any): string | null {
  const raw = payload?.object?.currency;
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  return raw.trim().toUpperCase();
}
