import { Global, Module } from '@nestjs/common';
import { AppConfig } from './config/app-config.service';

@Global()
@Module({
  providers: [AppConfig],
  exports: [AppConfig],
})
export class CommonModule {}
