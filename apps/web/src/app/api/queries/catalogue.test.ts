import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { catalogueSearch } from '../../routes/search-params';
import { catalogueWireParams, collectAllMatchingCards } from './catalogue';

describe('catalogueWireParams', () => {
  it('sends type/rarity/set as repeated params, and region/language/dex as single values', () => {
    const filters = catalogueSearch.parse({
      type: ['fire', 'water'],
      rarity: ['C', 'HV'],
      set: ['MEW', 'BS'],
      region: 'Kanto',
      language: 'ja',
      dex: '6',
    });
    const params = catalogueWireParams(filters);
    expect(params.getAll('type')).toEqual(['fire', 'water']);
    expect(params.getAll('rarity')).toEqual(['C', 'HV']);
    expect(params.getAll('set')).toEqual(['MEW', 'BS']);
    expect(params.get('region')).toBe('Kanto');
    expect(params.get('language')).toBe('ja');
    expect(params.get('pokedexNumber')).toBe('6');
  });

  it('omits owned unless the filter is owned or missing', () => {
    expect(catalogueWireParams(catalogueSearch.parse({})).has('owned')).toBe(false);
    expect(catalogueWireParams(catalogueSearch.parse({ owned: 'owned' })).get('owned')).toBe(
      'true',
    );
    expect(catalogueWireParams(catalogueSearch.parse({ owned: 'missing' })).get('owned')).toBe(
      'false',
    );
  });

  it('maps sort:"release-date" to the server\'s sort=release, and leaves other sorts unset', () => {
    expect(catalogueWireParams(catalogueSearch.parse({ sort: 'release-date' })).get('sort')).toBe(
      'release',
    );
    expect(catalogueWireParams(catalogueSearch.parse({ sort: 'relevance' })).has('sort')).toBe(
      false,
    );
  });
});

const CARD = (id: string) => ({
  id,
  name: `Card ${id}`,
  language: 'en',
  category: 'pokemon',
  setId: 'MEW',
  setName: '151',
  number: id,
  imageLowUrl: null,
  imageHighUrl: null,
  collection: null,
  price: {
    amountAud: null,
    nativeAmount: null,
    nativeCurrency: null,
    source: null,
    sourceCapturedAt: null,
    fxDate: null,
  },
});

describe('collectAllMatchingCards', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  it('walks every cursor page and returns every card in order', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(
        json({ ok: true, total: 3, cards: [CARD('1'), CARD('2')], cursor: 'next' }),
      )
      .mockResolvedValueOnce(json({ ok: true, total: 3, cards: [CARD('3')], cursor: null }));

    const result = await collectAllMatchingCards(
      catalogueSearch.parse({}),
      'displayed',
      new AbortController().signal,
    );
    expect(result.map((card) => card.id)).toEqual(['1', '2', '3']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws instead of returning a partial list when the total exceeds the 2,000-card cap', async () => {
    vi.mocked(fetch).mockResolvedValue(json({ ok: true, total: 2001, cards: [], cursor: null }));
    await expect(
      collectAllMatchingCards(catalogueSearch.parse({}), 'displayed', new AbortController().signal),
    ).rejects.toThrow(/2,000/);
  });

  it('throws when the total changes mid-walk instead of silently truncating', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(json({ ok: true, total: 3, cards: [CARD('1')], cursor: 'next' }))
      .mockResolvedValueOnce(json({ ok: true, total: 4, cards: [CARD('2')], cursor: null }));
    await expect(
      collectAllMatchingCards(catalogueSearch.parse({}), 'displayed', new AbortController().signal),
    ).rejects.toThrow(/changed while copying/);
  });
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
