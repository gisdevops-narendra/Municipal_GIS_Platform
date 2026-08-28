import { Injectable } from '@nestjs/common';
import type {
  LabelSpecDto,
  LayerStyleSpecDto,
  SymbolSpecDto,
} from './dto/layer-style.dto';

/**
 * Pure `LayerStyleSpec → YSLD` translator. No I/O — every method is
 * deterministic and unit-tested, and GeoServer validates the output on
 * PUT (a 400 there is the last line of defence). YSLD reference:
 * https://docs.geoserver.org/latest/en/user/styling/ysld/reference/
 *
 * Covered: point / line / polygon / raster geometry symbolizers; fill,
 * stroke, outline, opacity, dash, linecap/join; single / categorized /
 * graduated rules; labels (font, halo, rotation, offset, placement);
 * scale-dependent rules; external-graphic point markers. Advanced YSLD
 * (multi-symbolizer stacks, free expressions, full raster contrast
 * enhancement) is intentionally left for later — see docs/backend.md.
 */
@Injectable()
export class YsldGenerator {
  generate(spec: LayerStyleSpecDto, styleName: string): string {
    const rules =
      spec.geometry === 'raster'
        ? [this.rasterRule(spec)]
        : this.vectorRules(spec);

    const body = rules.map((rule) => this.indent(rule, 6)).join('\n');
    return [
      `name: ${this.quote(styleName)}`,
      'feature-styles:',
      '  - name: default',
      '    rules:',
      body,
      '',
    ].join('\n');
  }

  // ---- vector -------------------------------------------------------

  private vectorRules(spec: LayerStyleSpecDto): string[] {
    const scale = this.scaleFragment(spec);
    const label =
      spec.labels?.enabled && spec.labels.field
        ? this.textSymbolizer(spec.labels)
        : null;

    if (spec.mode === 'categorized' && spec.categorize?.categories.length) {
      const { field, categories, includeOther } = spec.categorize;
      const rules = categories.map((category) =>
        this.rule({
          name: category.label || String(category.value),
          scale,
          filter: `\${${this.q(field)} = ${this.ecqlLiteral(category.value)}}`,
          symbolizers: [
            this.geometrySymbolizer(spec.geometry, category.symbol),
            label,
          ],
        }),
      );
      if (includeOther) {
        rules.push(
          this.rule({
            name: 'Other',
            scale,
            else: true,
            symbolizers: [
              this.geometrySymbolizer(spec.geometry, spec.symbol),
              label,
            ],
          }),
        );
      }
      return rules;
    }

    if (spec.mode === 'graduated' && spec.graduate) {
      const { field, breaks, ramp } = spec.graduate;
      const classes = Math.max(0, breaks.length - 1);
      const rules: string[] = [];
      for (let i = 0; i < classes; i++) {
        const lo = breaks[i];
        const hi = breaks[i + 1];
        const last = i === classes - 1;
        const filter = last
          ? `\${${this.q(field)} >= ${lo} AND ${this.q(field)} <= ${hi}}`
          : `\${${this.q(field)} >= ${lo} AND ${this.q(field)} < ${hi}}`;
        rules.push(
          this.rule({
            name: `${this.num(lo)} – ${this.num(hi)}`,
            scale,
            filter,
            symbolizers: [
              this.geometrySymbolizer(spec.geometry, {
                ...spec.symbol,
                fillColor: ramp[i] ?? spec.symbol.fillColor,
                strokeColor:
                  spec.geometry === 'line'
                    ? (ramp[i] ?? spec.symbol.strokeColor)
                    : spec.symbol.strokeColor,
              }),
              label,
            ],
          }),
        );
      }
      return rules.length ? rules : [this.singleRule(spec, scale, label)];
    }

    return [this.singleRule(spec, scale, label)];
  }

  private singleRule(
    spec: LayerStyleSpecDto,
    scale: [number | null, number | null] | null,
    label: string | null,
  ): string {
    return this.rule({
      scale,
      symbolizers: [this.geometrySymbolizer(spec.geometry, spec.symbol), label],
    });
  }

  // ---- raster ------------------------------------------------------

  private rasterRule(spec: LayerStyleSpecDto): string {
    const raster = spec.raster ?? { opacity: 1, colorMap: [] };
    const entries = raster.colorMap
      .slice()
      .sort((a, b) => a.quantity - b.quantity)
      .map(
        (entry) =>
          `        - [${this.quote(entry.color)}, ${entry.opacity ?? 1}, ${entry.quantity}]`,
      )
      .join('\n');
    const colorMap = entries
      ? ['    color-map:', '      type: ramp', '      entries:', entries].join(
          '\n',
        )
      : '';
    return [
      '- symbolizers:',
      '    - raster:',
      `        opacity: ${this.clamp01(raster.opacity)}`,
      colorMap ? this.indent(colorMap, 4) : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  // ---- rule + symbolizer builders --------------------------------

  private rule(input: {
    name?: string;
    scale?: [number | null, number | null] | null;
    filter?: string;
    else?: boolean;
    symbolizers: (string | null)[];
  }): string {
    const head: string[] = [];
    if (input.name) head.push(`name: ${this.quote(input.name)}`);
    if (input.else) head.push('else: true');
    if (input.filter) head.push(`filter: ${input.filter}`);
    if (input.scale && (input.scale[0] !== null || input.scale[1] !== null)) {
      head.push(`scale: [${input.scale[0] ?? 0}, ${input.scale[1] ?? 'inf'}]`);
    }
    head.push('symbolizers:');

    const symbolizers = input.symbolizers
      .filter((s): s is string => !!s)
      .map((s) => this.indent(s, 2))
      .join('\n');

    // first head line carries the "- "; the rest are indented two spaces.
    const [first, ...rest] = head;
    return [
      `- ${first}`,
      ...rest.map((line) => `  ${line}`),
      this.indent(symbolizers, 2),
    ].join('\n');
  }

  private geometrySymbolizer(
    geometry: LayerStyleSpecDto['geometry'],
    symbol: SymbolSpecDto,
  ): string {
    if (geometry === 'point') return this.pointSymbolizer(symbol);
    if (geometry === 'line') return this.lineSymbolizer(symbol);
    return this.polygonSymbolizer(symbol);
  }

  private pointSymbolizer(s: SymbolSpecDto): string {
    const size = s.markSize ?? 8;
    const rotation = s.markRotation ?? 0;
    if (s.icon) {
      // `s.icon.name` is a relative ExternalGraphic URL — StyleService has
      // already put the file in the workspace's style resource dir, so
      // GeoServer resolves it against `workspaces/<ws>/styles/`.
      const lines = [
        '- point:',
        '    symbols:',
        '      - external:',
        `          url: ${this.quote(s.icon.name)}`,
        `          format: ${this.quote(s.icon.mime)}`,
        `    size: ${size > 8 ? size : 20}`,
        `    rotation: ${rotation}`,
      ];
      if (s.iconOpacity != null) {
        lines.push(`    opacity: ${this.clamp01(s.iconOpacity)}`);
      }
      if (s.iconAnchorX != null || s.iconAnchorY != null) {
        lines.push(
          `    anchor: [${this.clamp01(s.iconAnchorX ?? 0.5)}, ${this.clamp01(s.iconAnchorY ?? 0.5)}]`,
        );
      }
      return lines.join('\n');
    }
    const mark: string[] = [
      '      - mark:',
      `          shape: ${s.markShape ?? 'circle'}`,
    ];
    if (s.fillColor)
      mark.push(`          fill-color: ${this.quote(s.fillColor)}`);
    if (s.fillOpacity != null)
      mark.push(`          fill-opacity: ${this.clamp01(s.fillOpacity)}`);
    if (s.strokeColor)
      mark.push(`          stroke-color: ${this.quote(s.strokeColor)}`);
    if (s.strokeWidth != null)
      mark.push(`          stroke-width: ${s.strokeWidth}`);
    if (s.strokeOpacity != null)
      mark.push(`          stroke-opacity: ${this.clamp01(s.strokeOpacity)}`);
    return [
      '- point:',
      '    symbols:',
      ...mark,
      `    size: ${size}`,
      `    rotation: ${rotation}`,
    ].join('\n');
  }

  private lineSymbolizer(s: SymbolSpecDto): string {
    const lines = ['- line:'];
    lines.push(`    stroke-color: ${this.quote(s.strokeColor ?? '#333333')}`);
    lines.push(`    stroke-width: ${s.strokeWidth ?? 1}`);
    if (s.strokeOpacity != null)
      lines.push(`    stroke-opacity: ${this.clamp01(s.strokeOpacity)}`);
    if (s.strokeDash?.length)
      lines.push(`    stroke-dasharray: ${this.quote(s.strokeDash.join(' '))}`);
    if (s.strokeCap) lines.push(`    stroke-linecap: ${s.strokeCap}`);
    if (s.strokeJoin) lines.push(`    stroke-linejoin: ${s.strokeJoin}`);
    return lines.join('\n');
  }

  private polygonSymbolizer(s: SymbolSpecDto): string {
    const lines = ['- polygon:'];
    lines.push(`    fill-color: ${this.quote(s.fillColor ?? '#888888')}`);
    if (s.fillOpacity != null)
      lines.push(`    fill-opacity: ${this.clamp01(s.fillOpacity)}`);
    if (s.strokeColor)
      lines.push(`    stroke-color: ${this.quote(s.strokeColor)}`);
    if (s.strokeWidth != null) lines.push(`    stroke-width: ${s.strokeWidth}`);
    if (s.strokeOpacity != null)
      lines.push(`    stroke-opacity: ${this.clamp01(s.strokeOpacity)}`);
    if (s.strokeDash?.length)
      lines.push(`    stroke-dasharray: ${this.quote(s.strokeDash.join(' '))}`);
    return lines.join('\n');
  }

  private textSymbolizer(l: LabelSpecDto): string {
    const lines = [
      '- text:',
      `    label: \${${this.q(l.field)}}`,
      `    fill-color: ${this.quote(l.color)}`,
      `    font-family: ${this.quote(l.font)}`,
      `    font-size: ${l.size}`,
    ];
    if (l.haloWidth > 0) {
      lines.push('    halo:');
      lines.push(`      fill-color: ${this.quote(l.haloColor)}`);
      lines.push(`      radius: ${l.haloWidth}`);
    }
    lines.push('    placement:');
    lines.push(`      type: ${l.placement}`);
    if (l.placement === 'point') {
      lines.push('      anchor: [0.5, 0.5]');
      lines.push(`      displacement: [${l.offsetX}, ${l.offsetY}]`);
      lines.push(`      rotation: ${l.rotation}`);
    } else {
      lines.push(`      offset: ${l.offsetY}`);
    }
    return lines.join('\n');
  }

  // ---- helpers ---------------------------------------------------

  private scaleFragment(
    spec: LayerStyleSpecDto,
  ): [number | null, number | null] | null {
    const min = spec.scale?.minDenominator;
    const max = spec.scale?.maxDenominator;
    if (min == null && max == null) return null;
    return [min ?? null, max ?? null];
  }

  /** ECQL literal for a categorize value — number as-is, string quoted
   *  with `'` doubled. */
  private ecqlLiteral(value: string | number): string {
    if (typeof value === 'number') return String(value);
    return `'${String(value).replace(/'/g, "''")}'`;
  }

  /** Quote an attribute name in an expression (double-quote, escape `"`). */
  private q(field: string): string {
    return `"${field.replace(/"/g, '')}"`;
  }

  /** YAML single-quoted scalar. */
  private quote(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
  }

  private clamp01(n: number): number {
    return Math.max(0, Math.min(1, n));
  }

  private num(n: number): string {
    return Number.isInteger(n) ? String(n) : n.toFixed(2);
  }

  private indent(block: string, spaces: number): string {
    const pad = ' '.repeat(spaces);
    return block
      .split('\n')
      .map((line) => (line.length ? pad + line : line))
      .join('\n');
  }
}

/**
 * Equal-interval class boundaries (`classCount + 1` values) between `min`
 * and `max`. Quantile breaks come straight from PostGIS `percentile_cont`
 * (see FieldStatsService) — this is only the arithmetic split.
 */
export function equalIntervalBreaks(
  min: number,
  max: number,
  classCount: number,
): number[] {
  if (!(max > min) || classCount < 1) return [min, max];
  const step = (max - min) / classCount;
  const breaks: number[] = [];
  for (let i = 0; i <= classCount; i++) {
    breaks.push(round(min + step * i));
  }
  breaks[breaks.length - 1] = max;
  return breaks;
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** A qualitative colour ramp, sampled to `n` entries by even spacing. */
export function sampleRamp(ramp: string[], n: number): string[] {
  if (n <= 0) return [];
  if (ramp.length === 0) return Array.from({ length: n }, () => '#888888');
  if (n === 1) return [ramp[Math.floor(ramp.length / 2)]];
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.round((i / (n - 1)) * (ramp.length - 1));
    out.push(ramp[idx]);
  }
  return out;
}
