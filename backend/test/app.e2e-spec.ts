import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

/**
 * Full-stack smoke test. Requires a reachable PostgreSQL (DATABASE_URL) and
 * the Keycloak-related env vars to be set — e.g. run via:
 *   docker compose up -d postgres
 *   cp backend/.env.example backend/.env
 *   npm run test:e2e
 */
describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  it('/api/health (GET)', () => {
    return request(app.getHttpServer())
      .get('/api/health')
      .expect(200)
      .expect({ status: 'ok' });
  });

  it('/api/me (GET) requires authentication', () => {
    return request(app.getHttpServer()).get('/api/me').expect(401);
  });

  afterEach(async () => {
    await app.close();
  });
});
