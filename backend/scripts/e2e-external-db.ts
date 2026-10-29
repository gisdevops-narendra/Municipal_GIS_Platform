/**
 * External database import end-to-end check (no browser): boots the real
 * Nest application context and runs connect → list → preview → import
 * through ExternalDbService and the normal upload pipeline (GDAL, PostGIS,
 * GeoServer preview), as the municipality owner. Uploads it creates are
 * discarded at the end.
 *
 *   docker exec municipal-gis-backend npx ts-node -r tsconfig-paths/register scripts/e2e-external-db.ts
 *
 * Expects the test databases (see the env defaults below): a PostGIS
 * database `extdb_test`, and MariaDB / MongoDB containers on the compose
 * network.
 */
process.env.RASTER_JOBS_RESUME = '0';
process.env.RASTER_MONITOR_SCHEDULER = '0';

import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { ExternalDbService } from '../src/gis/external-db.service';
import { GisUploadsService } from '../src/gis/gis-uploads.service';
import { ExternalDbImportDto, ExternalDbRequestDto, type ExternalDbConnectionDto } from '../src/gis/dto/external-db.dto';
import type { AppUser } from '../src/auth/types/app-user.type';

type Row = { group: string; name: string; ok: boolean; seconds: number; note: string };
const rows: Row[] = [];
const created: string[] = [];

const PG: ExternalDbConnectionDto = {
  type: 'POSTGRESQL',
  host: process.env.TEST_PG_HOST ?? 'postgres',
  port: 5432,
  database: 'extdb_test',
  username: process.env.POSTGIS_USER,
  password: process.env.POSTGIS_PASSWORD,
  sslMode: 'disable',
};
const MY: ExternalDbConnectionDto = {
  type: 'MYSQL', host: 'extdb-test-mariadb', port: 3306, database: 'gisdemo', username: 'gis', password: 'p@ss word!',
};
const MONGO: ExternalDbConnectionDto = {
  type: 'MONGODB', host: 'extdb-test-mongo', port: 27017, database: 'city', username: 'admin', password: 'm0ng@/pw',
};

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const prisma = app.get(PrismaService);
  const ext = app.get(ExternalDbService);
  const uploads = app.get(GisUploadsService);

  const owner = await prisma.user.findFirstOrThrow({ where: { systemRole: 'MUNICIPALITY_OWNER' } });
  const user: AppUser = {
    id: owner.id, keycloakUserId: owner.keycloakUserId, municipalityId: owner.municipalityId,
    departmentId: owner.departmentId, systemRole: owner.systemRole, status: owner.status,
  };

  async function check(group: string, name: string, run: () => Promise<string>) {
    const t = Date.now();
    try {
      rows.push({ group, name, ok: true, seconds: (Date.now() - t) / 1000, note: await run() });
    } catch (e) {
      rows.push({ group, name, ok: false, seconds: (Date.now() - t) / 1000, note: (e as Error).message });
    }
    const r = rows[rows.length - 1];
    r.seconds = (Date.now() - t) / 1000;
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${group.padEnd(8)} ${name.padEnd(44)} ${r.seconds.toFixed(1).padStart(5)}s  ${r.note}`);
  }

  /** Must throw with a message matching `re`. */
  async function refuses(fn: () => Promise<unknown>, re: RegExp): Promise<string> {
    try {
      await fn();
    } catch (e) {
      const m = (e as Error).message;
      if (re.test(m)) return `refused: ${m}`;
      throw new Error(`wrong error: ${m}`);
    }
    throw new Error('was not refused');
  }

  let n = 0;
  async function imp(body: Partial<ExternalDbImportDto>, expect: { count: number; geom?: string }) {
    const dto = plainToInstance(ExternalDbImportDto, {
      layerName: `ExtDB test ${++n} ${Date.now() % 100000}`,
      ownershipType: 'CANONICAL',
      ...body,
    });
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    if (errors.length) throw new Error(`DTO: ${errors.map((e) => Object.values(e.constraints ?? {}).join()).join('; ')}`);
    const u = await ext.import(user, dto);
    created.push(u.id);
    if (u.status !== 'DRAFT') throw new Error(`status ${u.status}: ${u.errorMessage}`);
    if (u.validation.featureCount !== expect.count) throw new Error(`featureCount ${u.validation.featureCount}, expected ${expect.count}`);
    if (expect.geom && u.validation.geometryType !== expect.geom) throw new Error(`geometry ${u.validation.geometryType}`);
    return u;
  }
  const fields = async (id: string) => {
    const s = (await uploads.getSchema(id, user)) as unknown as { columns: { name: string }[] };
    return s.columns.map((c) => c.name);
  };

  // ---- request validation
  const dtoErrors = async (connection: unknown) =>
    (await validate(plainToInstance(ExternalDbRequestDto, { connection }), { whitelist: true, forbidNonWhitelisted: true })).length;
  await check('DTO', 'valid connection accepted', async () => {
    if (await dtoErrors(PG)) throw new Error('rejected');
    return 'ok';
  });
  await check('DTO', 'rejects bad host / port / type / extra field', async () => {
    const bad = [
      { ...PG, host: 'db;rm -rf /' },
      { ...PG, host: 'user:pw@host/db' },
      { ...PG, port: 0 },
      { ...PG, type: 'ORACLE' },
      { ...PG, schemas: "public'; drop" },
      { ...PG, evil: 1 },
    ];
    const results = await Promise.all(bad.map(dtoErrors));
    if (results.some((c) => !c)) throw new Error(`accepted #${results.findIndex((c) => !c)}`);
    return `${bad.length} rejected`;
  });

  // ---- PostgreSQL / PostGIS
  await check('Postgres', 'test connection', async () => (await ext.test(PG)).message);
  await check('Postgres', 'list tables', async () => {
    const list = await ext.datasets(PG);
    const names = list.map((d) => d.name);
    for (const want of ['parks', 'gis.roads', 'shops', 'survey_pts', 'unknown_srid']) {
      if (!names.includes(want)) throw new Error(`missing ${want}: ${names.join(', ')}`);
    }
    const parks = list.find((d) => d.name === 'parks')!;
    if (parks.crs !== 'EPSG:4326' || parks.featureCount !== 3 || !/Polygon/.test(parks.geometryType ?? '')) {
      throw new Error(`parks: ${JSON.stringify(parks)}`);
    }
    if (list.find((d) => d.name === 'unknown_srid')!.crs !== null) throw new Error('unknown_srid has a CRS');
    return names.join(', ');
  });
  await check('Postgres', 'schema filter', async () => {
    const names = (await ext.datasets({ ...PG, schemas: 'gis' })).map((d) => d.name);
    if (names.join() !== 'gis.roads') throw new Error(names.join(', '));
    // The listed name must work without the filter.
    const p = await ext.preview(PG, names[0]);
    if (p.rows.length !== 20) throw new Error(`preview ${p.rows.length} rows`);
    return `${names.join(', ')} (previewable)`;
  });
  await check('Postgres', 'preview', async () => {
    const p = await ext.preview(PG, 'parks');
    if (p.rows.length !== 3 || p.rows[0].__geometry !== 'Polygon') throw new Error(JSON.stringify(p.rows[0]));
    return `${p.rows.length} rows, cols ${Object.keys(p.rows[0]).join(', ')}`;
  });
  await check('Postgres', 'wrong password', () => refuses(() => ext.test({ ...PG, password: 'nope' }), /Sign-in failed/));
  await check('Postgres', 'unknown host', () => refuses(() => ext.test({ ...PG, host: 'no-such-host.invalid' }), /could not be found/));
  await check('Postgres', 'closed port', () => refuses(() => ext.test({ ...PG, port: 5999 }), /Nothing is accepting|No response/));
  await check('Postgres', 'unknown database', () => refuses(() => ext.test({ ...PG, database: 'nope_db' }), /does not exist/));
  await check('Postgres', "refuses the platform's own database", () =>
    refuses(() => ext.datasets({ ...PG, database: process.env.POSTGIS_DATABASE ?? 'municipal_gis' }), /Municipal GIS Platform database/));
  await check('Postgres', 'refuses platform DB on import too', () =>
    refuses(() => imp({ connection: { ...PG, database: process.env.POSTGIS_DATABASE ?? 'municipal_gis' }, dataset: 'users' }, { count: 0 }),
      /Municipal GIS Platform database/));
  await check('Postgres', 'import polygons (quotes in values)', async () => {
    const u = await imp({ connection: PG, dataset: 'parks' }, { count: 3, geom: 'POLYGON' });
    return `${u.validation.sourceCrs} → ${u.validation.targetCrs}, fields ${(await fields(u.id)).join(', ')}`;
  });
  await check('Postgres', 'import lines: field subset + limit', async () => {
    const u = await imp({ connection: PG, dataset: 'gis.roads', fields: ['road_name'], limit: 100 }, { count: 100, geom: 'LINE' });
    const f = await fields(u.id);
    if (f.includes('lanes')) throw new Error(`lanes imported: ${f.join(', ')}`);
    return `100 of 250, fields ${f.join(', ')}`;
  });
  await check('Postgres', 'import lat/lon table as points', async () => {
    const u = await imp({ connection: PG, dataset: 'shops', latitudeField: 'latitude', longitudeField: 'longitude' }, { count: 2, geom: 'POINT' });
    return `${u.validation.sourceCrs}, fields ${(await fields(u.id)).join(', ')}`;
  });
  await check('Postgres', 'import X/Y table with CRS', async () => {
    const u = await imp(
      { connection: PG, dataset: 'survey_pts', xField: 'easting', yField: 'northing', sourceCrs: 'EPSG:32643', fields: ['label'] },
      { count: 2, geom: 'POINT' },
    );
    return `${u.validation.sourceCrs}, fields ${(await fields(u.id)).join(', ')}`;
  });
  await check('Postgres', 'unknown SRID + chosen source CRS', async () => {
    const u = await imp({ connection: PG, dataset: 'unknown_srid', sourceCrs: 'EPSG:32643' }, { count: 1, geom: 'POINT' });
    return `${u.validation.sourceCrs}`;
  });
  await check('Postgres', 'plain table without coordinates refused', () =>
    refuses(() => imp({ connection: PG, dataset: 'shops' }, { count: 0 }), /no geometry column/));
  await check('Postgres', 'only one coordinate column refused', () =>
    refuses(() => imp({ connection: PG, dataset: 'shops', latitudeField: 'latitude' }, { count: 0 }), /both coordinate columns/));
  await check('Postgres', 'unknown field refused', () =>
    refuses(() => imp({ connection: PG, dataset: 'parks', fields: ['nope'] }, { count: 0 }), /Unknown fields/));
  await check('Postgres', 'unknown table refused', () =>
    refuses(() => ext.preview(PG, 'no_such_table'), /not found|Couldn't fetch|does not exist/i));

  // ---- MySQL / MariaDB
  await check('MySQL', 'list tables', async () => {
    const list = await ext.datasets(MY);
    const wards = list.find((d) => d.name === 'wards');
    if (!wards?.geometryField || !list.some((d) => d.name === 'hydrants')) throw new Error(JSON.stringify(list));
    return list.map((d) => `${d.name}(${d.geometryType ?? '-'}, ${d.crs ?? '-'}, ${d.featureCount})`).join(', ');
  });
  await check('MySQL', 'preview', async () => {
    const p = await ext.preview(MY, 'wards');
    return `${p.rows.length} rows, cols ${Object.keys(p.rows[0]).join(', ')}`;
  });
  await check('MySQL', 'import polygons', async () => {
    const u = await imp({ connection: MY, dataset: 'wards', sourceCrs: 'EPSG:4326' }, { count: 2, geom: 'POLYGON' });
    const bbox = (u.validation.summary as { bbox?: unknown } | null)?.bbox;
    return `${u.validation.sourceCrs}, bbox ${JSON.stringify(bbox)}`;
  });
  await check('MySQL', 'import lat/lon table', async () => {
    const u = await imp({ connection: MY, dataset: 'hydrants', latitudeField: 'lat', longitudeField: 'lon' }, { count: 2, geom: 'POINT' });
    return `fields ${(await fields(u.id)).join(', ')}`;
  });
  await check('MySQL', 'wrong password', () => refuses(() => ext.test({ ...MY, password: 'nope' }), /Sign-in failed/));
  await check('MySQL', '"," in password refused', () => refuses(() => ext.test({ ...MY, password: 'a,b' }), /cannot contain/));

  // ---- MongoDB
  await check('MongoDB', 'list collections', async () => {
    const list = await ext.datasets(MONGO);
    const by = Object.fromEntries(list.map((d) => [d.name, d]));
    if (by.trees?.geometryField !== 'location' || by.trees.geometryType !== 'Point') throw new Error(`trees ${JSON.stringify(by.trees)}`);
    if (by.zones?.geometryField !== 'area.geo') throw new Error(`zones ${JSON.stringify(by.zones)}`);
    if (by.complaints?.geometryField !== null) throw new Error('complaints has geometry');
    return list.map((d) => `${d.name}(${d.geometryField ?? '-'})`).join(', ');
  });
  await check('MongoDB', 'preview (flattened)', async () => {
    const p = await ext.preview(MONGO, 'trees');
    const cols = Object.keys(p.rows[0]);
    if (!cols.includes('meta.ward') || cols.includes('location')) throw new Error(cols.join(', '));
    return `${p.rows.length} rows, cols ${cols.join(', ')}`;
  });
  await check('MongoDB', 'import points (skips doc without geometry)', async () => {
    const u = await imp({ connection: MONGO, dataset: 'trees' }, { count: 2, geom: 'POINT' });
    return `${u.validation.sourceCrs}, fields ${(await fields(u.id)).join(', ')}`;
  });
  await check('MongoDB', 'import nested geometry field', async () => {
    await imp({ connection: MONGO, dataset: 'zones' }, { count: 1, geom: 'POLYGON' });
    return 'area.geo';
  });
  await check('MongoDB', 'import lat/lng fields (CSV quoting)', async () => {
    const u = await imp({ connection: MONGO, dataset: 'complaints', latitudeField: 'lat', longitudeField: 'lng' }, { count: 2, geom: 'POINT' });
    return `fields ${(await fields(u.id)).join(', ')}`;
  });
  await check('MongoDB', 'wrong password', () => refuses(() => ext.test({ ...MONGO, password: 'nope' }), /Sign-in failed/));
  await check('MongoDB', 'unknown collection', () => refuses(() => ext.preview(MONGO, 'nope'), /not found/));

  // ---- cleanup
  for (const id of created) await uploads.discard(id, user).catch((e) => console.log(`discard ${id}: ${(e as Error).message}`));
  const failed = rows.filter((r) => !r.ok).length;
  console.log(`\n${rows.length - failed}/${rows.length} passed; ${created.length} test uploads discarded.`);
  await app.close();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  Logger.error(e);
  process.exit(1);
});
