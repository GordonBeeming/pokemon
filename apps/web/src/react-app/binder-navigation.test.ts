import { describe, it, expect } from 'vitest';
import { binderHash, parseBinderHash } from './binder-navigation';
describe('binder URLs', () => {
  it('round-trips page 45 and a selected pocket using readable one-based coordinates', () => {
    const hash = binderHash('version-1', 44, { page: 44, row: 1, column: 3 });
    expect(hash).toBe('#binders?version=version-1&page=45&row=2&column=4');
    expect(parseBinderHash(hash)).toEqual({
      versionId: 'version-1',
      page: 44,
      pocket: { page: 44, row: 1, column: 3 },
    });
  });
  it('defaults direct binder links to the first page and ignores invalid pocket coordinates', () => {
    expect(parseBinderHash('#binders?version=v')).toEqual({
      versionId: 'v',
      page: 0,
      pocket: null,
    });
    expect(parseBinderHash('#binders?version=v&page=2&row=0&column=2')).toEqual({
      versionId: 'v',
      page: 1,
      pocket: null,
    });
  });
  it.each([
    '#binders',
    '#catalogue?version=v',
    '#binders?page=45',
    '#binders?version=v&page=0',
    '#binders?version=v&page=1.5',
    '#binders?version=v&page=Infinity',
  ])('rejects invalid links %s', (hash) => expect(parseBinderHash(hash)).toBeNull());
});
