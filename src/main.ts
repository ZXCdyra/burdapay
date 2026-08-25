import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { join } from 'path';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { AppConfig } from './common/config/app-config.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });

  const cfg = app.get(AppConfig);

  app.use(helmet({
    contentSecurityPolicy: false,
  }));
  app.useStaticAssets(join(__dirname, '..', 'public'));
  app.set('trust proxy', 1);
  app.enableCors({
    origin: cfg.corsOrigin === '*' ? true : cfg.corsOrigin.split(','),
    credentials: true,
  });
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new LoggingInterceptor());
  app.enableShutdownHooks();

  const swaggerConfig = new DocumentBuilder()
    .setTitle('PayFlow Processing API')
    .setDescription(
      'High-risk payment processing platform. Methods: CARD (Visa/Mastercard/MIR) and SBP only. ' +
        'Merchant machine endpoints use the X-Api-Key header. ' +
        'Dashboard endpoints use JWT bearer tokens.',
    )
    .setVersion('1.0.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'jwt')
    .addApiKey({ type: 'apiKey', name: 'x-api-key', in: 'header', description: 'Merchant public key pk_...' }, 'api-key')
    .addTag('auth')
    .addTag('payment-methods')
    .addTag('orders')
    .addTag('trader')
    .addTag('merchants')
    .addTag('admin')
    .addTag('health')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document);

  await app.listen(cfg.port, '0.0.0.0');
  new Logger('Bootstrap').log(`PayFlow API listening on :${cfg.port} | Swagger at /docs`);
}

void bootstrap();
