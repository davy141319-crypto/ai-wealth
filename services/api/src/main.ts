import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory, Reflector } from '@nestjs/core';
import { ClassSerializerInterceptor, ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { env, SERVICE_NAMES } from '@ai-wealth/config';
import { createLogger } from '@ai-wealth/shared';

async function bootstrap(): Promise<void> {
  const cfg = env();
  const logger = createLogger(SERVICE_NAMES.API);

  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  // Global API prefix — every route lives under /api (e.g. /api/health, /api/docs)
  app.setGlobalPrefix(cfg.apiPrefix);

  // Security headers (Helmet), strict CORS (no wildcard in any env), rate limiting
  app.use(helmet());
  app.enableCors({
    origin: [cfg.webAppUrl, cfg.adminAppUrl],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // Input validation on every DTO (whitelist + forbid unknown + transform)
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Unified error envelope — never leaks SQL / stack / secrets
  app.useGlobalFilters(new AllExceptionsFilter());

  // Strip non-serializable fields from responses via class-transformer
  app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));

  // Swagger UI at /api/docs — every future endpoint auto-registers here
  const swaggerConfig = new DocumentBuilder()
    .setTitle('AI Wealth API')
    .setDescription('AI Wealth DApp backend API (P0 foundation — no real fund logic yet).')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup(`${cfg.apiPrefix}/docs`, app, document);

  await app.listen(cfg.apiPort);
  logger.info('API started', {
    port: cfg.apiPort,
    prefix: cfg.apiPrefix,
    env: cfg.nodeEnv,
    docs: `/${cfg.apiPrefix}/docs`,
  });
}

bootstrap().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  // Use stderr directly — the structured logger may not be initialized yet.
  process.stderr.write(`Failed to start API: ${message}\n`);
  process.exit(1);
});
