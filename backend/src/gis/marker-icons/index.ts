import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '@nestjs/common';

export interface MarkerIcon {
  id: string;
  label: string;
  category: string;
  /** [x, y] in 0..1 — where the point sits on the graphic. Pins anchor at
   *  the tip (0.5, 1); centred shapes at (0.5, 0.5). */
  anchor: [number, number];
}

const logger = new Logger('MarkerIcons');

/**
 * Where the bundled `.svg` + `manifest.json` live at runtime. Normally
 * `__dirname` (nest-cli copies the assets next to the compiled `index.js`
 * — see nest-cli.json). The extra candidates keep this working if the
 * build's `rootDir` shifts (the repo currently emits to `dist/src/…`, but
 * that depends on which `.ts` files are in the compile) or when running
 * straight from `src` under ts-node / jest.
 */
function resolveIconDir(): string {
  const candidates = [
    __dirname,
    path.join(process.cwd(), 'dist', 'src', 'gis', 'marker-icons'),
    path.join(process.cwd(), 'dist', 'gis', 'marker-icons'),
    path.join(process.cwd(), 'src', 'gis', 'marker-icons'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'manifest.json'))) return dir;
  }
  logger.error(
    `marker-icons manifest not found (looked in: ${candidates.join(', ')})`,
  );
  return __dirname;
}

const DIR = resolveIconDir();

/** The bundled marker-icon set (original artwork, CC0 — see LICENSE.txt). */
export const MARKER_ICONS: MarkerIcon[] = (() => {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'),
    ) as MarkerIcon[];
  } catch {
    return [];
  }
})();

const BY_ID = new Map(MARKER_ICONS.map((icon) => [icon.id, icon]));

export function isBuiltinIcon(id: string): boolean {
  return BY_ID.has(id);
}

export function markerIcon(id: string): MarkerIcon | undefined {
  return BY_ID.get(id);
}

/** Raw SVG bytes of a bundled icon, or null for an unknown id. */
export function readMarkerIcon(id: string): Buffer | null {
  if (!BY_ID.has(id)) return null;
  try {
    return fs.readFileSync(path.join(DIR, `${id}.svg`));
  } catch {
    return null;
  }
}
