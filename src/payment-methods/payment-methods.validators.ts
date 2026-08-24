import { BadRequestException } from '@nestjs/common';
import { PaymentMethod } from '@prisma/client';
import { CryptoUtil } from '../common/utils/crypto.util';
import { detectCardBrand } from './payment-methods.constants';

export function luhnValid(cardNumber: string): boolean {
  const digits = cardNumber.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export function normalizeCardNumber(cardNumber: string): string {
  return cardNumber.replace(/\s|-/g, '');
}

export function maskCard(cardNumber: string): { last4: string; masked: string } {
  const digits = normalizeCardNumber(cardNumber);
  return { last4: digits.slice(-4), masked: `**** **** **** ${digits.slice(-4)}` };
}

export function hashCard(cardNumber: string, pepper: string): string {
  return CryptoUtil.sha256(`${pepper}:${normalizeCardNumber(cardNumber)}`);
}

export interface ValidatedCard {
  normalized: string;
  brand: string;
  last4: string;
  masked: string;
  hash: string;
}

export function validateCardOrThrow(cardNumber: string, pepper: string): ValidatedCard {
  const normalized = normalizeCardNumber(cardNumber);
  if (!/^\d{13,19}$/.test(normalized)) {
    throw new BadRequestException('Card number must contain 13-19 digits');
  }
  if (!luhnValid(normalized)) {
    throw new BadRequestException('Card number failed Luhn check');
  }
  const brand = detectCardBrand(normalized);
  const { last4, masked } = maskCard(normalized);
  return { normalized, brand, last4, masked, hash: hashCard(normalized, pepper) };
}

const SBP_PHONE_RE = /^\+7\d{10}$/;

export function validateSbpPhoneOrThrow(phone: string): string {
  const cleaned = phone.replace(/[\s()-]/g, '');
  const normalized = cleaned.startsWith('8') && cleaned.length === 11 ? `+7${cleaned.slice(1)}` : cleaned;
  if (!SBP_PHONE_RE.test(normalized)) {
    throw new BadRequestException('SBP phone must be a valid Russian number in E.164 format (+7XXXXXXXXXX)');
  }
  return normalized;
}

export function assertSupportedMethod(method: string): asserts method is PaymentMethod {
  if (method !== 'CARD' && method !== 'SBP') {
    throw new BadRequestException(`Unsupported payment method "${method}". Only CARD and SBP are allowed`);
  }
}
