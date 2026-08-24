import { Body, Controller, Headers, HttpCode, Post, Req, Logger } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { z } from 'zod';
import { AppConfig } from '../common/config/app-config.service';
import { AuthService } from '../auth/auth.service';
import { CryptoUtil } from '../common/utils/crypto.util';

const WebhookMerchantSchema = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email(),
  password: z.string().min(8).max(128),
});

@ApiTags('webhooks')
@Controller('api')
export class WebhookMerchantController {
  private readonly logger = new Logger(WebhookMerchantController.name);

  constructor(
    private readonly auth: AuthService,
    private readonly cfg: AppConfig,
  ) {}

  @Post('webhook/merchant/register')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Create a merchant from an external aggregator (e.g. Aggregat)',
    description: 'Authenticated via X-Webhook-Secret header. Returns JWT + API key.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', example: 'My Shop' },
        email: { type: 'string', example: 'shop@example.com' },
        password: { type: 'string', example: 'secretP@ss123' },
      },
      required: ['name', 'email', 'password'],
    },
  })
  async registerMerchant(
    @Req() req: Request,
    @Headers('x-webhook-secret') webhookSecret: string,
    @Body() dto: z.infer<typeof WebhookMerchantSchema>,
  ) {
    if (!webhookSecret) {
      this.logger.warn('Missing webhook secret header');
      return { error: 'Missing X-Webhook-Secret header' };
    }
    if (!CryptoUtil.timingSafeEqual(webhookSecret, this.cfg.webhookMerchantRegisterSecret)) {
      this.logger.warn('Invalid webhook secret');
      return { error: 'Invalid webhook secret' };
    }
    const merchant = await this.auth.registerMerchant(dto.name, dto.email, dto.password);
    return {
      accessToken: merchant.accessToken,
      apiKey: merchant.apiKey,
      merchantEmail: dto.email,
    };
  }
}
