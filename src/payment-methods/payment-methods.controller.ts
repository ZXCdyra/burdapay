import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CARD_BRANDS, SBP_BANKS, SUPPORTED_METHODS } from './payment-methods.constants';

@ApiTags('payment-methods')
@Controller('payment-methods')
export class PaymentMethodsController {
  @Get()
  @ApiOperation({ summary: 'List supported payment methods (CARD, SBP only)' })
  list() {
    return {
      methods: [
        { code: 'CARD', brands: CARD_BRANDS },
        { code: 'SBP', banks: SBP_BANKS },
      ],
      allowed: SUPPORTED_METHODS,
    };
  }
}
