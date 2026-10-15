import { niceMax } from './layer-statistics.component';

describe('niceMax (statistics axis)', () => {
  it('rounds up to a clean 1 / 2 / 5 × 10ⁿ step', () => {
    expect(niceMax(0)).toBe(0);
    expect(niceMax(1)).toBe(1);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(13)).toBe(20);
    expect(niceMax(26)).toBe(50);
    expect(niceMax(50)).toBe(50);
    expect(niceMax(51)).toBe(100);
    expect(niceMax(1234)).toBe(2000);
  });
});

import { isIdLike } from './layer-statistics.component';

describe('isIdLike (statistics default field)', () => {
  it('flags identifier columns', () => {
    for (const name of ['objectid', 'OBJECTID', 'fid', 'valve_id', 'road_gisid', 'id', 'gid', 'object_id']) {
      expect(isIdLike(name)).withContext(name).toBeTrue();
    }
  });

  it('keeps measurement and descriptive fields', () => {
    for (const name of ['valve_dia', 'locality', 'width', 'idle_time', 'status']) {
      expect(isIdLike(name)).withContext(name).toBeFalse();
    }
  });
});
