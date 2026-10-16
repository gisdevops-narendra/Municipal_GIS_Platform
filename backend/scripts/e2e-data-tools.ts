/**
 * Tier 2 / Tier 3 end-to-end check (no browser): boots the real Nest
 * application context and runs Geoprocessing, Impact Report, Service Area,
 * Feature Editing + History, Parcel split / merge, Attachments, Field
 * Calculator, Table Join, Geocoding, Field Rules, Topology validation and
 * Versions (snapshot / compare / restore) through the same services the API
 * uses, as the municipality owner.
 *
 * Every write happens on throwaway copies made by the geoprocessing tool —
 * the source layers are only read. Copies are deleted at the end (and the
 * script checks their snapshot tables / attachment files went with them)
 * unless KEEP=1.
 *
 *   docker exec municipal-gis-backend npx ts-node -r tsconfig-paths/register scripts/e2e-data-tools.ts
 *
 * Env: MUNICIPALITY_ID (default: the first owner's), POLYGON / LINE / POINT
 * = source layer names, ONLY=<substring> to run a subset.
 */
process.env.RASTER_JOBS_RESUME = '0';
process.env.RASTER_MONITOR_SCHEDULER = '0';

import { existsSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { GisLayersService } from '../src/gis/gis-layers.service';
import { VectorToolsService } from '../src/gis/vector-tools.service';
import { DataToolsService } from '../src/gis/data-tools.service';
import { NetworkService } from '../src/gis/network.service';
import type { AppUser } from '../src/auth/types/app-user.type';

type Row = { group: string; name: string; ok: boolean; seconds: number; note: string };
const rows: Row[] = [];
const created: string[] = [];
/** Set once the app is up, so a crash can still delete what was created. */
let cleanup: (() => Promise<void>) | null = null;

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const prisma = app.get(PrismaService);
  const layers = app.get(GisLayersService);
  const vector = app.get(VectorToolsService);
  const data = app.get(DataToolsService);
  const network = app.get(NetworkService);

  const owner = await prisma.user.findFirstOrThrow({
    where: { systemRole: 'MUNICIPALITY_OWNER', ...(process.env.MUNICIPALITY_ID ? { municipalityId: process.env.MUNICIPALITY_ID } : {}) },
  });
  const user: AppUser = {
    id: owner.id, keycloakUserId: owner.keycloakUserId, municipalityId: owner.municipalityId,
    departmentId: owner.departmentId, systemRole: owner.systemRole, status: owner.status,
  };
  const byType = async (type: 'POLYGON' | 'LINE' | 'POINT', name?: string) =>
    prisma.gISLayer.findFirstOrThrow({
      where: {
        layerType: 'VECTOR', geometryType: type, postgisTable: { not: null },
        gisWorkspace: { municipalityId: user.municipalityId },
        ...(name ? { name } : { rasterAnalysis: false }),
      },
      orderBy: { createdAt: 'asc' },
    });
  const polygon = await byType('POLYGON', process.env.POLYGON);
  const line = await byType('LINE', process.env.LINE);
  const point = await byType('POINT', process.env.POINT);
  console.log(`Sources: polygon="${polygon.name}" line="${line.name}" point="${point.name}"\n`);
  const tag = Date.now().toString(36);
  cleanup = async () => {
    if (process.env.KEEP === '1') return;
    for (const id of created.splice(0)) await layers.deleteLayer(user, id).catch((e: Error) => console.error(`delete ${id}: ${e.message}`));
  };
  const only = process.env.ONLY;

  async function check(group: string, name: string, run: () => Promise<string>) {
    if (only && !`${group} ${name}`.toLowerCase().includes(only.toLowerCase())) return;
    const t = Date.now();
    try {
      rows.push({ group, name, ok: true, seconds: (Date.now() - t) / 1000, note: await run() });
    } catch (e) {
      rows.push({ group, name, ok: false, seconds: (Date.now() - t) / 1000, note: (e as Error).message.slice(0, 200) });
    }
    const r = rows[rows.length - 1];
    r.seconds = (Date.now() - t) / 1000;
    console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.group} · ${r.name} (${r.seconds.toFixed(1)} s) ${r.note}`);
  }
  const keep = (layer: { id: string }) => (created.push(layer.id), layer.id);
  const tableOf = async (id: string) => (await prisma.gISLayer.findUniqueOrThrow({ where: { id } })).postgisTable!;
  const count = async (id: string) =>
    (await prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${await tableOf(id)}"`))[0].n;
  const sample = async <T>(table: string, sql: string) => (await prisma.$queryRawUnsafe<T[]>(sql.replace('$T', `"${table}"`)))[0];

  // ----- Geoprocessing (also builds the editable copies) -----
  const ids: Record<string, string> = {};
  const geo = (operation: string, name: string, extra: Record<string, unknown>) =>
    check('Geoprocessing', name, async () => {
      const layer = await vector.geoprocess(user, { operation, outputName: `e2e ${name} ${tag}`, ...extra } as never);
      ids[name] = keep(layer);
      return `${await count(layer.id)} features`;
    });
  await geo('clip', 'polygon copy', { inputLayerId: polygon.id, overlayLayerId: polygon.id });
  await geo('clip', 'point copy', { inputLayerId: point.id, overlayLayerId: polygon.id });
  await geo('buffer', 'buffer', { inputLayerId: point.id, distance: 25 });
  await geo('buffer', 'buffer dissolved', { inputLayerId: point.id, distance: 25, dissolve: true });
  await geo('dissolve', 'dissolve', { inputLayerId: polygon.id });
  await geo('intersect', 'intersect', { inputLayerId: line.id, overlayLayerId: polygon.id });
  await geo('erase', 'erase', { inputLayerId: line.id, overlayLayerId: ids['buffer dissolved'] ?? polygon.id });
  await geo('join', 'join count', { inputLayerId: polygon.id, overlayLayerId: point.id, joinMode: 'count' });
  await geo('join', 'join attributes', { inputLayerId: point.id, overlayLayerId: polygon.id, joinMode: 'attributes' });
  const poly = ids['polygon copy'];
  const pts = ids['point copy'];
  if (!poly || !pts) throw new Error('Could not build the editable copies — stopping before any write.');
  const polyTable = await tableOf(poly);

  // ----- Impact report / service area -----
  const centre = await sample<{ lon: number; lat: number }>(
    await tableOf(pts), `SELECT ST_X(ST_Transform(ST_PointOnSurface(geom),4326)) lon, ST_Y(ST_Transform(ST_PointOnSurface(geom),4326)) lat FROM $T ORDER BY ogc_fid LIMIT 1`,
  );
  await check('Impact Report', 'points within 300 m', async () => {
    const r = await vector.impactCsv(user, point.id, { type: 'Point', coordinates: [centre.lon, centre.lat] }, 300);
    assert(r.count > 0 && r.body.split('\r\n').length === r.count + 1, `count ${r.count} vs csv lines`);
    return `${r.count} rows → ${r.filename}`;
  });
  await check('Service Area', 'distance bands on network', async () => {
    const r = (await network.serviceArea(user, { layerId: line.id, at: [centre.lon, centre.lat], breaks: [300, 800] })) as unknown;
    const s = JSON.stringify(r);
    assert(s.includes('Polygon') || s.includes('LineString'), 'no geometry in result');
    return `${(s.length / 1024).toFixed(0)} KB result`;
  });
  await check('Service Area', 'minute bands at 20 km/h', async () => {
    const r = await network.serviceArea(user, { layerId: line.id, at: [centre.lon, centre.lat], breaks: [2, 5], speedKmh: 20 });
    return `${JSON.stringify(r).length > 100 ? 'ok' : 'empty'}`;
  });

  // ----- Feature editing + history -----
  const schema = await vector.editSchema(user, poly);
  const textField = schema.fields.find((f) => /char|text/.test(f.type) && f.name !== 'geom')?.name;
  let newId = 0;
  await check('Edit', 'schema', async () => `${schema.fields.length} fields, ${schema.geometryType}`);
  await check('Edit', 'create / update / feature-at / delete', async () => {
    const square = await sample<{ g: Record<string, unknown> }>(polyTable,
      `SELECT ST_AsGeoJSON(ST_Transform(ST_Expand(ST_PointOnSurface(geom), 20), 4326))::json g FROM $T ORDER BY ogc_fid LIMIT 1`);
    const f = await vector.createFeature(user, poly, square.g, textField ? { [textField]: 'e2e-created' } : {});
    newId = f.id;
    const u = await vector.updateFeature(user, poly, f.id, undefined, textField ? { [textField]: 'e2e-updated' } : {});
    assert(!textField || u.properties[textField] === 'e2e-updated', 'update not applied');
    const c = (square.g as { coordinates: number[][][] }).coordinates[0];
    const at = await vector.featureAt(user, poly, (c[0][0] + c[2][0]) / 2, (c[0][1] + c[2][1]) / 2, 5);
    assert(at, 'featureAt found nothing');
    await vector.deleteFeature(user, poly, f.id);
    return `feature ${f.id} created, updated, found (id ${at.id}), deleted`;
  });
  await check('Edit History', 'records insert/update/delete', async () => {
    const h = await vector.history(user, poly, newId);
    const ops = h.map((x) => x.action).sort().join(',');
    assert(ops === 'DELETE,INSERT,UPDATE', `got ${ops}`);
    return ops;
  });

  // ----- Parcel tools -----
  const [a, b] = await prisma.$queryRawUnsafe<{ id: number; line: Record<string, unknown> }[]>(
    // A horizontal line through each parcel's interior point, overshooting its bbox.
    `SELECT ogc_fid AS id, ST_AsGeoJSON(ST_Transform(ST_SetSRID(ST_MakeLine(
              ST_MakePoint(ST_XMin(geom) - 10, ST_Y(p)), ST_MakePoint(ST_XMax(geom) + 10, ST_Y(p))), ST_SRID(geom)), 4326))::json AS line
       FROM (SELECT ogc_fid, geom, ST_PointOnSurface(geom) p FROM "${polyTable}") s ORDER BY ogc_fid LIMIT 2`,
  );
  let pieces: number[] = [];
  await check('Parcel Tools', 'split across centroid', async () => {
    const before = await count(poly);
    const r = await vector.splitFeature(user, poly, a.id, a.line);
    pieces = r.features.map((f) => f.id);
    assert((await count(poly)) === before + pieces.length - 1, 'feature count mismatch');
    return `${pieces.length} pieces`;
  });
  await check('Parcel Tools', 'merge pieces back + another parcel', async () => {
    const before = await count(poly);
    const ids2 = [...pieces, b.id];
    await vector.mergeFeatures(user, poly, ids2, a.id);
    assert((await count(poly)) === before - ids2.length + 1, 'feature count mismatch');
    return `${ids2.length} → 1`;
  });

  // ----- Attachments -----
  let attachmentPath = '';
  await check('Attachments', 'add / list / download / delete', async () => {
    const body = Buffer.from('e2e attachment');
    const att = await vector.addAttachment(user, poly, a.id, { originalname: 'note.txt', mimetype: 'text/plain', size: body.length, buffer: body });
    const list = await vector.listAttachments(user, poly, a.id);
    assert(list.some((x) => x.id === att.id), 'not listed');
    const file = await vector.attachmentFile(user, poly, att.id);
    assert(file.body.equals(body), 'content differs');
    await vector.deleteAttachment(user, poly, att.id);
    // Leave one behind so the cleanup check below has something to verify.
    await vector.addAttachment(user, poly, a.id, { originalname: 'keep.txt', mimetype: 'text/plain', size: body.length, buffer: body });
    attachmentPath = vector.attachmentDir(user.municipalityId, poly);
    return 'ok';
  });
  await check('Attachments', 'rejects disallowed type', async () => {
    const r = await vector
      .addAttachment(user, poly, a.id, { originalname: 'x.exe', mimetype: 'application/x-msdownload', size: 1, buffer: Buffer.from('x') })
      .then(() => 'accepted', (e: Error) => e.message);
    assert(r !== 'accepted', 'an .exe was accepted');
    return r;
  });

  // ----- Versions (snapshot before the data tools change things) -----
  let snapId = '';
  const fidsBefore = await count(poly);
  await check('Versions', 'snapshot', async () => {
    const s = (await data.createSnapshot(user, poly, `e2e before ${tag}`)) as { id: string; featureCount: number };
    snapId = s.id;
    assert(s.featureCount === fidsBefore, `snapshot has ${s.featureCount}, layer ${fidsBefore}`);
    return `${s.featureCount} features`;
  });

  // ----- Field calculator -----
  await check('Field Calculator', 'preview', async () => {
    const r = (await data.fieldCalculate(user, poly, { field: 'x', expression: 'round($area, 1)', preview: true })) as { preview: unknown[] };
    assert(r.preview.length > 0, 'no preview rows');
    return JSON.stringify(r.preview[0]);
  });
  await check('Field Calculator', 'new numeric field from area', async () => {
    const r = (await data.fieldCalculate(user, poly, { field: 'calc_area', newFieldType: 'double precision', expression: 'round($area, 1)' })) as { changed: number };
    const s = await sample<{ v: number }>(polyTable, `SELECT calc_area AS v FROM $T WHERE calc_area IS NOT NULL LIMIT 1`);
    assert(r.changed > 0 && s?.v > 0, 'no values written');
    return `${r.changed} features, e.g. ${s.v}`;
  });
  if (textField) {
    await check('Field Calculator', 'text concat into existing field', async () => {
      const r = (await data.fieldCalculate(user, poly, { field: textField, expression: `upper("${textField}") || '-x'` })) as { changed: number };
      return `${r.changed} features`;
    });
  }
  await check('Field Calculator', 'rejects SQL injection', async () => {
    const r = await data
      .fieldCalculate(user, poly, { field: 'calc_area', expression: `1); DROP TABLE "${polyTable}"; --`, preview: true })
      .then(() => 'accepted', (e: Error) => e.message);
    assert(r !== 'accepted' && (await count(poly)) > 0, 'injection accepted');
    return r.slice(0, 80);
  });

  // ----- Table join -----
  const keyField = schema.fields.find((f) => /char|text/.test(f.type) && !['remarks'].includes(f.name))?.name ?? 'ogc_fid';
  await check('Table Join', `CSV on ${keyField}`, async () => {
    const keys = await prisma.$queryRawUnsafe<{ k: string }[]>(`SELECT DISTINCT trim("${keyField}"::text) k FROM "${polyTable}" WHERE "${keyField}" IS NOT NULL LIMIT 5`);
    const csv = ['key,population_2026,status', ...keys.map((k, i) => `"${k.k}",${1000 * (i + 1)},Active ${i}`), 'no-such-key,1,x'].join('\n');
    const r = await data.joinTable(user, poly, Buffer.from(csv), { layerKey: keyField, tableKey: 'key' });
    assert(r.matchedFeatures > 0 && r.fields.length === 2, JSON.stringify(r));
    return `${r.matchedFeatures} matched, ${r.changedFeatures} changed, fields ${r.fields.join('/')}`;
  });

  // ----- Geocoding -----
  // Reference field: the text column (of either copy) with the most distinct,
  // reasonably long values — real data often leaves address fields empty.
  const candidates: { layer: string; field: string; n: number }[] = [];
  for (const layer of [pts, poly]) {
    const t = await tableOf(layer);
    for (const f of (await vector.editSchema(user, layer)).fields.filter((x) => /char|text/.test(x.type))) {
      const [{ n }] = await prisma.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(DISTINCT "${f.name}")::int AS n FROM "${t}" WHERE length("${f.name}") >= 5`);
      candidates.push({ layer, field: f.name, n });
    }
  }
  const ref = candidates.sort((x, y) => y.n - x.n)[0];
  if (ref?.n >= 2) {
    await check('Geocode', `addresses against ${ref.field}`, async () => {
      const names = await prisma.$queryRawUnsafe<{ v: string }[]>(
        `SELECT DISTINCT "${ref.field}"::text v FROM "${await tableOf(ref.layer)}" WHERE length("${ref.field}") >= 5 ORDER BY 1 LIMIT 4`);
      // One exact, one lower-cased, plus one nonsense address.
      const lines = names.map((n, i) => `${i + 1},"${i % 2 ? n.v.toLowerCase() : n.v}"`);
      const csv = ['id,address', ...lines, '99,"qqqq zzzz wwww"'].join('\n');
      const r = await data.geocode(user, Buffer.from(csv), { addressColumn: 'address', referenceLayerId: ref.layer, referenceField: ref.field, outputName: `e2e geocode ${tag}` });
      keep(r.layer);
      assert(r.matched === names.length && r.unmatched.some((u) => u.address.startsWith('qqqq')), JSON.stringify(r).slice(0, 200));
      return `${r.matched} matched, ${r.unmatchedCount} unmatched`;
    });
  }

  // ----- Field rules + topology -----
  await check('Field Rules', 'set / enforce on edit', async () => {
    await data.setFieldRules(user, poly, { rules: [{ field: 'calc_area', required: true, min: 0, max: 1 }] });
    const got = await data.getFieldRules(user, poly);
    assert((got.rules as Record<string, unknown>).calc_area, 'rule not stored');
    const r = await vector.updateFeature(user, poly, a.id, undefined, { calc_area: 99999 }).then(() => 'accepted', (e: Error) => e.message);
    assert(r !== 'accepted', 'out-of-range value accepted');
    return `edit refused: ${r.slice(0, 60)}`;
  });
  await check('Topology', 'validate polygon copy', async () => {
    const r = await data.validate(user, poly, { maxGapArea: 1000 });
    assert((r.counts.rule ?? 0) > 0, 'expected field-rule violations (calc_area > 1)');
    return JSON.stringify(r.counts);
  });
  await check('Topology', 'validate network (dangles)', async () => {
    const r = await data.validate(user, line.id, {});
    return JSON.stringify(r.counts) + (r.truncated ? ' (truncated)' : '');
  });
  await check('Topology', 'fix duplicates on copy', async () => {
    const t = await tableOf(pts);
    const cols = (await vector.columns(t)).map((c) => `"${c.name}"`).join(', ');
    await prisma.$executeRawUnsafe(`INSERT INTO "${t}" (geom, ${cols}) SELECT geom, ${cols} FROM "${t}" ORDER BY ogc_fid LIMIT 3`);
    const before = (await data.validate(user, pts, {})).counts.duplicate ?? 0;
    const r = await data.fix(user, pts, 'duplicates');
    const after = (await data.validate(user, pts, {})).counts.duplicate ?? 0;
    assert(before >= 3 && after === 0, `before ${before}, after ${after}`);
    return `${r.fixed} removed`;
  });
  await check('Topology', 'fix invalid on copy', async () => {
    await prisma.$executeRawUnsafe(
      `UPDATE "${polyTable}" SET geom = ST_Multi(ST_GeomFromText('POLYGON((0 0, 10 10, 10 0, 0 10, 0 0))', ST_SRID(geom)))
        WHERE ogc_fid = (SELECT max(ogc_fid) FROM "${polyTable}")`,
    );
    const r = await data.fix(user, poly, 'invalid');
    const left = (await data.validate(user, poly, {})).counts.invalid ?? 0;
    assert(r.fixed >= 1 && left === 0, `fixed ${r.fixed}, left ${left}`);
    return `${r.fixed} repaired`;
  });

  // ----- Versions: compare + restore -----
  await check('Versions', 'compare with snapshot', async () => {
    const r = (await data.compareSnapshot(user, poly, snapId)) as Record<string, { count: number }>;
    assert(r.modified.count > 0, 'no modifications detected');
    return `added ${r.added.count}, removed ${r.removed.count}, modified ${r.modified.count}`;
  });
  await check('Versions', 'restore snapshot', async () => {
    await data.restoreSnapshot(user, poly, snapId);
    const r = (await data.compareSnapshot(user, poly, snapId)) as unknown as Record<string, { count: number }> & { fields: { added: string[] } };
    const n = await count(poly);
    assert(r.added.count + r.removed.count + r.modified.count === 0, `diff after restore +${r.added.count} -${r.removed.count} ~${r.modified.count}`);
    assert(r.fields.added.includes('calc_area'), 'new field not reported');
    assert(n === fidsBefore, `restored ${n}, expected ${fidsBefore}`);
    const list = await data.listSnapshots(user, poly);
    assert(list.some((s) => s.name.startsWith('Before restoring')), 'no safety snapshot');
    return `${n} features, no differences; new fields ${r.fields.added.join('/')}; ${list.length} snapshots`;
  });
  await check('Versions', 'new feature id after restore does not collide', async () => {
    const g = await sample<{ g: Record<string, unknown> }>(polyTable,
      `SELECT ST_AsGeoJSON(ST_Transform(ST_Expand(ST_PointOnSurface(geom), 5), 4326))::json g FROM $T LIMIT 1`);
    await data.setFieldRules(user, poly, { rules: [] });
    const f = await vector.createFeature(user, poly, g.g, {});
    return `new id ${f.id}`;
  });

  // ----- Cleanup -----
  const snapshotTables = (
    await prisma.gISLayerSnapshot.findMany({ where: { layerId: { in: created } }, select: { postgisTable: true } })
  ).map((s) => s.postgisTable);
  if (process.env.KEEP !== '1') {
    await check('Cleanup', 'delete e2e layers', async () => {
      for (const id of created) await layers.deleteLayer(user, id);
      return `${created.length} layers`;
    });
    await check('Cleanup', 'snapshot tables + attachments removed with layer', async () => {
      const left = await prisma.$queryRawUnsafe<{ t: string }[]>(
        `SELECT tablename t FROM pg_tables WHERE schemaname='public' AND tablename = ANY($1::text[])`, snapshotTables);
      const rowsLeft = await prisma.gISLayerSnapshot.count({ where: { layerId: { in: created } } });
      const attLeft = await prisma.gISFeatureAttachment.count({ where: { layerId: { in: created } } });
      const dirLeft = attachmentPath && existsSync(attachmentPath);
      assert(!left.length && !rowsLeft && !attLeft && !dirLeft,
        `orphans: ${left.length} snapshot tables, ${rowsLeft} snapshot rows, ${attLeft} attachment rows, dir ${dirLeft ? 'kept' : 'gone'}`);
      return `${snapshotTables.length} snapshot tables dropped, attachment dir gone`;
    });
  }

  const failed = rows.filter((r) => !r.ok);
  console.log(`\n${rows.length - failed.length}/${rows.length} passed`);
  await app.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await cleanup?.();
  if (created.length) console.error(`Created layers (delete manually if needed): ${created.join(', ')}`);
  process.exit(1);
});
