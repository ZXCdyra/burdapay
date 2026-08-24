import { Global, Module } from '@nestjs/common';
import { AntifraudService } from './antifraud.service';

@Global()
@Module({
  providers: [AntifraudService],
  exports: [AntifraudService],
})
export class AntifraudModule {}
