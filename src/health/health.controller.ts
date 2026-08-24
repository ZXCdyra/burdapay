import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.module';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get()
  async check() {
    const db = await this.prisma.$queryRaw`SELECT 1`.then(
      () => 'up',
      () => 'down',
    );
    const redis = (await this.redis.ping()) ? 'up' : 'down';

    if (db !== 'up' || redis !== 'up') {
      throw new ServiceUnavailableException({ status: 'degraded', checks: { db, redis } });
    }
    return { status: 'ok', checks: { db, redis }, timestamp: new Date().toISOString() };
  }
}
