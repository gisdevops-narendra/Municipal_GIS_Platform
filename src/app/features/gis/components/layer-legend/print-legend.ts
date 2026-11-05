import type { PrintLayerLegend } from '../../../../core/models/print.model';
import { LegendModel, RampStop } from './legend-model';
import { chipSvg, labelsSvg, rampSvg, swatchSvg } from './legend-svg';

/**
 * The print version of the app's native legend. MapFish puts a legend
 * class's name and icon on separate rows, so each legend line (symbol +
 * label, in the app's font) is drawn here as ONE PNG and MapFish only
 * stacks them. Row size matches the legend.jrxml column: 272 × 18 pt.
 */

const ROW_W = 272;
const ROW_H = 18;
const SW = 26;
const SH = 16;
const SCALE = 4; // print-sharp at up to ~300 dpi

interface Row {
  label: string;
  svg?: string;
  heading: boolean;
}

function stopLabel(s: RampStop): string {
  const n = parseFloat(s.label);
  if (s.label && !Number.isFinite(n)) return s.label;
  const v = Number.isFinite(n) ? n : s.quantity;
  return Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : String(Math.round(v * 100) / 100);
}

function loadSvg(svg: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  return img.decode().then(() => img);
}

function fit(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > max) t = t.slice(0, -1);
  return t + '…';
}

async function drawRow(row: Row, fontFamily: string): Promise<string | null> {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = ROW_W * SCALE;
    canvas.height = ROW_H * SCALE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.scale(SCALE, SCALE);

    let x = row.heading ? 0 : 12;
    if (row.svg) {
      ctx.drawImage(await loadSvg(row.svg), x, (ROW_H - SH) / 2, SW, SH);
      x += SW + 8;
    }
    ctx.font = row.heading ? `600 9px ${fontFamily}` : `400 8.5px ${fontFamily}`;
    ctx.fillStyle = row.heading ? '#1C2430' : '#3A4452';
    ctx.textBaseline = 'middle';
    ctx.fillText(fit(ctx, row.label, ROW_W - x - 2), x, ROW_H / 2 + 0.5);
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

function legendRows(name: string, model: LegendModel): Row[] {
  const rows: Row[] = [];
  const single = model.single && model.entries.length === 1;

  rows.push({ label: name, heading: true, svg: single ? swatchSvg(model.entries[0].symbols, SW, SH) : undefined });
  if (!single) {
    for (const e of model.entries) rows.push({ label: e.label, heading: false, svg: swatchSvg(e.symbols, SW, SH) });
  }

  const ramp = model.ramp;
  if (ramp?.type === 'ramp') {
    const first = ramp.stops[0], last = ramp.stops[ramp.stops.length - 1];
    const label = ramp.stops.length > 1 ? `${stopLabel(first)} – ${stopLabel(last)}` : stopLabel(first);
    rows.push({ label, heading: false, svg: rampSvg(ramp, SW, SH) });
  } else if (ramp) {
    for (const s of ramp.stops.slice(0, 40)) rows.push({ label: stopLabel(s), heading: false, svg: chipSvg(s.color, s.opacity, SW, SH) });
  }

  if (model.labels) rows.push({ label: `Labels: ${model.labels.field}`, heading: false, svg: labelsSvg(model.labels, SW, SH) });
  return rows.slice(0, 60);
}

/** Undefined when there is no legend to draw (the backend then falls
 *  back to GeoServer's legend image). */
export async function buildPrintLegend(name: string, model: LegendModel | null): Promise<PrintLayerLegend | undefined> {
  if (!model || (!model.entries.length && !model.ramp)) return undefined;
  await document.fonts?.ready;
  const fontFamily = getComputedStyle(document.body).fontFamily || 'sans-serif';
  const rows = (await Promise.all(legendRows(name, model).map((r) => drawRow(r, fontFamily)))).filter(
    (r): r is string => !!r
  );
  return rows.length ? { rows } : undefined;
}
