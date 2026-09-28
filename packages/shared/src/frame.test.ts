import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FRAME_PALETTE,
  FRAME_TYPES,
  RARITY_KEYS,
  RARITY_LABELS,
  frameTypeFor,
  rarityKeyFor,
} from './frame';
import { regionForDex } from './national-pokedex';

describe('frameTypeFor', () => {
  it('maps a pokemon card to its first type', () => {
    expect(
      frameTypeFor({ category: 'pokemon', types: ['Grass', 'Poison'], name: 'Bulbasaur' }),
    ).toBe('grass');
    expect(frameTypeFor({ category: 'pokemon', types: ['Water'], name: 'Squirtle' })).toBe('water');
  });

  it('returns null for a pokemon card with no known type', () => {
    expect(frameTypeFor({ category: 'pokemon', types: null, name: 'Mystery Mon' })).toBeNull();
    expect(
      frameTypeFor({ category: 'pokemon', types: ['Nonsense'], name: 'Mystery Mon' }),
    ).toBeNull();
    expect(frameTypeFor({ category: 'pokemon', name: 'Mystery Mon' })).toBeNull();
  });

  it('always frames a trainer card as trainer', () => {
    expect(frameTypeFor({ category: 'trainer', name: 'Professor’s Research' })).toBe('trainer');
  });

  it('frames a basic energy card by its type, from types first', () => {
    expect(
      frameTypeFor({ category: 'energy', subtype: 'Normal', types: ['Fire'], name: 'Fire Energy' }),
    ).toBe('fire');
  });

  it('falls back to parsing "X Energy" names when types are missing', () => {
    expect(frameTypeFor({ category: 'energy', subtype: 'Normal', name: 'Grass Energy' })).toBe(
      'grass',
    );
    expect(frameTypeFor({ category: 'energy', subtype: '', name: 'Lightning Energy' })).toBe(
      'lightning',
    );
  });

  it('falls back to the neutral energy frame when nothing resolves', () => {
    expect(
      frameTypeFor({ category: 'energy', subtype: 'Normal', name: 'Mystery Energy Card' }),
    ).toBe('energy');
  });

  it('frames a special energy card as special-energy regardless of type', () => {
    expect(
      frameTypeFor({
        category: 'energy',
        subtype: 'Special',
        types: ['Water'],
        name: 'Multi Energy',
      }),
    ).toBe('special-energy');
  });

  it('returns null for the manual "special" custom-card category', () => {
    expect(frameTypeFor({ category: 'special', name: 'My Custom Card' })).toBeNull();
  });

  it('exposes a default palette entry for every frame type', () => {
    for (const type of FRAME_TYPES) {
      expect(DEFAULT_FRAME_PALETTE[type]).toMatch(/^#[0-9a-f]{6}$/u);
    }
  });
});

describe('rarityKeyFor', () => {
  const table: Array<[string, string | null]> = [
    ['Common', 'C'],
    ['UNCOMMON', 'U'],
    ['Rare', 'R'],
    ['Rare Holo', 'HV'],
    ['Holo Rare', 'HV'],
    ['Holo Rare V', 'HV'],
    ['Holo Rare VMAX', 'HV'],
    ['Holo Rare VSTAR', 'HV'],
    ['Rare Holo LV.X', 'HV'],
    ['Rare PRIME', 'HV'],
    ['Pikachu Rare', 'HV'],
    ['LEGEND', 'HV'],
    ['Classic Collection', 'HV'],
    ['Radiant Rare', 'HV'],
    ['Amazing Rare', 'HV'],
    ['Full Art Trainer', 'HV'],
    ['Black White Rare', 'HV'],
    ['Futuristic Rare', 'HV'],
    ['Double Rare', 'RR'],
    ['Ultra Rare', 'UR'],
    ['Illustration Rare', 'IR'],
    ['Illustration rare', 'IR'],
    ['Special Illustration Rare', 'SIR'],
    ['Special illustration rare', 'SIR'],
    ['Hyper Rare', 'HR'],
    ['Hyper rare', 'HR'],
    ['Mega Hyper Rare', 'HR'],
    ['Secret Rare', 'SR'],
    ['Shiny Rare', 'S'],
    ['Shiny rare', 'S'],
    ['Shiny rare V', 'S'],
    ['Shiny rare VMAX', 'S'],
    ['Shiny Ultra Rare', 'S'],
    ['ACE SPEC Rare', 'ACE'],
    ['Promo', 'PR'],
    ['None', null],
    ['', null],
    // TCG Pocket's own rarity vocabulary never maps: those sets go inactive.
    ['One Diamond', null],
    ['Two Diamond', null],
    ['Three Diamond', null],
    ['Four Diamond', null],
    ['One Star', null],
    ['Two Star', null],
    ['Three Star', null],
    ['One Shiny', null],
    ['Two Shiny', null],
    ['Crown', null],
  ];

  it.each(table)('maps %s to %s', (raw, expected) => {
    expect(rarityKeyFor(raw)).toBe(expected);
  });

  it('returns null for null and undefined input', () => {
    expect(rarityKeyFor(null)).toBeNull();
    expect(rarityKeyFor(undefined)).toBeNull();
  });

  it('has a label for every rarity key', () => {
    for (const key of RARITY_KEYS) {
      expect(RARITY_LABELS[key]).toBeTruthy();
    }
  });
});

describe('regionForDex', () => {
  it('resolves a known dex number to its discovery region', () => {
    expect(regionForDex(1)).toBe('Kanto');
    expect(regionForDex(1025)).toBe('Paldea');
  });

  it('returns null outside the national dex range', () => {
    expect(regionForDex(0)).toBeNull();
    expect(regionForDex(1026)).toBeNull();
  });
});
