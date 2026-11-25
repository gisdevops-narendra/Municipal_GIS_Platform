import { SWITCHABLE_TOOLS, expandSwitchedOff } from './module-catalog';

describe('module catalog', () => {
  const allIds = SWITCHABLE_TOOLS.flatMap((t) => [t.id, ...(t.children ?? []).map((c) => c.id)]);

  it('has unique tool and feature ids', () => {
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it('uses m:<number> ids for features only', () => {
    for (const t of SWITCHABLE_TOOLS) {
      expect(t.id.startsWith('m:')).toBe(false);
      for (const c of t.children ?? []) expect(c.id).toMatch(/^m:\d+$/);
    }
  });

  it('switching a tool off also switches its features off', () => {
    const raster = SWITCHABLE_TOOLS.find((t) => t.id === 'raster')!;
    const out = expandSwitchedOff(['raster']);
    expect(out).toContain('raster');
    for (const c of raster.children!) expect(out).toContain(c.id);
  });

  it('leaves single features and plain tools as they are', () => {
    expect(expandSwitchedOff(['m:922', 'weather']).sort()).toEqual(['m:922', 'weather']);
    expect(expandSwitchedOff([])).toEqual([]);
  });
});
