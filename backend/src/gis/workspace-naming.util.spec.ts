import {
  deriveWorkspaceCode,
  slugifyWorkspaceName,
} from './workspace-naming.util';

describe('slugifyWorkspaceName', () => {
  it('lowercases and replaces spaces with underscores', () => {
    expect(slugifyWorkspaceName('Somnath Municipality')).toBe(
      'somnath_municipality',
    );
  });

  it('strips unsafe/punctuation characters', () => {
    expect(
      slugifyWorkspaceName('Somnath Municipal Corporation (Gujarat)!'),
    ).toBe('somnath_municipal_corporation_gujarat');
  });

  it('collapses repeated separators and trims leading/trailing underscores', () => {
    expect(slugifyWorkspaceName('  Somnath   -- Municipality  ')).toBe(
      'somnath_municipality',
    );
  });

  it('is deterministic for the same input', () => {
    const a = slugifyWorkspaceName('Rajkot Municipal Corporation');
    const b = slugifyWorkspaceName('Rajkot Municipal Corporation');
    expect(a).toBe(b);
  });

  it('strips diacritics', () => {
    expect(slugifyWorkspaceName('Municipalité Française')).toBe(
      'municipalite_francaise',
    );
  });

  it('falls back to a safe default for input with no safe characters', () => {
    expect(slugifyWorkspaceName('!!!')).toBe('municipality');
  });

  it('prefixes with ws_ when the slug would otherwise start with a digit', () => {
    expect(slugifyWorkspaceName('123 Municipality')).toBe(
      'ws_123_municipality',
    );
  });

  it('truncates very long names to a bounded length', () => {
    const longName = 'A'.repeat(200) + ' Municipal Corporation of Somewhere';
    expect(slugifyWorkspaceName(longName).length).toBeLessThanOrEqual(40);
  });

  it('never produces a leading or trailing underscore even after truncation', () => {
    const longName = 'A'.repeat(39) + '_' + 'B'.repeat(20);
    const slug = slugifyWorkspaceName(longName);
    expect(slug.startsWith('_')).toBe(false);
    expect(slug.endsWith('_')).toBe(false);
  });
});

describe('deriveWorkspaceCode', () => {
  it('uppercases the slug and appends _GIS', () => {
    expect(deriveWorkspaceCode('Somnath Municipality')).toBe(
      'SOMNATH_MUNICIPALITY_GIS',
    );
  });

  it('is deterministic for the same input', () => {
    expect(deriveWorkspaceCode('Veraval Municipality')).toBe(
      deriveWorkspaceCode('Veraval Municipality'),
    );
  });
});
