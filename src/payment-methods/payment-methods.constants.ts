export const SUPPORTED_METHODS = ['CARD', 'SBP'] as const;

export const SBP_BANKS = [
  'Sberbank',
  'T-Bank',
  'Alpha-Bank',
  'VTB',
  'Raiffeisen',
  'Post Bank',
  'Sovcombank',
  'Ozon Bank',
  'YooMoney',
  'RNKB',
] as const;

export const CARD_BRANDS = ['VISA', 'MASTERCARD', 'MIR'] as const;

export type CardBrand = (typeof CARD_BRANDS)[number];

export function detectCardBrand(cardNumber: string): CardBrand {
  const n = cardNumber.replace(/\D/g, '');
  if (/^4\d{12,18}$/.test(n)) return 'VISA';
  if (/^(5[1-5]\d{14}|2(2[2-9]\d{12}|[3-6]\d{13}|7[01]\d{12}|720\d{12}))$/.test(n)) return 'MASTERCARD';
  if (/^220[0-4]\d{12,15}$/.test(n)) return 'MIR';
  throw new Error(`Unsupported card BIN. Supported brands: ${CARD_BRANDS.join(', ')}`);
}
