import { describe, expect, it } from 'vitest';
import {
  imageUrl,
  matchCsvProduct,
  matchingCsvGroups,
  matchProviderCard,
  normalizedNumber,
  productImageCandidates,
} from './backfill-art.mjs';
const card = {
  source_id: 'mfb-25',
  set_id: 'mfb',
  set_name: 'My First Battle',
  name: 'Squirtle',
  number: '25',
};
describe('artwork fallback identity', () => {
  it('maps dated McDonalds promotions and kit members without crossing years or decks', () => {
    const groups = [
      { name: "McDonald's Promos 2014", groupId: 1 },
      { name: "McDonald's Promos 2015", groupId: 2 },
      { name: 'XY Trainer Kit: Latias & Latios', groupId: 3 },
    ];
    expect(
      matchingCsvGroups(groups, { set_name: "McDonald's Collection 2014", set_id: '2014xy' }).map(
        (x) => x.groupId,
      ),
    ).toEqual([1]);
    const target = {
      ...card,
      set_name: 'XY trainer Kit (Latias)',
      set_id: 'tk-xy-latia',
      name: 'Psychic Energy',
      number: '8',
    };
    expect(matchingCsvGroups(groups, target).map((x) => x.groupId)).toEqual([3]);
    const product = {
      productId: 1,
      name: 'Psychic Energy (#8 - Latias)',
      imageUrl: 'https://tcgplayer-cdn.tcgplayer.com/product/1_200w.jpg',
      extendedData: [{ name: 'Number', value: '008/030' }],
    };
    expect(matchCsvProduct([product], target)?.sourceId).toBe('1');
    expect(
      matchCsvProduct([{ ...product, name: 'Psychic Energy (#8 - Latios)' }], target),
    ).toBeNull();
    expect(matchCsvProduct([{ ...product, name: 'Psychic Energy - 8/30' }], target)?.sourceId).toBe(
      '1',
    );
  });
  it('uses verified product IDs and excludes alternate border variants', () => {
    const candidates = productImageCandidates(
      {
        id: 'mfb-25',
        name: 'Squirtle',
        localId: '25',
        set: { id: 'mfb', name: 'My First Battle' },
        variants_detailed: [
          { type: 'normal', thirdParty: { tcgplayer: 524047 } },
          { type: 'normal', subtype: 'blue-border', thirdParty: { tcgplayer: 524046 } },
        ],
      },
      card,
    );
    expect(candidates).toEqual([
      {
        provider: 'tcgplayer',
        sourceId: '524047',
        url: 'https://tcgplayer-cdn.tcgplayer.com/product/524047_in_1000x1000.jpg',
      },
    ]);
    expect(() =>
      productImageCandidates(
        {
          id: 'mfb-26',
          name: 'Wartortle',
          localId: '26',
          set: { id: 'mfb', name: 'My First Battle' },
        },
        card,
      ),
    ).toThrow('identity');
  });
  it('matches exact sets, names and numbers, and refuses ambiguous matches', () => {
    const item = {
      id: 'mcd21-17',
      name: 'Squirtle',
      number: '17',
      set: { id: 'mcd21', name: "McDonald's Collection 2021" },
      images: { large: 'https://images.pokemontcg.io/mcd21/17_hires.png' },
    };
    const target = { ...card, number: '017' };
    expect(matchProviderCard([item], target, 'mcd21')?.sourceId).toBe('mcd21-17');
    expect(matchProviderCard([item, item], target, 'mcd21')).toBeNull();
    expect(matchProviderCard([item], { ...target, name: 'Wartortle' }, 'mcd21')).toBeNull();
    expect(normalizedNumber('TG001/030')).toBe('TG1');
  });
  it('handles explicitly unnumbered My First Battle without picking a blue-border or sealed product', () => {
    const regular = {
      productId: 524047,
      name: 'Squirtle',
      imageUrl: 'https://tcgplayer-cdn.tcgplayer.com/product/524047_200w.jpg',
      extendedData: [{ name: 'Rarity', value: 'Unconfirmed' }],
    };
    const blue = { ...regular, productId: 524046, name: 'Squirtle (Blue Border)' };
    expect(matchCsvProduct([regular, blue], card)?.sourceId).toBe('524047');
    expect(matchCsvProduct([{ ...regular, extendedData: [] }], card)).toBeNull();
    expect(matchCsvProduct([regular], { ...card, set_id: 'base1' })).toBeNull();
    expect(matchCsvProduct([regular, regular], card)).toBeNull();
  });
  it('rejects untrusted hosts, credentials, ports and redirects encoded as URLs', () => {
    for (const url of [
      'https://evil.example/card.png',
      'http://images.pokemontcg.io/a.png',
      'https://u:p@images.pokemontcg.io/a.png',
      'https://images.pokemontcg.io:444/a.png',
      'https://images.pokemontcg.io/a.png?next=http://evil.example',
    ])
      expect(() => imageUrl(url)).toThrow();
  });
});
