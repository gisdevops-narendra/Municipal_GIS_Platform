/**
 * Reads which projection an upload file is in, in the browser, before it
 * is uploaded (the server detects it again on import):
 *   .zip     → the Shapefile's .prj (WKT), or null when there is none
 *   .geojson → its "crs" member, else WGS 84 (RFC 7946)
 *   .csv     → WGS 84 for latitude/longitude columns
 */
export type SourceCrsHint =
  | { kind: 'epsg'; code: string }
  | { kind: 'wkt'; wkt: string }
  | { kind: 'none' };

const GEOJSON_SCAN_BYTES = 256 * 1024;

export async function readSourceCrs(file: File): Promise<SourceCrsHint> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.csv')) return { kind: 'epsg', code: 'EPSG:4326' };
  if (name.endsWith('.geojson') || name.endsWith('.json')) {
    const head = await file.slice(0, GEOJSON_SCAN_BYTES).text();
    const crs = /"crs"\s*:\s*\{[^}]*?"name"\s*:\s*"([^"]+)"/.exec(head)?.[1];
    const code = crs ? /EPSG:{1,2}(\d{4,6})/i.exec(crs)?.[1] : null;
    if (code) return { kind: 'epsg', code: `EPSG:${code}` };
    if (crs && /CRS84/i.test(crs)) return { kind: 'epsg', code: 'EPSG:4326' };
    return crs ? { kind: 'none' } : { kind: 'epsg', code: 'EPSG:4326' };
  }
  if (name.endsWith('.zip')) {
    const wkt = await readZipEntry(file, (entry) => entry.toLowerCase().endsWith('.prj'));
    return wkt?.trim() ? { kind: 'wkt', wkt: wkt.trim() } : { kind: 'none' };
  }
  return { kind: 'none' };
}

/** Text of the first ZIP entry matching `match` (stored or deflated). */
async function readZipEntry(file: File, match: (name: string) => boolean): Promise<string | null> {
  // End of central directory: in the last 64 KB + 22 bytes.
  const tailStart = Math.max(0, file.size - 65_557);
  const tail = new DataView(await file.slice(tailStart).arrayBuffer());
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const cdSize = tail.getUint32(eocd + 12, true);
  const cdOffset = tail.getUint32(eocd + 16, true);
  const cd = new DataView(await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const decoder = new TextDecoder();

  for (let p = 0; p + 46 <= cd.byteLength && cd.getUint32(p, true) === 0x02014b50; ) {
    const method = cd.getUint16(p + 10, true);
    const compressed = cd.getUint32(p + 20, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    const localOffset = cd.getUint32(p + 42, true);
    const entryName = decoder.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!match(entryName) || compressed > 1_000_000) continue;

    const local = new DataView(await file.slice(localOffset, localOffset + 30).arrayBuffer());
    const dataStart = localOffset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
    const data = file.slice(dataStart, dataStart + compressed);
    if (method === 0) return data.text();
    if (method === 8 && typeof DecompressionStream !== 'undefined') {
      const stream = data.stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Response(stream).text();
    }
    return null;
  }
  return null;
}
