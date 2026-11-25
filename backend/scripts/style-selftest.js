/* Style self-test: every kind of style the Style editor can produce goes
 * through GeoServer — JSON legend, PNG legend and GetMap must all succeed.
 * Catches styles that save fine but break the legend or the map (e.g. YSLD
 * labels with unset values made GetLegendGraphic JSON throw an NPE).
 *
 * Run inside the backend container (uses its GeoServer env credentials and
 * the compiled generator; creates and deletes a temporary style):
 *   docker exec municipal-gis-backend npm run test:styles
 * Options (env): STYLE_TEST_WORKSPACE, STYLE_TEST_POLYGON_LAYER (+ _FIELD,
 * _NUM_FIELD), STYLE_TEST_POINT_LAYER (+ _FIELD, _NUM_FIELD), STYLE_TEST_BBOX.
 * A name filter can be passed as the first argument, e.g. "point/". */
const path = require('path');
const { YsldGenerator } = require(path.join(__dirname, '..', 'dist', 'src', 'gis', 'ysld-generator.js'));

const GS = process.env.GEOSERVER_URL;
const AUTH = 'Basic ' + Buffer.from(`${process.env.GEOSERVER_ADMIN_USER}:${process.env.GEOSERVER_ADMIN_PASSWORD}`).toString('base64');
const env = process.env;
const WS = env.STYLE_TEST_WORKSPACE ?? 'parul_chandera';
const STYLE = 'zz_selftest_style';
const POLY = { layer: env.STYLE_TEST_POLYGON_LAYER ?? 'zone', text: env.STYLE_TEST_POLYGON_FIELD ?? 'zone_name', num: env.STYLE_TEST_POLYGON_NUM_FIELD ?? 'shape_area' };
const PT = { layer: env.STYLE_TEST_POINT_LAYER ?? 'librery', text: env.STYLE_TEST_POINT_FIELD ?? 'name', num: env.STYLE_TEST_POINT_NUM_FIELD ?? 'objectid_1' };
// Line styles are checked on the polygon layer (the legend does not depend
// on the data; GetMap draws polygon outlines with a line symbolizer).
const LAYERS = { polygon: POLY.layer, point: PT.layer, line: POLY.layer };
const FIELD = { polygon: POLY, point: PT, line: POLY };
const BBOX = env.STYLE_TEST_BBOX ?? '72.4,22.9,72.8,23.2';

const gen = new YsldGenerator();
const variantFilter = process.argv[2] ?? '';

async function gs(path, init = {}) {
  return fetch(GS + path, { ...init, headers: { Authorization: AUTH, ...(init.headers ?? {}) } });
}

async function putStyle(ysld) {
  const exists = await gs(`/rest/workspaces/${WS}/styles/${STYLE}.json`);
  if (exists.status === 404) {
    const c = await gs(`/rest/workspaces/${WS}/styles`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ style: { name: STYLE, format: 'ysld', filename: `${STYLE}.ysld` } }),
    });
    if (!c.ok && c.status !== 409) throw new Error('create ' + c.status);
  }
  const r = await gs(`/rest/workspaces/${WS}/styles/${STYLE}?raw=true`, {
    method: 'PUT', headers: { 'Content-Type': 'application/vnd.geoserver.ysld+yaml' }, body: ysld,
  });
  if (!r.ok) return `PUT ${r.status}: ${(await r.text()).slice(0, 160)}`;
  return null;
}

async function check(layer) {
  const base = `/${WS}/wms?service=WMS&version=1.1.1&layer=${WS}:${layer}&style=${WS}:${STYLE}`;
  const errors = [];
  const j = await gs(`${base}&request=GetLegendGraphic&format=application/json`);
  const jt = await j.text();
  try {
    const d = JSON.parse(jt);
    if (!d.Legend?.[0]?.rules?.length) errors.push('json: no rules');
  } catch {
    errors.push('json: ' + (/<ServiceException[^>]*>\s*([\s\S]*?)<\/ServiceException>/.exec(jt)?.[1] ?? jt).trim().slice(0, 120));
  }
  const p = await gs(`${base}&request=GetLegendGraphic&format=image/png`);
  const pb = Buffer.from(await p.arrayBuffer());
  if (pb.slice(1, 4).toString() !== 'PNG') errors.push('png legend: ' + pb.toString().slice(0, 120).replace(/\s+/g, ' '));
  const m = await gs(`/${WS}/wms?service=WMS&version=1.1.1&request=GetMap&layers=${WS}:${layer}&styles=${WS}:${STYLE}&bbox=${BBOX}&width=128&height=128&srs=EPSG:4326&format=image/png`);
  const mb = Buffer.from(await m.arrayBuffer());
  if (mb.slice(1, 4).toString() !== 'PNG') errors.push('getmap: ' + mb.toString().slice(0, 120).replace(/\s+/g, ' '));
  return errors;
}

const sym = (geometry, extra = {}) => ({
  fillColor: '#128077', fillOpacity: 0.45, strokeColor: '#0b4f4a', strokeWidth: 1, strokeOpacity: 1,
  ...(geometry === 'point' ? { markShape: 'circle', markSize: 8 } : {}),
  ...extra,
});

function labels(geometry, o = {}) {
  return {
    enabled: true, field: FIELD[geometry].text, font: 'SansSerif', size: 12, color: '#1c2430', haloColor: '#ffffff',
    haloWidth: 1.5, rotation: 0, offsetX: 0, offsetY: 0, placement: geometry === 'line' ? 'line' : 'point', ...o,
  };
}

function variants() {
  const out = [];
  for (const geometry of ['polygon', 'point', 'line']) {
    const f = FIELD[geometry];
    const modes = {
      single: {},
      categorized: {
        categorize: {
          field: f.text, includeOther: true,
          categories: [
            { value: 'CENTRAL ZONE', label: 'Central', symbol: sym(geometry, { fillColor: '#440154' }) },
            { value: "O'Brien & <Co>", symbol: sym(geometry, { fillColor: '#21918c' }) },
            { value: 42, symbol: sym(geometry, { fillColor: '#fde725' }) },
          ],
        },
      },
      categorizedNoOther: {
        categorize: { field: f.text, includeOther: false, categories: [{ value: 'A', symbol: sym(geometry) }, { value: 'B', symbol: sym(geometry) }] },
      },
      graduated: {
        graduate: { field: f.num, method: 'quantile', classCount: 3, breaks: [1, 2.4, 3.8e6, 2.7684959693844e7], ramp: ['#440154', '#21918c', '#fde725'], ...(geometry === 'point' ? { sizeRange: [4, 16] } : {}) },
      },
    };
    const labelSets = {
      none: undefined,
      basic: labels(geometry),
      noHalo: labels(geometry, { haloWidth: 0 }),
      offsetRot: labels(geometry, { offsetX: -1, offsetY: 3, rotation: 45, size: 18 }),
      serif: labels(geometry, { font: 'Serif' }),
      mono: labels(geometry, { font: 'Monospaced', haloWidth: 6 }),
    };
    for (const [mode, m] of Object.entries(modes)) {
      for (const [ln, l] of Object.entries(labelSets)) {
        out.push({
          name: `${geometry}/${mode}/labels=${ln}`, geometry,
          spec: { version: 1, geometry, mode: mode.startsWith('categorized') ? 'categorized' : mode, symbol: sym(geometry), ...m, ...(l ? { labels: l } : {}) },
        });
      }
    }
    out.push({ name: `${geometry}/single/scale`, geometry, spec: { version: 1, geometry, mode: 'single', symbol: sym(geometry), scale: { minDenominator: 1000, maxDenominator: 5e6 }, labels: labels(geometry) } });
    out.push({ name: `${geometry}/single/dash+cap`, geometry, spec: { version: 1, geometry, mode: 'single', symbol: sym(geometry, { strokeDash: [6, 3], strokeCap: 'round', strokeWidth: 0 }) } });
    out.push({ name: `${geometry}/single/zero-opacity`, geometry, spec: { version: 1, geometry, mode: 'single', symbol: sym(geometry, { fillOpacity: 0, strokeOpacity: 0 }) } });
    if (geometry === 'point') {
      for (const shape of ['circle', 'square', 'triangle', 'star', 'cross', 'x']) {
        out.push({ name: `point/single/mark=${shape}`, geometry, spec: { version: 1, geometry, mode: 'single', symbol: sym(geometry, { markShape: shape, markRotation: 30 }), labels: labels(geometry) } });
      }
    }
  }
  return out;
}

(async () => {
  let pass = 0;
  const fails = [];
  for (const v of variants().filter((x) => x.name.includes(variantFilter))) {
    let ysld;
    try {
      ysld = gen.generate(v.spec, STYLE);
    } catch (e) {
      fails.push([v.name, 'generate: ' + e.message]);
      continue;
    }
    const putErr = await putStyle(ysld);
    if (putErr) { fails.push([v.name, putErr]); continue; }
    const errs = await check(LAYERS[v.geometry]);
    if (errs.length) fails.push([v.name, errs.join(' | ')]);
    else pass++;
  }
  await gs(`/rest/workspaces/${WS}/styles/${STYLE}?purge=true&recurse=true`, { method: 'DELETE' });
  console.log(`PASS ${pass}  FAIL ${fails.length}`);
  for (const [n, e] of fails) console.log(`  ✗ ${n}: ${e}`);
  process.exitCode = fails.length ? 1 : 0;
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
