import { describe, expect, it } from 'vitest';
import { catalogueSetIds, catalogueSetDetail } from './catalogue-source';

describe('set-scoped full catalogue discovery', () => {
  it('discovers a new physical set while excluding Pocket, including Pocket promos', () => {
    expect(
      catalogueSetIds([
        { id: 'me06' },
        { id: 'base1' },
        { id: 'A1' },
        { id: 'B2a' },
        { id: 'P-A', logo: 'https://assets.tcgdex.net/en/tcgp/P-A/logo' },
      ]),
    ).toEqual(['base1', 'me06']);
  });
  it('keeps secret and letter-numbered cards and their set metadata', () => {
    expect(
      catalogueSetDetail(
        {
          id: 'me06',
          releaseDate: '2026-11-06',
          abbreviation: { official: 'DLR' },
          cards: [{ id: 'me06-104' }, { id: 'me06-106' }, { id: 'me06-B' }],
        },
        'me06',
      ),
    ).toEqual({
      id: 'me06',
      releaseDate: '2026-11-06',
      abbreviation: 'DLR',
      cardIds: ['me06-104', 'me06-106', 'me06-B'],
    });
  });
  it('does not silently turn a missing or malformed set response into a full import', () => {
    expect(() => catalogueSetDetail({ id: 'me06' }, 'me06')).toThrow();
    expect(() => catalogueSetDetail({ id: 'base1', cards: [{ id: 'base1-1' }] }, 'me06')).toThrow(
      'identity',
    );
    expect(() => catalogueSetDetail({ id: 'me06', cards: [{ id: 'base1-1' }] }, 'me06')).toThrow(
      'identity',
    );
    expect(() => catalogueSetIds([])).toThrow();
  });
});
