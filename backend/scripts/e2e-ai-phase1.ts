/**
 * AI Phase 1 end-to-end check (no browser, no login): boots the real Nest
 * application context and, as the municipality owner, runs
 *   - every chat operation kind (select, aggregate, nearest, buffer, route,
 *     service_area) through GisAiService.executePlan — the same compile +
 *     run path a chat answer takes, minus the LLM plan step;
 *   - plan validation (bad field / layer -> a clarification, not an error);
 *   - statistical outliers in Topology Validation;
 *   - semantic layer search through the dashboard search;
 *   - LLM narration / raster explanation (slow on CPU; SKIP_LLM=1 skips).
 * Read-only: nothing is written to any layer.
 *
 *   docker exec municipal-gis-backend npx ts-node -r tsconfig-paths/register scripts/e2e-ai-phase1.ts
 *
 * Env: MUNICIPALITY_ID (default: the first owner's), SKIP_LLM=1.
 */
process.env.RASTER_JOBS_RESUME = '0';
process.env.RASTER_MONITOR_SCHEDULER = '0';
process.env.GIS_AI_ENABLE_RAW_PLAN = 'true';

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { GisAiService } from '../src/gis-ai/gis-ai.service';
import { LayerCatalogService } from '../src/gis-ai/layer-catalog.service';
import { AiClientService } from '../src/gis-ai/ai-client.service';
import { DataToolsService } from '../src/gis/data-tools.service';
import { GisDashboardService } from '../src/gis/gis-dashboard.service';
import type { AppUser } from '../src/auth/types/app-user.type';
import type { AiGisOperation } from '../src/gis-ai/ai-plan.types';

type Row = { name: string; ok: boolean; seconds: number; note: string };
const rows: Row[] = [];

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const prisma = app.get(PrismaService);
  const gisAi = app.get(GisAiService);
  const catalogService = app.get(LayerCatalogService);
  const aiClient = app.get(AiClientService);
  const data = app.get(DataToolsService);
  const dashboard = app.get(GisDashboardService);

  const owner = await prisma.user.findFirstOrThrow({
    where: { systemRole: 'MUNICIPALITY_OWNER', ...(process.env.MUNICIPALITY_ID ? { municipalityId: process.env.MUNICIPALITY_ID } : {}) },
  });
  const user: AppUser = {
    id: owner.id, keycloakUserId: owner.keycloakUserId, municipalityId: owner.municipalityId,
    departmentId: owner.departmentId, systemRole: owner.systemRole, status: owner.status,
  };

  const catalog = await catalogService.buildForUser(user);
  console.log('Layers:');
  for (const l of catalog) {
    console.log(`  ${l.name} [${l.code}] ${l.geometryType} srid=${l.srid} fields=${l.columns.map((c) => `${c.name}:${c.kind}`).join(',')}`);
  }
  const polygon = catalog.find((l) => l.geometryType === 'POLYGON');
  const line = catalog.find((l) => l.geometryType === 'LINE');
  const point = catalog.find((l) => l.geometryType === 'POINT');
  const textCol = (l: typeof polygon) =>
    l?.columns.find((c) => c.kind === 'text' && c.sampleValues.length > 1 && !c.sampleValues.includes('…(more)'))?.name ??
    l?.columns.find((c) => c.kind === 'text')?.name;
  const numCol = (l: typeof polygon) =>
    l?.columns.find((c) => (c.kind === 'number' || c.kind === 'integer') && !/(^|_)(id|fid|no|code|year)$/i.test(c.name))?.name;
  console.log(`\nUsing polygon=${polygon?.name} line=${line?.name} point=${point?.name}\n`);

  async function check(name: string, run: () => Promise<string>) {
    const t = Date.now();
    try {
      const note = await run();
      rows.push({ name, ok: true, seconds: (Date.now() - t) / 1000, note });
    } catch (error) {
      rows.push({ name, ok: false, seconds: (Date.now() - t) / 1000, note: (error as Error).message });
    }
  }
  const op = (o: Partial<AiGisOperation> & { kind: AiGisOperation['kind']; target_layer: string }) =>
    gisAi.executePlan(user, { attribute_filters: [], ...o } as AiGisOperation);
  const okOp = async (o: Parameters<typeof op>[0]) => {
    const r = await op(o);
    assert(r.answerKind === 'gis_operation', `${r.answerKind}: ${r.clarification ?? r.explanation}`);
    assert(r.answer, 'no answer sentence');
    return r;
  };

  let aggFacts: Record<string, unknown> | undefined;

  if (point) {
    await check('select (point layer)', async () => {
      const r = await okOp({ kind: 'select', target_layer: point.code });
      assert(r.result && r.result.matched > 0, 'nothing matched');
      return r.answer!;
    });
    const grp = textCol(point);
    if (grp) {
      await check(`aggregate count by ${point.name}.${grp}`, async () => {
        const r = await okOp({ kind: 'aggregate', target_layer: point.code, metric: 'count', group_by: grp });
        assert(r.aggregate && r.aggregate.rows.length > 0, 'no groups');
        const total = r.aggregate.rows.reduce((s, x) => s + x.count, 0);
        assert(total === r.result!.matched || r.result!.truncated, `group total ${total} != selection ${r.result!.matched}`);
        aggFacts = r.facts;
        return r.answer!;
      });
    }
  }
  if (polygon && (point ?? line)) {
    const target = (point ?? line)!;
    await check(`aggregate ${target.name} per ${polygon.name} (zone join)`, async () => {
      const r = await okOp({
        kind: 'aggregate', target_layer: target.code, metric: 'count',
        group_by_layer: polygon.code, group_by_layer_field: textCol(polygon) ?? null,
      });
      assert(r.aggregate && r.aggregate.rows.length > 0, 'no zones');
      // a feature is counted at most once, so the zone total cannot exceed the layer total
      const all = await okOp({ kind: 'aggregate', target_layer: target.code, metric: 'count' });
      const inZones = r.aggregate.rows.reduce((s, x) => s + x.count, 0);
      const layerTotal = all.aggregate!.rows[0].count;
      assert(inZones <= layerTotal, `zone total ${inZones} > layer total ${layerTotal}`);
      return `${r.answer} [${inZones}/${layerTotal} features fall in a zone]`;
    });
  }
  if (line) {
    await check(`aggregate sum length of ${line.name} (geometry measure)`, async () => {
      const r = await okOp({ kind: 'aggregate', target_layer: line.code, metric: 'sum', metric_field: 'length' });
      const v = r.aggregate!.rows[0].value;
      assert(v != null && v > 0, `length ${v}`);
      return r.answer!;
    });
  }
  const numericLayer = [point, line, polygon].find((l) => numCol(l));
  if (numericLayer) {
    await check(`aggregate avg ${numericLayer.name}.${numCol(numericLayer)}`, async () => {
      const r = await okOp({ kind: 'aggregate', target_layer: numericLayer.code, metric: 'avg', metric_field: numCol(numericLayer)! });
      return r.answer!;
    });
  }
  if (point && polygon) {
    await check(`nearest 3 ${point.name} to first ${polygon.name}`, async () => {
      const lc = textCol(polygon);
      const sample = polygon.columns.find((c) => c.name === lc)?.sampleValues[0];
      const r = await okOp({
        kind: 'nearest', target_layer: point.code, reference_layer: polygon.code, count: 3,
        reference_filters: lc && sample ? [{ field: lc, op: '=', value: sample }] : [],
      });
      const items = r.nearest!.items;
      assert(items.length > 0, 'no items');
      for (let i = 1; i < items.length; i++) assert(items[i].distanceM >= items[i - 1].distanceM - 1e-6, 'not sorted by distance');
      return r.answer!;
    });
  }
  if (point) {
    await check(`nearest within same layer excludes the reference`, async () => {
      const r = await okOp({ kind: 'nearest', target_layer: point.code, reference_layer: point.code, count: 2,
        reference_filters: [{ field: point.pkColumn === 'id' ? 'id' : 'ogc_fid', op: '=', value: 1 }] });
      assert(r.nearest!.items.every((i) => i.distanceM > 0), 'returned the reference itself');
      return r.answer!;
    });
  }
  const bufferLayer = point ?? line;
  if (bufferLayer) {
    await check(`buffer 100 m around ${bufferLayer.name} (first 50)`, async () => {
      const r = await okOp({ kind: 'buffer', target_layer: bufferLayer.code, distance_meters: 100,
        attribute_filters: [{ field: bufferLayer.pkColumn === 'id' ? 'id' : 'ogc_fid', op: '<=', value: 50 }] });
      assert(r.buffer!.sources > 0 && (r.buffer!.areaM2 ?? 0) > 0, 'empty buffer');
      assert(r.overlays && r.overlays.length === 1, 'no buffer overlay');
      return r.answer!;
    });
  }
  if (point && line) {
    await check(`route between two ${point.name} on ${line.name}`, async () => {
      const pk = point.pkColumn === 'id' ? 'id' : 'ogc_fid';
      const r = await op({ kind: 'route', target_layer: point.code, attribute_filters: [{ field: pk, op: '=', value: 1 }],
        to_layer: point.code, to_filters: [{ field: pk, op: '=', value: Number(process.env.ROUTE_TO ?? 120) }], network_layer: line.code });
      if (r.answerKind === 'clarification') return `clarification (acceptable — network data): ${r.clarification}`;
      assert(r.route && r.route.lengthM > 0, 'no route');
      return r.answer!;
    });
    await check(`service area 1 km from a ${point.name}`, async () => {
      const pk = point.pkColumn === 'id' ? 'id' : 'ogc_fid';
      const r = await op({ kind: 'service_area', target_layer: point.code, attribute_filters: [{ field: pk, op: '=', value: 1 }],
        distance_meters: 1000, network_layer: line.code });
      if (r.answerKind === 'clarification') return `clarification (acceptable — network data): ${r.clarification}`;
      assert(r.serviceArea, 'no service area');
      return r.answer!;
    });
  }
  const any = catalog[0];
  await check('bad field -> clarification', async () => {
    const r = await op({ kind: 'aggregate', target_layer: any.code, metric: 'sum', metric_field: 'no_such_field' });
    assert(r.answerKind === 'clarification', r.answerKind);
    return r.clarification!;
  });
  await check('bad layer -> clarification', async () => {
    const r = await op({ kind: 'nearest', target_layer: any.code, reference_layer: 'HOSPITALS_XYZ' });
    assert(r.answerKind === 'clarification', r.answerKind);
    return r.clarification!.slice(0, 120);
  });
  await check('injection in a value is bound, not executed', async () => {
    const col = textCol(any) ?? any.columns[0].name;
    const r = await op({ kind: 'aggregate', target_layer: any.code, metric: 'count',
      attribute_filters: [{ field: col, op: '=', value: "x'; DROP TABLE gis_layers; --" }] });
    assert(r.answerKind === 'gis_operation', r.answerKind);
    const still = await prisma.gISLayer.count();
    assert(still > 0, 'gis_layers gone');
    return r.answer!;
  });

  // ----- outliers -----
  for (const layer of [point, line, polygon].filter(Boolean)) {
    await check(`validate outliers ${layer!.name}`, async () => {
      const res = await data.validate(user, layer!.layerId, { outliers: true });
      const outliers = res.issues.filter((i) => i.check === 'outlier');
      return `${outliers.length} outlier(s)` + (outliers[0] ? ` e.g. ${outliers[0].detail}` : '');
    });
  }
  if (point && textCol(point)) {
    await check(`validate outliers ${point.name} grouped by ${textCol(point)}`, async () => {
      const res = await data.validate(user, point.layerId, { outliers: true, outlierGroupField: textCol(point) });
      const outliers = res.issues.filter((i) => i.check === 'outlier');
      return `${outliers.length} outlier(s)` + (outliers[0] ? ` e.g. ${outliers[0].detail}` : '');
    });
  }

  // ----- semantic search -----
  await check('reindex AI catalog', async () => JSON.stringify(await aiClient.reindex(user.municipalityId)));
  for (const q of (process.env.QUERIES ?? 'water pipes,traffic signals,light poles,drainage,hospital').split(',')) {
    await check(`search "${q}"`, async () => {
      const r = await dashboard.search(user, q);
      return r.layers.map((l) => `${l.name}(${l.match}${l.matchedField ? ':' + l.matchedField : ''})`).join(', ') || '—';
    });
  }

  // ----- LLM wording -----
  if (process.env.SKIP_LLM !== '1') {
    if (aggFacts) {
      await check('narrate aggregate answer (LLM)', async () => {
        const r = await gisAi.narrate(user, { question: 'How many features are there in each group?', facts: aggFacts! });
        return r.text ?? '(rejected as ungrounded — computed answer kept)';
      });
    }
    await check('explain raster result (LLM)', async () => {
      const r = await gisAi.explain(user, {
        title: 'Green Cover',
        facts: [
          { label: 'Overall green cover', value: '18.4 %' },
          { label: 'Comparison period', value: '21.2 %' },
          { label: 'Change', value: '-2.8 points' },
        ],
        rows: [
          { zone: 'Ward 3', greenPct: 9.1, changePct: -6.4 },
          { zone: 'Ward 7', greenPct: 22.5, changePct: -0.4 },
        ],
      });
      return r.text ?? '(rejected as ungrounded)';
    });
  }

  await app.close();
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    const width = Math.max(...rows.map((r) => r.name.length), 10);
    for (const r of rows) {
      console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.seconds.toFixed(1).padStart(6)}s  ${r.note}`);
    }
    const failed = rows.filter((r) => !r.ok).length;
    console.log(`\n${rows.length - failed}/${rows.length} passed`);
    if (failed) process.exitCode = 1;
  });
