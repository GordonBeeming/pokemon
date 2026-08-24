import { describe, expect, it } from 'vitest';
import { artObjectKey, isWebp } from './art';
import { escapedFtsQuery } from './db';
import { selectConservativePrice } from './pricing';

describe('catalogue cloud invariants', () => {
  it('builds bounded FTS prefixes without exposing FTS operators', () => {
    expect(escapedFtsQuery('Pikachu V')).toBe('"Pikachu"* AND "V"*');
    expect(escapedFtsQuery('   ')).toBeNull();
    expect(escapedFtsQuery('" OR NEAR')).toBe('"OR"* AND "NEAR"*');
  });

  it('uses a content-addressed private R2 key for each art variant', () => {
    const checksum = 'a'.repeat(64);
    expect(artObjectKey('manual/card 1', 'low', checksum)).toBe(
      `cards/manual%2Fcard%201/low/${checksum}.webp`,
    );
    expect(() => artObjectKey('card', 'high', 'not-a-hash')).toThrow('invalid_art_checksum');
  });

  it('accepts only a WebP RIFF signature before R2 upload', () => {
    expect(isWebp(new TextEncoder().encode('RIFF0000WEBPVP8 '))).toBe(true);
    expect(isWebp(new TextEncoder().encode('RIFF0000PNG VP8 '))).toBe(false);
  });

  it('prefers the cheapest positive TCGplayer market value before Cardmarket', () => {
    expect(
      selectConservativePrice([
        { source: 'cardmarket', nativeAmount: 1, nativeCurrency: 'EUR', sourceCapturedAt: 1 },
        { source: 'tcgplayer', nativeAmount: 3, nativeCurrency: 'USD', sourceCapturedAt: 1 },
        { source: 'tcgplayer', nativeAmount: 2, nativeCurrency: 'USD', sourceCapturedAt: 1 },
      ]),
    ).toMatchObject({ source: 'tcgplayer', nativeAmount: 2 });
    expect(
      selectConservativePrice([
        { source: 'tcgplayer', nativeAmount: 0, nativeCurrency: 'USD', sourceCapturedAt: 1 },
        { source: 'cardmarket', nativeAmount: 1, nativeCurrency: 'EUR', sourceCapturedAt: 1 },
      ]),
    ).toMatchObject({ source: 'cardmarket', nativeAmount: 1 });
  });
});
