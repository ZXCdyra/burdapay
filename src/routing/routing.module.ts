import { Global, Module } from '@nestjs/common';
import { SmartRoutingService } from './smart-routing.service';

@Global()
@Module({
  providers: [SmartRoutingService],
  exports: [SmartRoutingService],
})
export class RoutingModule {}
