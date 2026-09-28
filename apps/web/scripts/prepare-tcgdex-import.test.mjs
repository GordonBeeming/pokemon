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

  it('filters a Pocket record whose set id matches even without a resolving logo', () => {
    const prepared = prepareImport(
      [
        {
          id: 'A3a-001',
          name: 'Squirtle',
          localId: '001',
          category: 'Pokemon',
          set: { id: 'A3a', name: 'Extradimensional Crisis' },
        },
      ],
      'en',
    );
    expect(prepared.cards).toEqual([]);
  });

  it('filters a Pocket record identified only by its serie id', () => {
    const prepared = prepareImport(
      [
        {
          id: 'weird-001',
          name: 'Squirtle',
          localId: '001',
          category: 'Pokemon',
          set: { id: 'weird', name: 'Odd Set', serie: { id: 'tcgp' } },
        },
      ],
      'en',
    );
    expect(prepared.cards).toEqual([]);
  });

  it('carries the types array through for frame colouring', () => {
    const prepared = prepareImport(
      [
        {
          id: 'base1-4',
          name: 'Charizard',
          localId: '4',
          category: 'Pokemon',
          types: ['Fire'],
          set: { id: 'base1', name: 'Base Set' },
        },
      ],
      'en',
    );
    expect(prepared.cards[0]).toMatchObject({ types: ['Fire'] });
  });

  it("takes a special energy card's subtype from energyType, not types", () => {
    const prepared = prepareImport(
      [
        {
          id: 'swsh4-238',
          name: 'Twin Energy',
          localId: '238',
          category: 'Energy',
          energyType: 'Special',
          set: { id: 'swsh4', name: 'Vivid Voltage' },
        },
      ],
      'en',
    );
    // matches lib/catalogue.ts's frameTypeFor special-energy detection, which
    // reads subtype (never 'types') to tell a special energy from a basic one.
    expect(prepared.cards[0]).toMatchObject({ subtype: 'Special', types: null });
  });

  it("takes a basic energy card's subtype from energyType", () => {
    const prepared = prepareImport(
      [
        {
          id: 'base1-98',
          name: 'Fire Energy',
          localId: '98',
          category: 'Energy',
          energyType: 'Basic',
          set: { id: 'base1', name: 'Base Set' },
        },
      ],
      'en',
    );
    expect(prepared.cards[0]).toMatchObject({ subtype: 'Basic' });
  });

  it("takes a trainer card's subtype from trainerType, not types", () => {
    const prepared = prepareImport(
      [
        {
          id: 'base1-88',
          name: 'Professor Oak',
          localId: '88',
          category: 'Trainer',
          trainerType: 'Supporter',
          set: { id: 'base1', name: 'Base Set' },
        },
      ],
      'en',
    );
    expect(prepared.cards[0]).toMatchObject({ subtype: 'Supporter' });
  });
});
