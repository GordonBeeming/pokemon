import { describe, expect, it } from 'vitest';
import { tcgdexArtImageBase } from './tcgdex-art-image';

describe('TCGdex artwork identity', () => {
  it.each([
    ['swsh4.5sv', 'SV090', 'swsh4.5'],
    ['swsh12.5gg', 'GG36', 'swsh12.5'],
    ['swsh9tg', 'TG16', 'swsh9'],
    ['swsh9.5tg', 'TG16', 'swsh9'],
    ['swsh10tg', 'TG22', 'swsh10'],
    ['swsh10.5tg', 'TG22', 'swsh10'],
    ['swsh11tg', 'TG16', 'swsh11'],
    ['swsh12tg', 'TG16', 'swsh12'],
  ])('recovers the exact %s %s gallery printing on the same provider', (setId, localId, parent) => {
    const id = `${setId}-${localId}`;
    expect(tcgdexArtImageBase({ id, localId, set: { id: setId } }, id, 'en')).toBe(
      `https://assets.tcgdex.net/en/swsh/${parent}/${localId}`,
    );
  });
  it('prefers an explicit provider image when supplied', () => {
    expect(
      tcgdexArtImageBase({ image: 'https://assets.tcgdex.net/en/me/30th/001/' }, '30th-001', 'en'),
    ).toBe('https://assets.tcgdex.net/en/me/30th/001');
  });
  it('does not substitute another card, ordinary parent-set number, or language', () => {
    expect(
      tcgdexArtImageBase(
        { id: 'swsh10tg-TG22', localId: 'TG22', set: { id: 'swsh10tg' } },
        'swsh11tg-TG22',
        'en',
      ),
    ).toBeNull();
    expect(
      tcgdexArtImageBase(
        { id: 'swsh10tg-022', localId: '022', set: { id: 'swsh10tg' } },
        'swsh10tg-022',
        'en',
      ),
    ).toBeNull();
    expect(
      tcgdexArtImageBase({ id: 'exu-A', localId: 'A', set: { id: 'exu' } }, 'exu-A', 'en'),
    ).toBeNull();
    expect(
      tcgdexArtImageBase({ id: 'B2a-001', localId: '001', set: { id: 'B2a' } }, 'B2a-001', 'en'),
    ).toBeNull();
  });
  it.each([
    'https://example.com/image',
    'http://assets.tcgdex.net/en/base/base1/1',
    'https://assets.tcgdex.net/en/base/base1/1?x=1',
    'not a URL',
  ])('rejects an unsafe or malformed image base %s', (image) => {
    expect(tcgdexArtImageBase({ image }, 'base1-1', 'en')).toBeNull();
  });
});
