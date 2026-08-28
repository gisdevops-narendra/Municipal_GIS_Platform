import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
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
    origin: config.get<string>('CORS_ORIGIN', 'http://localhost:4200'),
    credentials: true,
    // Content-Disposition: so the Print Layout panel can read the
    // suggested download filename off the streamed PDF/PNG response.
    exposedHeaders: ['Content-Disposition'],
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
