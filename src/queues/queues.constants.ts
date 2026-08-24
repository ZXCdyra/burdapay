export const QUEUES = {
  ORDER_EXPIRY: 'order-expiry',
  WEBHOOK_DELIVERY: 'webhook-delivery',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface OrderExpiryJobData {
  orderId: string;
}

export interface WebhookDeliveryJobData {
  merchantId: string;
  event: string;
  payload: Record<string, unknown>;
}
