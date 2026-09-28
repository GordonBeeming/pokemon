import { describe, expect, it } from 'vitest';
import {
  binderSearch,
  catalogueSearch,
  pokedexSearch,
  settingsSearch,
  setsSearch,
} from './search-params';

describe('catalogueSearch', () => {
  it('round-trips its defaults through parse -> serialize -> parse', () => {
    const initial = catalogueSearch.parse({});
    expect(catalogueSearch.parse(catalogueSearch.serialize(initial))).toEqual(initial);
  });

  it('round-trips a fully populated search', () => {
    const initial = catalogueSearch.parse({
      q: 'pikachu',
      type: ['lightning', 'colorless'],
      region: 'Kanto',
      rarity: ['C', 'HV'],
      set: ['MEW'],
      language: 'ja',
      owned: 'owned',
      sort: 'release-date',
      page: '3',
      card: 'abc123',
      dex: '25',
    });
    expect(initial).toEqual({
      q: 'pikachu',
      type: ['lightning', 'colorless'],
      region: 'Kanto',
      rarity: ['C', 'HV'],
      set: ['MEW'],
      language: 'ja',
      owned: 'owned',
      sort: 'release-date',
      page: 3,
      card: 'abc123',
      dex: 25,
    });
    expect(catalogueSearch.parse(catalogueSearch.serialize(initial))).toEqual(initial);
  });

  it('round-trips a species-context search (dex only, no other filters)', () => {
    const initial = catalogueSearch.parse({ dex: '150' });
    expect(catalogueSearch.parse(catalogueSearch.serialize(initial))).toEqual(initial);
    expect(initial.dex).toBe(150);
  });

  it('clamps dex to the National Pokédex range, dropping an out-of-range value', () => {
    expect(catalogueSearch.parse({ dex: '0' }).dex).toBeUndefined();
    expect(catalogueSearch.parse({ dex: '1026' }).dex).toBeUndefined();
  });

  it('accepts array-shaped list params as well as comma-joined strings', () => {
    expect(catalogueSearch.parse({ type: ['fire', 'water'] }).type).toEqual(['fire', 'water']);
    expect(catalogueSearch.parse({ type: 'fire,water' }).type).toEqual(['fire', 'water']);
  });

  it('drops unknown and invalid values instead of throwing', () => {
    expect(() =>
      catalogueSearch.parse({ page: 'not-a-number', owned: 'bogus', extra: 'ignored' }),
    ).not.toThrow();
    const result = catalogueSearch.parse({
      page: 'not-a-number',
      owned: 'bogus',
      extra: 'ignored',
    });
    expect(result.page).toBe(1);
    expect(result.owned).toBe('all');
  });
});

describe('pokedexSearch', () => {
  it('round-trips', () => {
    const initial = pokedexSearch.parse({
      q: 'pika',
      region: 'Johto',
      filter: 'owned',
      page: '2',
      dex: '25',
    });
    expect(pokedexSearch.parse(pokedexSearch.serialize(initial))).toEqual(initial);
  });

  it('clamps dex to the National Pokédex range', () => {
    expect(pokedexSearch.parse({ dex: '0' }).dex).toBeUndefined();
    expect(pokedexSearch.parse({ dex: '1026' }).dex).toBeUndefined();
    expect(pokedexSearch.parse({ dex: '1025' }).dex).toBe(1025);
  });
});

describe('setsSearch', () => {
  it('round-trips', () => {
    const initial = setsSearch.parse({ set: 'MEW' });
    expect(setsSearch.parse(setsSearch.serialize(initial))).toEqual(initial);
  });

  it('defaults to no selected set', () => {
    expect(setsSearch.parse({})).toEqual({});
  });
});

describe('binderSearch', () => {
  it('round-trips', () => {
    const initial = binderSearch.parse({ page: '1', sel: '0-2-3', mode: 'move', q: 'char' });
    expect(binderSearch.parse(binderSearch.serialize(initial))).toEqual(initial);
  });

  it('drops an invalid mode rather than throwing', () => {
    expect(binderSearch.parse({ mode: 'nonsense' }).mode).toBeUndefined();
  });

  it('treats page as 1-based and drops page 0 back to the first page', () => {
    expect(binderSearch.parse({}).page).toBe(1);
    expect(binderSearch.parse({ page: '0' }).page).toBe(1);
    expect(binderSearch.parse({ page: '7', v: 'binder_version_x' })).toMatchObject({
      page: 7,
      v: 'binder_version_x',
    });
  });
});

describe('settingsSearch', () => {
  it('round-trips every tab', () => {
    for (const tab of [
      'passkeys',
      'frame-colours',
      'api-tokens',
      'catalogue-sync',
      'people',
    ] as const) {
      const initial = settingsSearch.parse({ tab });
      expect(settingsSearch.parse(settingsSearch.serialize(initial))).toEqual(initial);
    }
  });

  it('defaults to the passkeys tab', () => {
    expect(settingsSearch.parse({}).tab).toBe('passkeys');
  });
});
