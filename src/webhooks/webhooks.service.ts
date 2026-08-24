import { Injectable, Logger } from '@nestjs/common';
import { OnModuleInit } from '@nestjs/common';
import { Job } from 'bullmq';
import { Prisma, WebhookStatus } from '@prisma/client';
import { AppConfig } from '../common/config/app-config.service';
import { CryptoUtil } from '../common/utils/crypto.util';
import { HmacUtil } from '../common/utils/hmac.util';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queues/queue.service';
import { QUEUES, WebhookDeliveryJobData } from '../queues/queues.constants';

export type WebhookEvent =
  | 'order.created'
  | 'order.assigned'
  | 'order.completed'
  | 'order.expired'
  | 'order.cancelled'
  | 'order.failed';
  
// allow trader-related events
export type ExtendedWebhookEvent = WebhookEvent | 'trader.requisite.created';

@Injectable()
export class WebhooksService implements OnModuleInit {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueService,
    private readonly cfg: AppConfig,
  ) {}

  onModuleInit(): void {
    this.queues.registerProcessor(QUEUES.WEBHOOK_DELIVERY, (job) => this.deliver(job));
  }

  buildOrderPayload(event: WebhookEvent, order: {
    id: string;
    merchantOrderId: string | null;
    type: string;
    method: string;
    status: string;
    amount: Prisma.Decimal;
    currency: string;
    feeMerchant: Prisma.Decimal;
    completedAt: Date | null;
    cancelledAt: Date | null;
  }): Record<string, unknown> {
    return {
      event,
      orderId: order.id,
      merchantOrderId: order.merchantOrderId,
      type: order.type,
      method: order.method,
      status: order.status,
      amount: order.amount.toFixed(2),
      currency: order.currency,
      fee: order.feeMerchant.toFixed(2),
      completedAt: order.completedAt?.toISOString() ?? null,
      cancelledAt: order.cancelledAt?.toISOString() ?? null,
      timestamp: new Date().toISOString(),
    };
  }

  async dispatch(event: ExtendedWebhookEvent, payload: Record<string, unknown>, merchantId: string): Promise<void> {
    const merchant = await this.prisma.merchant.findUnique({ where: { id: merchantId } });
    if (!merchant?.webhookUrl) return;
    await this.queues.enqueueWebhook({ merchantId, event, payload });
  }

  async deliver(job: Job<WebhookDeliveryJobData>): Promise<void> {
    const { merchantId, event, payload } = job.data;
    const merchant = await this.prisma.merchant.findUnique({ where: { id: merchantId } });
    if (!merchant || !merchant.webhookUrl) return;

    const url = merchant.webhookUrl;
    const body = JSON.stringify(payload);
    let secret: string;
    try {
      secret = CryptoUtil.decrypt(merchant.callbackSecretEncrypted, this.cfg.encryptionKey);
    } catch {
      this.logger.error(`Cannot decrypt callback secret for merchant ${merchantId}`);
      return;
    }

    const signature = HmacUtil.buildSignatureHeader(secret, body);
    const attempt = (job.attemptsMade ?? 0) + 1;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Payflow-Signature': signature,
          'X-Payflow-Event': event,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });

      await this.prisma.webhookDelivery.create({
        data: {
          merchantId,
          orderId: (payload['orderId'] as string | undefined) ?? null,
          event,
          url,
          attempt,
          responseCode: res.status,
          status: res.ok ? WebhookStatus.SUCCESS : WebhookStatus.FAILED,
          error: res.ok ? null : `HTTP ${res.status}`,
          payload: payload as Prisma.InputJsonValue,
        },
      });

      if (!res.ok) throw new Error(`Webhook endpoint responded with HTTP ${res.status}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.prisma.webhookDelivery
        .create({
          data: {
            merchantId,
            orderId: (payload['orderId'] as string | undefined) ?? null,
            event,
            url,
            attempt,
            status: WebhookStatus.FAILED,
            error: message.slice(0, 500),
            payload: payload as Prisma.InputJsonValue,
          },
        })
        .catch(() => undefined);
      throw err;
    }
  }
}
