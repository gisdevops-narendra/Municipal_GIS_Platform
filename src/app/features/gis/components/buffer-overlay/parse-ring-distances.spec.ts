import { parseRingDistances } from './buffer-overlay.component';

describe('parseRingDistances (MultiBuffer)', () => {
  it('parses comma / space / semicolon separated values, sorted and de-duplicated', () => {
    expect(parseRingDistances('500, 100;250 100')).toEqual([100, 250, 500]);
  });

  it('accepts decimals', () => {
    expect(parseRingDistances('0.5, 1.25')).toEqual([0.5, 1.25]);
  });

  it('rejects non-positive or non-numeric values', () => {
    expect(typeof parseRingDistances('100, -50')).toBe('string');
    expect(typeof parseRingDistances('100, abc')).toBe('string');
    expect(typeof parseRingDistances('0, 100')).toBe('string');
  });

  it('needs at least two distinct distances and at most six', () => {
    expect(typeof parseRingDistances('100')).toBe('string');
    expect(typeof parseRingDistances('100, 100')).toBe('string');
    expect(typeof parseRingDistances('1,2,3,4,5,6,7')).toBe('string');
    expect(parseRingDistances('1,2,3,4,5,6')).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
