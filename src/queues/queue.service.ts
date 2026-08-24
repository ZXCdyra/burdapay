import {
  Global,
  Injectable,
  Logger,
  Module,
  OnModuleDestroy,
} from '@nestjs/common';
import { Job, Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { AppConfig } from '../common/config/app-config.service';
import { RedisService } from '../redis/redis.module';
import { OrderExpiryJobData, QueueName, WebhookDeliveryJobData, QUEUES } from './queues.constants';

type Processor = (job: Job) => Promise<void>;

@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private readonly connections: Redis[] = [];
  private readonly queues = new Map<QueueName, Queue>();
  private readonly workers = new Map<QueueName, Worker>();

  constructor(
    private readonly cfg: AppConfig,
    private readonly redis: RedisService,
  ) {}

  private newConnection(): Redis {
    const conn = new Redis(this.cfg.redisUrl, { maxRetriesPerRequest: null });
    conn.on('error', (err) => this.logger.warn(`Queue redis error: ${err.message}`));
    this.connections.push(conn);
    return conn;
  }

  private getOrCreateQueue(queue: QueueName): Queue {
    let q = this.queues.get(queue);
    if (!q) {
      q = new Queue(queue, { connection: this.newConnection() });
      this.queues.set(queue, q);
    }
    return q;
  }

  registerProcessor(queue: QueueName, processor: Processor): void {
    if (this.workers.has(queue)) return;
    this.getOrCreateQueue(queue);
    const worker = new Worker(queue, processor, {
      connection: this.newConnection(),
      concurrency: 5,
    });
    worker.on('failed', (job, err) => {
      this.logger.warn(`Job ${queue}:${job?.id ?? '?'} failed (attempt ${job?.attemptsMade ?? 0}): ${err.message}`);
    });
    worker.on('error', (err) => this.logger.error(`Worker ${queue} error: ${err.message}`));
    this.workers.set(queue, worker);
  }

  async scheduleOrderExpiry(orderId: string, delayMs: number): Promise<void> {
    await this.getOrCreateQueue(QUEUES.ORDER_EXPIRY).add(
      'expire',
      { orderId } satisfies OrderExpiryJobData,
      { delay: Math.max(delayMs, 0), removeOnComplete: true, removeOnFail: false, jobId: `expire:${orderId}` },
    );
  }

  async enqueueWebhook(data: WebhookDeliveryJobData): Promise<void> {
    await this.getOrCreateQueue(QUEUES.WEBHOOK_DELIVERY).add('deliver', data, {
      attempts: this.cfg.webhookAttempts,
      backoff: { type: 'exponential', delay: this.cfg.webhookBackoffSeconds * 1000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.workers.values()].map((w) => w.close().catch(() => undefined)));
    await Promise.all([...this.queues.values()].map((q) => q.close().catch(() => undefined)));
    await Promise.all(this.connections.map((c) => c.quit().catch(() => undefined)));
  }
}

@Global()
@Module({
  providers: [QueueService],
  exports: [QueueService],
})
export class QueuesModule {}
