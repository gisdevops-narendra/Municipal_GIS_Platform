/**
 * One-off: rewrite existing GeoServer SLD styles whose font-family names a
 * font the server doesn't have (Arial, Helvetica…) to the installed
 * equivalent (see src/gis/map-fonts.util.ts). Idempotent; only touches the
 * font-family values. Run inside the backend container:
 *   npx ts-node scripts/fix-style-fonts.ts
 */
import { substituteSldFonts } from '../src/gis/map-fonts.util';

const base = (process.env.GEOSERVER_URL ?? 'http://geoserver:8080/geoserver') + '/rest';
const auth =
  'Basic ' +
  Buffer.from(`${process.env.GEOSERVER_ADMIN_USER ?? 'admin'}:${process.env.GEOSERVER_ADMIN_PASSWORD ?? 'geoserver'}`).toString('base64');
const get = (path: string, accept = 'application/json') => fetch(base + path, { headers: { Authorization: auth, Accept: accept } });

async function main() {
  const ws = ((await (await get('/workspaces.json')).json()) as { workspaces?: { workspace?: { name: string }[] } }).workspaces?.workspace ?? [];
  let changed = 0;
  for (const { name: w } of ws) {
    const styles = ((await (await get(`/workspaces/${w}/styles.json`)).json()) as { styles?: { style?: { name: string }[] } }).styles?.style ?? [];
    for (const { name: s } of styles) {
      const info = (await (await get(`/workspaces/${w}/styles/${s}.json`)).json()) as { style?: { format?: string; languageVersion?: { version?: string } } };
      if ((info.style?.format ?? 'sld') !== 'sld') continue;
      const res = await get(`/workspaces/${w}/styles/${s}.sld`, 'application/vnd.ogc.sld+xml');
      if (!res.ok) continue;
      const sld = await res.text();
      const fixed = substituteSldFonts(sld);
      if (fixed === sld) continue;
      const v11 = info.style?.languageVersion?.version === '1.1.0';
      const put = await fetch(`${base}/workspaces/${w}/styles/${s}`, {
        method: 'PUT',
        headers: { Authorization: auth, 'Content-Type': v11 ? 'application/vnd.ogc.se+xml' : 'application/vnd.ogc.sld+xml' },
        body: fixed,
      });
      console.log(`${put.ok ? 'fixed ' : 'FAILED'} ${w}:${s}`);
      if (put.ok) changed++;
    }
  }
  console.log(`done — ${changed} style(s) updated`);
}
void main();
