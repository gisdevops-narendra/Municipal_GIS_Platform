import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

// BigInt columns (e.g. multi-GB upload file sizes) must survive JSON
// responses; JSON.stringify throws on BigInt by default.
(BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function (this: bigint) {
  return Number(this);
};

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Default is 100 KB; pasted SLD styles (PUT layers/:id/style/sld) can be
  // a few MB.
  app.useBodyParser('json', { limit: '6mb' });
  const config = app.get(ConfigService);

  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableCors({
    // Comma-separated, e.g. "http://localhost:4200,http://192.168.20.53:4200"
    // for a LAN demo.
    origin: config
      .get<string>('CORS_ORIGIN', 'http://localhost:4200')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    credentials: true,
    // Content-Disposition: so the Print Layout panel can read the
    // suggested download filename off the streamed PDF/PNG response.
    exposedHeaders: ['Content-Disposition', 'Content-Range', 'Accept-Ranges', 'Content-Length', 'ETag'],
  });

  const port = config.get<string>('BACKEND_PORT', '3000');
  await app.listen(port);
  Logger.log(`Municipal GIS backend listening on port ${port}`, 'Bootstrap');
}
bootstrap().catch((error: unknown) => {
  Logger.error(
    'Failed to start the Municipal GIS backend',
    error as Error,
    'Bootstrap',
  );
  process.exit(1);
});
