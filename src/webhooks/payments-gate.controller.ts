import { Controller, Post, Req, Res, HttpCode, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { OrdersService } from '../orders/orders.service';
import { getWebhookAmount, getWebhookCurrency, getWebhookOrderCandidates } from './payments-gate.utils';

@Controller(['payments-gate', 'api/webhooks'])
export class PaymentsGateController {
  private readonly logger = new Logger(PaymentsGateController.name);
  constructor(
    private readonly prisma: PrismaService,
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

    let payload: any;
    try { payload = JSON.parse(body); } catch (e) { this.logger.warn('Invalid JSON payload'); return res.status(400).send('Invalid JSON'); }

    const txId = payload?.object?.uuid ?? '';
    const externalId = payload?.object?.external_id ?? null;
    const orderMatchCandidates = getWebhookOrderCandidates(payload);

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
    const isSuccess = eventType === 'payment.success' ||
      status === 'PAID' || status === 'SETTLED' || status === 'SUCCESS';

    if (isSuccess) {
      // Amount verification: the callback must match the order, otherwise we do not credit
      const webhookAmount = getWebhookAmount(payload);
      if (!webhookAmount || !webhookAmount.eq(order.amount)) {
        this.logger.warn(
          `Amount mismatch for order ${order.id}: webhook=${webhookAmount ? webhookAmount.toFixed(2) : 'n/a'}, ` +
          `order=${order.amount.toFixed(2)} — rejecting`,
        );
        return res.status(200).json({ ok: false, matched: true, reason: 'AMOUNT_MISMATCH' });
      }

      const webhookCurrency = getWebhookCurrency(payload);
      if (webhookCurrency && webhookCurrency !== order.currency.toUpperCase()) {
        this.logger.warn(
          `Currency mismatch for order ${order.id}: webhook=${webhookCurrency}, order=${order.currency} — rejecting`,
        );
        return res.status(200).json({ ok: false, matched: true, reason: 'CURRENCY_MISMATCH' });
      }
    }

    try {
      if (isSuccess) {
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
