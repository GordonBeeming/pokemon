import {
  NATIONAL_POKEDEX,
  type CardCategory,
  type PokemonDiscoveryCategory,
} from '@pokedex/shared';

const regions = new Map(NATIONAL_POKEDEX.map((entry) => [entry.number, entry.discoveryCategory]));

export function cardRegion(card: {
  category: CardCategory;
  pokedexNumber?: number | null;
}): PokemonDiscoveryCategory | null {
  if (card.category !== 'pokemon' || card.pokedexNumber == null) return null;
  return regions.get(card.pokedexNumber) ?? null;
}
