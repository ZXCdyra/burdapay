import { Module } from '@nestjs/common';
import { TradersController } from './traders.controller';

@Module({
  controllers: [TradersController],
})
export class TradersModule {}
