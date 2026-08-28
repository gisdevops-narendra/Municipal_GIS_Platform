import {
  YsldGenerator,
  equalIntervalBreaks,
  sampleRamp,
} from './ysld-generator';
import type { LayerStyleSpecDto } from './dto/layer-style.dto';

const g = new YsldGenerator();

function spec(over: Partial<LayerStyleSpecDto> = {}): LayerStyleSpecDto {
  return {
    version: 1,
    geometry: 'polygon',
    mode: 'single',
    symbol: {
      fillColor: '#3366cc',
      fillOpacity: 0.6,
      strokeColor: '#12263a',
      strokeWidth: 1,
    },
    ...over,
  };
}

describe('YsldGenerator', () => {
  it('emits a named feature-styles document with one rule for single mode', () => {
    const ysld = g.generate(spec(), 'roads_style');
    expect(ysld).toContain("name: 'roads_style'");
    expect(ysld).toContain('feature-styles:');
    expect(ysld).toContain('- polygon:');
    expect(ysld).toContain("fill-color: '#3366cc'");
    expect(ysld).toContain('fill-opacity: 0.6');
    expect(ysld).toContain("stroke-color: '#12263a'");
  });

  it('point mode → a mark symbolizer with shape / size / rotation', () => {
    const ysld = g.generate(
      spec({
        geometry: 'point',
        symbol: {
          markShape: 'triangle',
          markSize: 10,
          markRotation: 45,
          fillColor: '#ff0000',
        },
      }),
      's',
    );
    expect(ysld).toContain('- point:');
    expect(ysld).toContain('shape: triangle');
    expect(ysld).toContain('size: 10');
    expect(ysld).toContain('rotation: 45');
  });

  it('point mode with an icon → an external graphic symbolizer', () => {
    const ysld = g.generate(
      spec({
        geometry: 'point',
        symbol: {
          icon: {
            source: 'custom',
            name: 'mgp_icon_abc.svg',
            mime: 'image/svg+xml',
          },
          markSize: 24,
          markRotation: 30,
          iconOpacity: 0.8,
          iconAnchorX: 0.5,
          iconAnchorY: 1,
        },
      }),
      's',
    );
    expect(ysld).toContain('- external:');
    expect(ysld).toContain("url: 'mgp_icon_abc.svg'");
    expect(ysld).toContain("format: 'image/svg+xml'");
    expect(ysld).toContain('size: 24');
    expect(ysld).toContain('rotation: 30');
    expect(ysld).toContain('opacity: 0.8');
    expect(ysld).toContain('anchor: [0.5, 1]');
    expect(ysld).not.toContain('mark:');
  });

  it('line mode → stroke width, dash array and cap/join', () => {
    const ysld = g.generate(
      spec({
        geometry: 'line',
        symbol: {
          strokeColor: '#0e6660',
          strokeWidth: 3,
          strokeDash: [6, 4],
          strokeCap: 'round',
          strokeJoin: 'bevel',
        },
      }),
      's',
    );
    expect(ysld).toContain("stroke-dasharray: '6 4'");
    expect(ysld).toContain('stroke-linecap: round');
    expect(ysld).toContain('stroke-linejoin: bevel');
  });

  it('categorized mode → one rule per category (ECQL literal escaped) + an else rule', () => {
    const ysld = g.generate(
      spec({
        mode: 'categorized',
        categorize: {
          field: 'zone',
          includeOther: true,
          categories: [
            { value: "O'Hara", symbol: { fillColor: '#1b9e77' } },
            { value: 2, symbol: { fillColor: '#d95f02' } },
          ],
        },
      }),
      's',
    );
    expect(ysld).toContain(`filter: \${"zone" = 'O''Hara'}`);
    expect(ysld).toContain(`filter: \${"zone" = 2}`);
    expect(ysld).toContain('else: true');
    expect((ysld.match(/- polygon:/g) ?? []).length).toBe(3); // 2 categories + other
  });

  it('graduated mode → range filters from breaks, last class inclusive, ramp colour per class', () => {
    const ysld = g.generate(
      spec({
        mode: 'graduated',
        graduate: {
          field: 'pop',
          method: 'quantile',
          classCount: 3,
          breaks: [0, 10, 20, 30],
          ramp: ['#eeeeee', '#999999', '#333333'],
        },
      }),
      's',
    );
    expect(ysld).toContain(`filter: \${"pop" >= 0 AND "pop" < 10}`);
    expect(ysld).toContain(`filter: \${"pop" >= 20 AND "pop" <= 30}`); // last: <=
    expect(ysld).toContain("fill-color: '#eeeeee'");
    expect(ysld).toContain("fill-color: '#333333'");
  });

  it('labels → a text symbolizer with halo, font and placement', () => {
    const ysld = g.generate(
      spec({
        labels: {
          enabled: true,
          field: 'name',
          font: 'Serif',
          size: 14,
          color: '#000000',
          haloColor: '#ffffff',
          haloWidth: 2,
          rotation: 15,
          offsetX: 1,
          offsetY: -2,
          placement: 'point',
        },
      }),
      's',
    );
    expect(ysld).toContain('- text:');
    expect(ysld).toContain(`label: \${"name"}`);
    expect(ysld).toContain("font-family: 'Serif'");
    expect(ysld).toContain('halo:');
    expect(ysld).toContain('radius: 2');
    expect(ysld).toContain('displacement: [1, -2]');
  });

  it('scale → a scale range on the rule', () => {
    const ysld = g.generate(
      spec({ scale: { minDenominator: 0, maxDenominator: 50000 } }),
      's',
    );
    expect(ysld).toContain('scale: [0, 50000]');
  });

  it('raster → a raster symbolizer with opacity and a colour-map', () => {
    const ysld = g.generate(
      {
        version: 1,
        geometry: 'raster',
        mode: 'single',
        symbol: {},
        raster: {
          opacity: 0.7,
          colorMap: [
            { quantity: 100, color: '#ffffff' },
            { quantity: 0, color: '#000000' },
          ],
        },
      },
      's',
    );
    expect(ysld).toContain('- raster:');
    expect(ysld).toContain('opacity: 0.7');
    expect(ysld).toContain('color-map:');
    // entries sorted ascending by quantity
    expect(ysld.indexOf("'#000000'")).toBeLessThan(ysld.indexOf("'#ffffff'"));
  });

  it('clamps opacity into [0,1]', () => {
    const ysld = g.generate(
      spec({ symbol: { fillColor: '#fff', fillOpacity: 5 } }),
      's',
    );
    expect(ysld).toContain('fill-opacity: 1');
  });
});

describe('equalIntervalBreaks', () => {
  it('splits [0, 100] into 4 even classes', () => {
    expect(equalIntervalBreaks(0, 100, 4)).toEqual([0, 25, 50, 75, 100]);
  });
  it('degenerate range → [min, max]', () => {
    expect(equalIntervalBreaks(5, 5, 4)).toEqual([5, 5]);
  });
});

describe('sampleRamp', () => {
  it('samples endpoints for n >= 2', () => {
    expect(sampleRamp(['#a', '#b', '#c', '#d', '#e'], 3)).toEqual([
      '#a',
      '#c',
      '#e',
    ]);
  });
});
