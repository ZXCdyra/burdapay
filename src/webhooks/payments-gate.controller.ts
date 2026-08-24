import { Body, Controller, Headers, Post, Req, Res, HttpCode, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfig } from '../common/config/app-config.service';
import { CryptoUtil } from '../common/utils/crypto.util';
import { OrdersService } from '../orders/orders.service';
import { getWebhookOrderCandidates } from './payments-gate.utils';

@Controller(['payments-gate', 'api/webhooks'])
export class PaymentsGateController {
  private readonly logger = new Logger(PaymentsGateController.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: AppConfig,
    private readonly orders: OrdersService,
  ) {}

  @Post('webhook')
  @HttpCode(200)
  async handleWebhook(@Req() req: Request, @Res() res: Response) {
    return this.handleIncomingWebhook(req, res);
  }

  @Post()
  @HttpCode(200)
  async handleRootWebhook(@Req() req: Request, @Res() res: Response) {
    return this.handleIncomingWebhook(req, res);
  }

  private async handleIncomingWebhook(req: Request, res: Response) {
    const raw = (req as any).rawBody || '';
    const body = typeof raw === 'string' ? raw : raw.toString('utf8');
    const headerTs = req.header('X-Major-Timestamp') || req.header('x-major-timestamp');
    const headerSig = req.header('X-Major-Signature') || req.header('x-major-signature');
    if (!headerTs || !headerSig) {
      this.logger.warn('Missing signature headers');
      return res.status(401).send('Missing signature');
    }

    let payload: any;
    try { payload = JSON.parse(body); } catch (e) { this.logger.warn('Invalid JSON payload'); return res.status(400).send('Invalid JSON'); }

    const txId = payload?.object?.uuid ?? '';
    const externalId = payload?.object?.external_id ?? null;
    const orderMatchCandidates = getWebhookOrderCandidates(payload);
    const webhookSecretKey = payload?.secret_key ?? null;

    // Timestamp tolerance: 5 minutes
    const ts = headerTs.toString();
    const tsNum = parseInt(ts, 10);
    const now = Math.floor(Date.now() / 1000);
    if (isNaN(tsNum) || Math.abs(now - tsNum) > 300) {
      this.logger.warn(`Timestamp out of range: ts=${ts}, now=${now}`);
      return res.status(401).send('Invalid timestamp');
    }

    // Build secret candidates
    const globalSecret = this.cfg.paymentsGateSecret || null;
    const candidates: string[] = [];
    if (globalSecret) candidates.push(globalSecret);
    if (webhookSecretKey) candidates.push(webhookSecretKey);

    // Try to resolve order to get merchant secret using any known order id variant.
    if (!candidates.length && orderMatchCandidates.length > 0) {
      try {
        const order = await this.prisma.order.findFirst({
          where: { OR: orderMatchCandidates.map((merchantOrderId) => ({ merchantOrderId })) },
          include: { merchant: true },
        });
        if (order?.merchant?.callbackSecretEncrypted) {
          try {
            const s = CryptoUtil.decrypt(order.merchant.callbackSecretEncrypted, this.cfg.encryptionKey);
            candidates.push(s);
          } catch (e) {
            this.logger.warn('Cannot decrypt merchant callback secret');
          }
        }
      } catch (e) {
        this.logger.warn(`Cannot resolve merchant secret by order ids ${orderMatchCandidates.join(', ')}`);
      }
    }

    // verify signature: expected = hmac_sha256(secret, `${timestamp}.${txId}.${rawBody}`)
    const sig = headerSig.toString();
    const dataToSign = `${ts}.${txId}.${body}`;
    let ok = false;
    for (const secret of candidates) {
      try {
        const expected = CryptoUtil.hmacSha256Hex(secret, dataToSign);
        if (CryptoUtil.timingSafeEqual(expected, sig)) { ok = true; break; }
      } catch {}
    }
    if (!ok) {
      this.logger.warn('Invalid signature for payments-gate webhook');
      return res.status(401).send('Invalid signature');
    }

    const order = orderMatchCandidates.length > 0
      ? await this.prisma.order.findFirst({
          where: { OR: orderMatchCandidates.map((merchantOrderId) => ({ merchantOrderId })) },
        })
      : null;

    if (!order) {
      this.logger.warn(`Order not found for payment-gate webhook. external_id=${externalId || 'n/a'}, uuid=${txId || 'n/a'}, candidates=${orderMatchCandidates.join(', ') || 'none'}`);
      return res.status(200).json({ ok: true, matched: false, reason: 'ORDER_NOT_FOUND' });
    }

    const eventType = payload?.type || '';
    const status = (payload?.object?.status || '').toUpperCase();
    try {
      if (eventType === 'payment.success' || status === 'PAID' || status === 'SETTLED' || status === 'SUCCESS') {
        await this.orders.adminResolve(order.id, 'complete', 'payments-gate');
      } else if (eventType === 'payment.failed' || eventType === 'payment.cancelled' ||
                 status === 'FAILED' || status === 'CANCELLED' || status === 'REVOKED') {
        await this.orders.adminResolve(order.id, 'cancel', 'payments-gate', `external status ${status}`);
      } else if (status) {
        this.logger.log(`Ignored unknown status ${status} for order ${order.id}`);
      }
    } catch (e) {
      this.logger.error('Failed to resolve order from payments-gate webhook: ' + (e as Error).message);
      return res.status(500).send('error');
    }

    return res.status(200).send('ok');
  }
}
