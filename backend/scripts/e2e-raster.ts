/**
 * Raster Analysis end-to-end check (no browser): boots the real Nest
 * application context and runs every tool through the same services the
 * API uses — job queue, GDAL, PostGIS, GeoServer publishing and styling —
 * as the municipality owner. Layers it creates are deleted at the end
 * unless KEEP=1.
 *
 *   docker exec municipal-gis-backend npx ts-node -r tsconfig-paths/register scripts/e2e-raster.ts
 *
 * Env: MUNICIPALITY_ID (default: the first owner's), ONLY=<substring> to run
 * a subset, SKIP_ONLINE=1 to skip internet-backed tools.
 */
// A second application context must not resume the server's jobs or run
// its monitor scheduler.
process.env.RASTER_JOBS_RESUME = '0';
process.env.RASTER_MONITOR_SCHEDULER = '0';

import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { RasterJobsService } from '../src/gis/raster-jobs.service';
import { RasterToolsService } from '../src/gis/raster-tools.service';
import { RasterService } from '../src/gis/raster.service';
import { RasterWorkspaceService } from '../src/gis/raster-workspace.service';
import { RasterMonitorService } from '../src/gis/raster-monitor.service';
import { GisLayersService } from '../src/gis/gis-layers.service';
import type { AppUser } from '../src/auth/types/app-user.type';

type Row = { group: string; name: string; ok: boolean; seconds: number; note: string };
const rows: Row[] = [];
const created: string[] = [];
const ids: Record<string, string> = {};
const BBOX: [number, number, number, number] = [73.17, 22.29, 73.2, 22.32];
const sq = (lon: number, lat: number, d: number) => ({
  type: 'Polygon',
  coordinates: [[[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]]],
});

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const prisma = app.get(PrismaService);
  const jobs = app.get(RasterJobsService);
  const tools = app.get(RasterToolsService);
  const rasters = app.get(RasterService);
  const workspace = app.get(RasterWorkspaceService);
  const monitors = app.get(RasterMonitorService);
  const layers = app.get(GisLayersService);

  const owner = await prisma.user.findFirstOrThrow({
    where: { systemRole: 'MUNICIPALITY_OWNER', ...(process.env.MUNICIPALITY_ID ? { municipalityId: process.env.MUNICIPALITY_ID } : {}) },
  });
  const user: AppUser = {
    id: owner.id, keycloakUserId: owner.keycloakUserId, municipalityId: owner.municipalityId,
    departmentId: owner.departmentId, systemRole: owner.systemRole, status: owner.status,
  };
  const layer = async (name: string) =>
    (await prisma.gISLayer.findFirstOrThrow({ where: { name, gisWorkspace: { municipalityId: user.municipalityId } } })).id;
  ids.dem = await layer('Elevation (Copernicus DEM) Clip to Boundary');
  ids.ward = await layer('ward');
  ids.aoi = await layer('vmc_aoi');
  ids.trees = await layer('garden_tree_location');
  ids.gardens = await layer('garden_bdy');

  const only = process.env.ONLY;
  const online = process.env.SKIP_ONLINE !== '1';

  /** Runs one check; `run` returns a short note. */
  async function check(group: string, name: string, run: () => Promise<string>, needsOnline = false) {
    if (only && !`${group} ${name}`.toLowerCase().includes(only.toLowerCase())) return;
    if (needsOnline && !online) return;
    const t = Date.now();
    try {
      const note = await run();
      rows.push({ group, name, ok: true, seconds: (Date.now() - t) / 1000, note });
    } catch (e) {
      rows.push({ group, name, ok: false, seconds: (Date.now() - t) / 1000, note: (e as Error).message.slice(0, 160) });
    }
    const r = rows[rows.length - 1];
    console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.group} · ${r.name} (${r.seconds.toFixed(0)} s) ${r.note}`);
  }

  /** A background job, awaited; returns its result and tracks new layers. */
  async function job(tool: string, body: Record<string, unknown>, key?: string): Promise<{ layer?: { id: string; name: string; styleName?: string | null }; result?: Record<string, unknown> }> {
    const started = await jobs.start(user, tool, body);
    for (;;) {
      await new Promise((r) => setTimeout(r, 1500));
      const j = jobs.get(user, started.id);
      if (j.status === 'done') {
        const res = (j.result ?? {}) as { layer?: { id: string; name: string; styleName?: string | null }; result?: Record<string, unknown> };
        if (res.layer?.id) {
          created.push(res.layer.id);
          if (key) ids[key] = res.layer.id;
        }
        return res;
      }
      if (j.status === 'failed' || j.status === 'cancelled') throw new Error(j.error ?? j.status);
    }
  }
  const published = (r: { layer?: { name: string; styleName?: string | null } }) => {
    if (!r.layer) throw new Error('no layer was published');
    return `→ "${r.layer.name}"${r.layer.styleName ? ' (styled)' : ' (UNSTYLED)'}`;
  };
  const out = (name: string) => `E2E ${name}`;
  const base = (name: string) => ({ layerId: ids.dem, outputName: out(name) });

  // ----- Data -----
  await check('Data', 'Info + style read', async () => {
    const i = await rasters.info(user, ids.dem);
    return `${i.width}×${i.height}, ${i.bandCount} band, style ${i.styleSpec ? 'yes' : 'no'}`;
  });
  await check('Data', 'Statistics', async () => {
    const s = (await tools.statistics(user, { layerId: ids.dem, bins: 20 })) as { median: number };
    return `median ${s.median.toFixed(1)}`;
  });
  await check('Data', 'Download (whole + view)', async () => {
    const a = await rasters.download(user, ids.dem);
    const b = await rasters.download(user, ids.dem, BBOX);
    return `${(a.body.length / 1e6).toFixed(1)} MB, view ${(b.body.length / 1e3).toFixed(0)} kB`;
  });
  await check('Data', 'Online: elevation', async () => published(await job('online', { source: 'dem', bbox: BBOX, outputName: out('dem') }, 'dem2')), true);
  await check('Data', 'Online: land cover', async () => published(await job('online', { source: 'landcover', bbox: BBOX, outputName: out('landcover') }, 'landcover')), true);
  await check('Data', 'Online: Sentinel-2 composite', async () =>
    published(await job('online', { source: 'composite', bbox: BBOX, from: '2026-01-01', to: '2026-03-31', maxCloud: 40, maxScenes: 3, outputName: out('s2') }, 's2')), true);
  await check('Data', 'Online: population', async () => published(await job('online', { source: 'population', bbox: BBOX, outputName: out('population') }, 'population')), true);
  await check('Data', 'Online: surface water', async () => published(await job('online', { source: 'water', bbox: BBOX, outputName: out('water') })), true);
  await check('Data', 'Mosaic', async () => {
    if (!ids.dem2) throw new Error('needs the online elevation result');
    return published(await job('mosaic', { layerIds: [ids.dem, ids.dem2], outputName: out('mosaic') }));
  });
  await check('Data', 'Resample (UTM, 60 m)', async () => published(await job('resample', { ...base('resample'), pixelSize: 60, targetCrs: 'UTM' })));
  await check('Data', 'Rasterize vector', async () => published(await job('rasterize', { vectorLayerId: ids.gardens, pixelSize: 20, outputName: out('rasterize') })));
  await check('Data', 'Fill NoData', async () => published(await job('fill-nodata', { ...base('fill'), maxDistance: 20, smoothPasses: 1 })));

  // ----- Terrain -----
  for (const kind of ['slope', 'aspect', 'hillshade', 'multihillshade', 'curvature', 'TRI'] as const) {
    await check('Terrain', `Terrain: ${kind}`, async () => published(await job('terrain', { ...base(kind), kind }, kind === 'slope' ? 'slope' : undefined)));
  }
  await check('Terrain', 'Contours', async () => published(await job('contour', { ...base('contour'), interval: 5 })));
  await check('Terrain', 'Fill sinks', async () => published(await job('fill-sinks', base('filled'), 'filled')));
  await check('Terrain', 'Stream network', async () => published(await job('streams', { ...base('streams'), thresholdKm2: 2 })));
  await check('Terrain', 'Watershed (accumulation)', async () => published(await job('watershed', { ...base('accumulation'), mode: 'accumulation' })));
  await check('Terrain', 'Flood inundation', async () => published(await job('flood', { ...base('flood'), level: 30 })));
  await check('Terrain', 'Viewshed (2 observers)', async () =>
    published(await job('viewshed', { ...base('viewshed'), point: [73.18, 22.3], points: [[73.18, 22.3], [73.2, 22.31]], observerHeight: 20 })));
  await check('Terrain', 'Flood risk (HAND)', async () => published(await job('flood-risk', { ...base('hand'), thresholdKm2: 2 }, 'hand')));
  await check('Terrain', 'Object heights', async () =>
    published(await job('object-heights', { dsmLayerId: ids.filled ?? ids.dem, dtmLayerId: ids.dem, minHeight: 0.1, outputName: out('heights') })));
  await check('Terrain', 'Profile / LOS / cut-fill / 3D mesh', async () => {
    const p = (await tools.profile(user, { layerId: ids.dem, line: [[73.17, 22.29], [73.2, 22.32]] })) as { lengthM: number };
    const l = (await tools.lineOfSight(user, { layerId: ids.dem, from: [73.17, 22.29], to: [73.2, 22.32] })) as { targetVisible: boolean };
    const c = (await tools.cutFill(user, { layerId: ids.dem, polygon: sq(73.18, 22.3, 0.005), baseFromBoundary: true })) as { cutM3: number };
    const m = (await rasters.mesh(user, ids.dem, 1, 60)) as { width: number };
    return `profile ${(p.lengthM / 1000).toFixed(1)} km, LOS ${l.targetVisible}, stockpile cut ${Math.round(c.cutM3)} m³, mesh ${m.width}`;
  });

  // ----- Analytics -----
  await check('Analytics', 'Raster calculator', async () => published(await job('calculator', { inputs: [{ layerId: ids.dem }], expression: 'where(A > 30, 1, 0)', outputName: out('calc') })));
  await check('Analytics', 'Reclassify', async () =>
    published(await job('reclassify', { ...base('reclass'), rules: [{ min: 0, max: 30, value: 1, label: 'Low' }, { min: 30, max: 200, value: 2, label: 'High' }] }, 'reclass')));
  await check('Analytics', 'Clip (ward 10 from layer)', async () =>
    published(await job('clip', { ...base('clip'), boundaryLayerId: ids.ward, boundaryField: 'wardno', boundaryValue: '10' })));
  await check('Analytics', 'Raster to vector', async () => published(await job('polygonize', { layerId: ids.reclass, outputName: out('polygons') })));
  await check('Analytics', 'Zonal statistics (+choropleth)', async () =>
    published(await job('zonal-statistics', { layerId: ids.dem, zonesLayerId: ids.ward, labelField: 'wardno', outputName: out('zonal') })));
  await check('Analytics', 'IDW', async () => published(await job('idw', { vectorLayerId: ids.trees, field: 'objectid', pixelSize: 50, outputName: out('idw') })));
  await check('Analytics', 'Heatmap', async () => published(await job('heatmap', { vectorLayerId: ids.trees, pixelSize: 20, radius: 300, outputName: out('heatmap') })));
  await check('Analytics', 'Proximity', async () => published(await job('proximity', { vectorLayerId: ids.trees, pixelSize: 30, maxDistance: 1500, outputName: out('proximity') })));
  await check('Analytics', 'Hotspots (Gi*)', async () => published(await job('hotspot', { vectorLayerId: ids.trees, cellSize: 100, distance: 500, outputName: out('hotspot') })));
  await check('Analytics', 'Extract values to points', async () =>
    published(await job('extract-values', { vectorLayerId: ids.trees, rasterLayerIds: [ids.dem], outputName: out('extract') })));
  await check('Analytics', 'Least-cost path', async () =>
    published(await job('least-cost', { layerId: ids.slope ?? ids.dem, from: [73.17, 22.29], to: [73.2, 22.32], baseCost: 1, outputName: out('route') })));

  // ----- Imagery (needs the Sentinel-2 composite) -----
  if (ids.s2) {
    await check('Imagery', 'NDVI', async () => published(await job('ndvi', { layerId: ids.s2, redBand: 3, nirBand: 4, outputName: out('ndvi') })));
    await check('Imagery', 'Spectral index (NDWI)', async () =>
      published(await job('spectral-index', { layerId: ids.s2, kind: 'ndwi', bandA: 2, bandB: 4, outputName: out('ndwi') })));
    await check('Imagery', 'Unsupervised classification', async () => published(await job('classify', { layerId: ids.s2, classes: 4, outputName: out('kmeans') }, 'kmeans')));
    await check('Imagery', 'Supervised classification', async () =>
      published(await job('supervised-classify', {
        layerId: ids.s2, outputName: out('supervised'),
        classes: [{ label: 'A', geometry: sq(73.175, 22.295, 0.002) }, { label: 'B', geometry: sq(73.195, 22.315, 0.002) }],
      })));
    if (ids.landcover && ids.kmeans) {
      await check('Imagery', 'Change matrix', async () =>
        published(await job('change-matrix', { beforeLayerId: ids.landcover, afterLayerId: ids.kmeans, outputName: out('matrix') })));
    }
  }
  await check('Imagery', 'Index time series (point)', async () => {
    const r = await job('index-series', { kind: 'ndvi', bbox: [73.18, 22.3, 73.1803, 22.3003], from: '2026-08-01', to: '2026-10-15' });
    return `${(r as { observations?: number }).observations ?? (r.result as { observations?: number } | undefined)?.observations ?? '?'} dates`;
  }, true);
  await check('Imagery', 'Urban heat island', async () =>
    published(await job('heat-island', { bbox: BBOX, from: '2026-03-01', to: '2026-05-31', outputName: out('lst') })), true);
  await check('Imagery', 'Air quality (NO₂, 2 orbits)', async () =>
    published(await job('air-quality', { bbox: BBOX, from: '2026-10-01', to: '2026-10-05', maxOrbits: 2, outputName: out('no2') })), true);

  // ----- Planning -----
  await check('Planning', 'Site suitability', async () =>
    published(await job('suitability', {
      criteria: [{ layerId: ids.slope ?? ids.dem, direction: 'lower', weight: 60 }, { layerId: ids.dem, direction: 'higher', weight: 40 }],
      outputName: out('suitability'),
    })));
  if (ids.population && ids.hand) {
    await check('Planning', 'Population exposure (by ward)', async () => {
      const r = await job('exposure', { populationLayerId: ids.population, hazardLayerId: ids.hand, operator: '<=', threshold: 2, zonesLayerId: ids.ward, labelField: 'wardno' });
      const x = r.result as { exposed: number; population: number };
      return `${Math.round(x.exposed)} of ${Math.round(x.population)} people exposed`;
    });
  }
  await check('Planning', 'Area report (ward 10)', async () => {
    const r = await job('area-report', { zonesLayerId: ids.ward, filterField: 'wardno', filterValue: '10', rasterLayerIds: [ids.dem, ...(ids.landcover ? [ids.landcover] : [])] });
    const x = r.result as { areaM2: number; sections: unknown[] };
    return `${(x.areaM2 / 1e6).toFixed(1)} km², ${x.sections.length} sections`;
  });
  await check('Planning', 'Green cover (ward 10, vs last year)', async () => {
    const r = await job('green-cover', { zonesLayerId: ids.ward, labelField: 'wardno', filterField: 'wardno', filterValue: '10', from: '2026-08-15', to: '2026-10-15', compareFrom: '2025-08-15', compareTo: '2025-10-15', outputName: out('green') });
    return `${published(r)} · ${(r.result as { overallGreenPct: number }).overallGreenPct.toFixed(1)} % green`;
  }, true);
  await check('Planning', 'Encroachment (ward 10)', async () => {
    const r = await job('encroachment', { zonesLayerId: ids.ward, labelField: 'wardno', filterField: 'wardno', filterValue: '10', beforeFrom: '2025-01-01', beforeTo: '2025-03-31', afterFrom: '2026-01-01', afterTo: '2026-03-31' });
    return `${(r.result as { count: number }).count} sites`;
  }, true);

  // ----- Workspace -----
  await check('Workspace', 'Workflow: fill sinks → streams', async () => {
    const wf = await workspace.createWorkflow(user, 'E2E workflow', [
      { tool: 'fill-sinks', body: { layerId: '$input', outputName: out('wf filled') } },
      { tool: 'streams', body: { layerId: '$prev', thresholdKm2: 2, outputName: out('wf streams') } },
    ]);
    const started = await workspace.runWorkflow(user, wf.id, ids.dem);
    let j = jobs.get(user, started.id);
    while (j.status === 'queued' || j.status === 'running') {
      await new Promise((r) => setTimeout(r, 1500));
      j = jobs.get(user, started.id);
    }
    await workspace.deleteWorkflow(user, wf.id);
    if (j.status !== 'done') throw new Error(j.error ?? j.status);
    const steps = ((j.result as { result: { steps: { layerId?: string }[] } }).result.steps);
    steps.forEach((s) => s.layerId && created.push(s.layerId));
    return `${steps.length} steps, chained`;
  });
  await check('Workspace', 'Job history', async () => `${(await jobs.history(user)).length} entries`);
  await check('Workspace', 'Storage summary', async () => {
    const s = await workspace.storage(user);
    return `${(s.totalBytes / 1e6).toFixed(1)} MB in ${s.layers.length} results`;
  });
  await check('Workspace', 'Dashboard pin create/delete', async () => {
    const p = await workspace.createPin(user, { title: 'E2E pin', value: '42' });
    await workspace.deletePin(user, p.id);
    return 'ok';
  });
  await check('Workspace', 'Monitor create/pause/delete', async () => {
    const m = await monitors.create(user, { name: 'E2E monitor', kind: 'green-cover', frequency: 'monthly', params: { zonesLayerId: ids.ward, filterField: 'wardno', filterValue: '10' } });
    await monitors.setActive(user, m.id, false);
    await monitors.remove(user, m.id);
    return 'ok';
  });

  // ----- report + cleanup -----
  const pass = rows.filter((r) => r.ok).length;
  console.log(`\n${pass} / ${rows.length} passed`);
  for (const r of rows.filter((x) => !x.ok)) console.log(`  FAIL ${r.group} · ${r.name}: ${r.note}`);
  if (process.env.KEEP !== '1') {
    let removed = 0;
    for (const id of [...new Set(created)].reverse()) {
      await layers.deleteLayer(user, id).then(() => removed++).catch((e: Error) => console.log(`  could not delete ${id}: ${e.message}`));
    }
    console.log(`Cleaned up ${removed} test layers.`);
  }
  await app.close();
  process.exit(0);
}

main().catch((e) => {
  Logger.error(e);
  process.exit(1);
});
