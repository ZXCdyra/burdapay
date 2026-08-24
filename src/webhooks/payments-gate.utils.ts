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
