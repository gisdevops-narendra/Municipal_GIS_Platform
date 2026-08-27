import {
  convertArea,
  convertLength,
  formatArea,
  formatLength,
  tooltipLabel
} from './measure-units';

describe('measure-units', () => {
  describe('convertLength', () => {
    it('converts metres to the requested unit', () => {
      expect(convertLength(1000, 'm')).toBe(1000);
      expect(convertLength(1000, 'km')).toBe(1);
      expect(convertLength(1609.344, 'mi')).toBeCloseTo(1, 6);
      expect(convertLength(0.3048, 'ft')).toBeCloseTo(1, 6);
    });
  });

  describe('convertArea', () => {
    it('converts square metres to the requested unit', () => {
      expect(convertArea(10_000, 'ha')).toBe(1);
      expect(convertArea(1_000_000, 'km2')).toBe(1);
      expect(convertArea(4046.8564224, 'ac')).toBeCloseTo(1, 6);
      expect(convertArea(0.09290304, 'ft2')).toBeCloseTo(1, 6);
    });
  });

  describe('formatLength', () => {
    it('picks a sensible precision and appends the suffix', () => {
      expect(formatLength(1234.56, 'm')).toBe('1,235 m');
      expect(formatLength(1234.56, 'km')).toBe('1.23 km');
      expect(formatLength(0.5, 'm')).toBe('0.5 m');
    });
  });

  describe('formatArea', () => {
    it('formats with the unit symbol', () => {
      expect(formatArea(25_000, 'ha')).toBe('2.5 ha');
      expect(formatArea(2_500_000, 'km2')).toBe('2.5 km²');
    });
  });

  describe('tooltipLabel', () => {
    it('shows area for an area measurement', () => {
      expect(tooltipLabel('area', { areaM2: 20_000 }, 'm', 'ha')).toBe('2 ha');
    });

    it('shows radius for a circle', () => {
      expect(tooltipLabel('radius', { radiusM: 500, lengthM: 3141 }, 'm', 'm2')).toBe('r 500 m');
    });

    it('shows total length for a distance measurement', () => {
      expect(tooltipLabel('distance', { lengthM: 2500 }, 'km', 'm2')).toBe('2.5 km');
    });
  });
});
