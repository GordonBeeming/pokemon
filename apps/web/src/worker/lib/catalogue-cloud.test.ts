import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { artObjectKey, isWebp } from './art';
import { escapedFtsQuery } from './db';
import { extractTcgdexPrices, selectConservativePrice } from './pricing';
import {
  beginStagedCatalogueRun,
  catalogueSyncLanguage,
  resolveStagedCardId,
  stageCatalogueCards,
  transformTcgdexCard,
} from './catalogue';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('catalogue cloud invariants', () => {
  it('defaults scheduled catalogue refreshes to the English collection', () => {
    expect(catalogueSyncLanguage(undefined)).toBe('en');
    expect(catalogueSyncLanguage('ja')).toBe('ja');
  });

  it('reuses a physical printing identity staged by an earlier workflow chunk', async () => {
    const database = new DatabaseSync(':memory:');
    databases.push(database);
    database.exec('PRAGMA foreign_keys = ON');
    applyAllMigrations(database);
    const db = sqliteD1(database);
    await beginStagedCatalogueRun(db, 'en', { runId: 'run-1', complete: true });
    const printing = {
      checksum: 'a'.repeat(64),
      sourceUpdatedAt: 1,
      name: 'Squirtle',
      language: 'en' as const,
      category: 'pokemon' as const,
      setId: 'set-1',
      setName: 'Set One',
      number: '7',
      numberSort: 7,
      supertype: 'Pokémon',
      subtype: 'Basic',
      species: 'Squirtle',
      rarity: 'Common',
      artist: 'Artist',
      releaseDate: '2026-01-01',
      pokedexNumber: 7,
    };
    await stageCatalogueCards(db, 'run-1', [{ ...printing, sourceId: 'source-a' }]);
    await stageCatalogueCards(db, 'run-1', [{ ...printing, sourceId: 'source-b' }]);

    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS sources, COUNT(DISTINCT card_id) AS cards FROM catalogue_stage_cards WHERE run_id = 'run-1'",
        )
        .get(),
    ).toEqual({ sources: 2, cards: 1 });
  });

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
    const valid = new Uint8Array(20);
    valid.set(new TextEncoder().encode('RIFF'), 0);
    new DataView(valid.buffer).setUint32(4, 12, true);
    valid.set(new TextEncoder().encode('WEBPVP8 '), 8);
    expect(isWebp(valid)).toBe(true);
    const truncated = valid.slice();
    new DataView(truncated.buffer).setUint32(16, 8, true);
    expect(isWebp(truncated)).toBe(false);
    const wrongRiffLength = valid.slice();
    new DataView(wrongRiffLength.buffer).setUint32(4, 99, true);
    expect(isWebp(wrongRiffLength)).toBe(false);
    valid.set(new TextEncoder().encode('PNG '), 8);
    expect(isWebp(valid)).toBe(false);
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

  it('extracts ordinary TCGdex market prices with provider timestamps', () => {
    expect(
      extractTcgdexPrices({
        id: 'base1-4',
        pricing: {
          cardmarket: {
            updated: '2026-08-24T15:18:56.128Z',
            unit: 'EUR',
            trend: 632.84,
          },
          tcgplayer: {
            updated: '2026-08-24T15:18:54.574Z',
            unit: 'USD',
            holofoil: { marketPrice: 855.52 },
            reverseHolofoil: { marketPrice: 900 },
          },
        },
      }),
    ).toEqual({
      sourceId: 'base1-4',
      candidates: [
        {
          source: 'cardmarket',
          nativeAmount: 632.84,
          nativeCurrency: 'EUR',
          sourceCapturedAt: 1787584736,
        },
        {
          source: 'tcgplayer',
          nativeAmount: 855.52,
          nativeCurrency: 'USD',
          sourceCapturedAt: 1787584734,
        },
      ],
    });
  });

  it('reuses the stable internal card id when staging the same source twice', async () => {
    const existing = new Map<string, string>();
    const first = await resolveStagedCardId(existing, 'sv1-001', 'en');
    existing.set('en\u0000sv1-001', first);
    const second = await resolveStagedCardId(existing, 'sv1-001', 'en');
    expect(second).toBe(first);
  });

  it('derives the same new card id in independent sync runs', async () => {
    const first = await resolveStagedCardId(new Map(), 'base1-4', 'en');
    const second = await resolveStagedCardId(new Map(), 'base1-4', 'en');
    expect(first).toBe(second);
    expect(first).toMatch(/^card_[a-f0-9]{64}$/u);
  });

  it('maps TCGdex Pokedex metadata without treating the number as a species name', async () => {
    const transformed = await transformTcgdexCard(
      {
        id: 'base1-4',
        localId: '4',
        name: 'Charizard',
        category: 'Pokemon',
        dexId: [6],
        types: ['Fire'],
        rarity: 'Rare Holo',
        illustrator: 'Mitsuhiro Arita',
        updated: '2026-08-24T00:00:00.000Z',
        set: { id: 'base1', name: 'Base Set' },
      },
      'en',
      '1999-01-09',
    );
    expect(transformed).toMatchObject({
      species: 'Charizard',
      pokedexNumber: 6,
      numberSort: 4,
      releaseDate: '1999-01-09',
    });
  });

  it('excludes TCG Pocket cards from the physical catalogue', async () => {
    await expect(
      transformTcgdexCard(
        {
          id: 'A1-001',
          localId: '001',
          name: 'Bulbasaur',
          category: 'Pokemon',
          updated: '2026-08-24T00:00:00.000Z',
          set: {
            id: 'A1',
            name: 'Genetic Apex',
            logo: 'https://assets.tcgdex.net/en/tcgp/A1/logo',
          },
        },
        'en',
      ),
    ).resolves.toBeNull();
  });
});
