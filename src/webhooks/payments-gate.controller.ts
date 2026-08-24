import { Body, Controller, Headers, Post, Req, Res, HttpCode, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfig } from '../common/config/app-config.service';
import { CryptoUtil } from '../common/utils/crypto.util';
import { OrdersService } from '../orders/orders.service';

@Controller('payments-gate')
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

    // Determine secret: prefer configured PAYMENTS_GATE_SECRET, otherwise try merchant's callback secret
    const globalSecret = this.cfg.paymentsGateSecret || null;
    const candidates: string[] = [];
    if (globalSecret) candidates.push(globalSecret);
    if (externalId) {
      try {
        const order = await this.prisma.order.findFirst({ where: { merchantOrderId: externalId }, include: { merchant: true } });
        if (order?.merchant?.callbackSecretEncrypted) {
          try {
            const s = CryptoUtil.decrypt(order.merchant.callbackSecretEncrypted, this.cfg.encryptionKey);
            candidates.push(s);
          } catch (e) {
            this.logger.warn('Cannot decrypt merchant callback secret');
          }
        }
      } catch (e) {
        // ignore
      }
    }

    // verify signature: expected = hmac_sha256(secret, `${timestamp}.${txId}.${rawBody}`)
    const ts = headerTs.toString();
    const sig = headerSig.toString();
    let ok = false;
    for (const secret of candidates) {
      try {
        const expected = CryptoUtil.hmacSha256Hex(secret, `${ts}.${txId}.${body}`);
        if (CryptoUtil.timingSafeEqual(expected, sig)) { ok = true; break; }
      } catch {}
    }
    if (!ok) {
      this.logger.warn('Invalid signature for payments-gate webhook');
      return res.status(401).send('Invalid signature');
    }

    // find order by merchantOrderId or txId
    const order = externalId
      ? await this.prisma.order.findFirst({ where: { merchantOrderId: externalId } })
      : await this.prisma.order.findUnique({ where: { id: txId } });

    if (!order) {
      this.logger.warn(`Order not found for external id ${externalId} / tx ${txId}`);
      return res.status(200).send('ok');
    }

    const status = (payload?.object?.status || '').toUpperCase();
    try {
      if (status === 'PAID' || status === 'SETTLED' || status === 'SUCCESS') {
        await this.orders.adminResolve(order.id, 'complete', 'payments-gate');
      } else if (status === 'FAILED' || status === 'CANCELLED' || status === 'REVOKED') {
        await this.orders.adminResolve(order.id, 'cancel', 'payments-gate', `external status ${status}`);
      }
    } catch (e) {
      this.logger.error('Failed to resolve order from payments-gate webhook: ' + (e as Error).message);
      return res.status(500).send('error');
    }

    return res.status(200).send('ok');
  }
}
