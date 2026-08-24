import { describe, expect, it } from 'vitest';
import { artObjectKey, isWebp } from './art';
import { escapedFtsQuery } from './db';
import { selectConservativePrice } from './pricing';
import { resolveStagedCardId } from './catalogue';

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

  it('uses the cheapest positive converted market value across providers', () => {
    expect(
      selectConservativePrice([
        {
          source: 'cardmarket',
          nativeAmount: 1,
          nativeCurrency: 'EUR',
          sourceCapturedAt: 1,
          amountAud: 1.6,
        },
        {
          source: 'tcgplayer',
          nativeAmount: 3,
          nativeCurrency: 'USD',
          sourceCapturedAt: 1,
          amountAud: 4.5,
        },
        {
          source: 'tcgplayer',
          nativeAmount: 2,
          nativeCurrency: 'USD',
          sourceCapturedAt: 1,
          amountAud: 3,
        },
      ]),
    ).toMatchObject({ source: 'cardmarket', nativeAmount: 1, amountAud: 1.6 });
    expect(
      selectConservativePrice([
        {
          source: 'tcgplayer',
          nativeAmount: 0,
          nativeCurrency: 'USD',
          sourceCapturedAt: 1,
          amountAud: 0,
        },
        {
          source: 'cardmarket',
          nativeAmount: 1,
          nativeCurrency: 'EUR',
          sourceCapturedAt: 1,
          amountAud: 1.6,
        },
      ]),
    ).toMatchObject({ source: 'cardmarket', nativeAmount: 1 });
    expect(
      selectConservativePrice([
        {
          source: 'tcgplayer',
          nativeAmount: 1,
          nativeCurrency: 'USD',
          sourceCapturedAt: 1,
          amountAud: 1.7,
        },
        {
          source: 'cardmarket',
          nativeAmount: 1.2,
          nativeCurrency: 'EUR',
          sourceCapturedAt: 1,
          amountAud: 1.6,
        },
      ]),
    ).toMatchObject({ source: 'cardmarket', amountAud: 1.6 });
  });

  it('reuses the stable internal card id when staging the same source twice', () => {
    const existing = new Map<string, string>();
    const first = resolveStagedCardId(existing, 'sv1-001', 'en');
    existing.set('en\u0000sv1-001', first);
    const second = resolveStagedCardId(existing, 'sv1-001', 'en');
    expect(second).toBe(first);
  });
});
