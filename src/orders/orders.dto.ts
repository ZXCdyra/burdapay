import { z } from 'zod';

export const PaymentMethodSchema = z.enum(['CARD', 'SBP']);

const baseFields = {
  amount: z.number().positive().max(10000000),
  currency: z.string().length(3).toUpperCase().default('RUB'),
  externalId: z.string().min(1).max(128).optional(),
  description: z.string().max(500).optional(),
  metadata: z.record(z.unknown()).optional(),
};

export const CreateDepositSchema = z.object({
  type: z.literal('DEPOSIT'),
  method: PaymentMethodSchema,
  idempotencyKey: z.string().min(8).max(128),
  ...baseFields,
  payer: z
    .object({
      cardNumber: z.string().regex(/^\d{13,19}$/).optional(),
      phone: z.string().max(32).optional(),
    })
    .optional(),
});

export const WithdrawalRequisitesSchema = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('CARD'),
    cardNumber: z.string().min(13).max(25),
    receiverName: z.string().min(2).max(120),
  }),
  z.object({
    method: z.literal('SBP'),
    phone: z.string().min(10).max(20),
    bankName: z.string().min(2).max(60),
    receiverName: z.string().min(2).max(120),
  }),
]);

export const CreateWithdrawalSchema = z.object({
  type: z.literal('WITHDRAWAL'),
  method: PaymentMethodSchema,
  idempotencyKey: z.string().min(8).max(128),
  ...baseFields,
  requisites: WithdrawalRequisitesSchema,
});

export const CreateOrderSchema = z.discriminatedUnion('type', [
  CreateDepositSchema,
  CreateWithdrawalSchema,
]);

export const ConfirmDepositSchema = z.object({
  payerName: z.string().max(120).optional(),
  note: z.string().max(500).optional(),
});

export const TraderActionSchema = z.object({
  reason: z.string().max(500).optional(),
});

export type CreateDepositDto = z.infer<typeof CreateDepositSchema>;
export type CreateWithdrawalDto = z.infer<typeof CreateWithdrawalSchema>;
export type CreateOrderDto = z.infer<typeof CreateOrderSchema>;
export type ConfirmDepositDto = z.infer<typeof ConfirmDepositSchema>;
export type TraderActionDto = z.infer<typeof TraderActionSchema>;

export interface RequestMeta {
  ip?: string;
  deviceId?: string;
}
