import { describe, expect, it } from 'vitest';
import { cardRegion } from './card-region';

describe('card region', () => {
  it('uses the same species regions as the National Pokedex', () => {
    expect(cardRegion({ category: 'pokemon', pokedexNumber: 7 })).toBe('Kanto');
    expect(cardRegion({ category: 'pokemon', pokedexNumber: 878 })).toBe('Galar');
    expect(cardRegion({ category: 'pokemon', pokedexNumber: 899 })).toBe('Hisui');
    expect(cardRegion({ category: 'pokemon', pokedexNumber: 906 })).toBe('Paldea');
  });
  it('does not guess a region for non-Pokemon or unidentified cards', () => {
    expect(cardRegion({ category: 'trainer', pokedexNumber: 7 })).toBeNull();
    expect(cardRegion({ category: 'pokemon' })).toBeNull();
    expect(cardRegion({ category: 'pokemon', pokedexNumber: 99999 })).toBeNull();
  });
});
