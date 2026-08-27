import {
  deriveLayerCode,
  generateLayerTableName,
  isSafeGeneratedTableName,
} from './layer-naming.util';

describe('deriveLayerCode', () => {
  it('slugifies to an uppercase, underscore-joined code', () => {
    expect(deriveLayerCode('Road Network')).toBe('ROAD_NETWORK');
  });

  it('strips punctuation and collapses repeated separators', () => {
    expect(deriveLayerCode('Water, Pipeline!!  (2024)')).toBe(
      'WATER_PIPELINE_2024',
    );
  });

  it('is deterministic for the same input', () => {
    expect(deriveLayerCode('Streetlights')).toBe(
      deriveLayerCode('Streetlights'),
    );
  });

  it('never begins with a digit or underscore', () => {
    expect(deriveLayerCode('123 Zone')).toMatch(/^[A-Z]/);
  });

  it('falls back to a safe default for input with no safe characters', () => {
    expect(deriveLayerCode('!!!')).toBe('LAYER');
  });
});

describe('generateLayerTableName / isSafeGeneratedTableName', () => {
  it('never derives the table name from user input', () => {
    const table = generateLayerTableName();
    expect(table).toMatch(/^layer_[a-f0-9]{32}$/);
  });

  it('generates a different name on every call', () => {
    expect(generateLayerTableName()).not.toBe(generateLayerTableName());
  });

  it('accepts only the exact generated shape', () => {
    expect(isSafeGeneratedTableName(generateLayerTableName())).toBe(true);
    expect(isSafeGeneratedTableName('layer_DROP_TABLE_users')).toBe(false);
    expect(isSafeGeneratedTableName('users; DROP TABLE users;--')).toBe(false);
    expect(isSafeGeneratedTableName('layer_abc')).toBe(false);
  });
});
