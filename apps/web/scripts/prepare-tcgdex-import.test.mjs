import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { prepareImport } from './prepare-tcgdex-import.mjs';

describe('TCGdex import preparation', () => {
  it('keeps species names separate from Pokedex numbers', async () => {
    const fixture = JSON.parse(
      await readFile(new URL('./fixtures/tcgdex-en.fixture.json', import.meta.url), 'utf8'),
    );
    const prepared = prepareImport(fixture, 'en');
    expect(prepared.cards[0]).toMatchObject({
      name: 'Charizard',
      species: 'Charizard',
      pokedexNumber: 6,
      numberSort: 4,
    });
  });

  it('filters TCG Pocket records from physical imports', () => {
    const prepared = prepareImport(
      [
        {
          id: 'A1-001',
          name: 'Bulbasaur',
          localId: '001',
          category: 'Pokemon',
          set: {
            id: 'A1',
            name: 'Genetic Apex',
            logo: 'https://assets.tcgdex.net/en/tcgp/A1/logo',
          },
        },
      ],
      'en',
    );
    expect(prepared.cards).toEqual([]);
  });
});
