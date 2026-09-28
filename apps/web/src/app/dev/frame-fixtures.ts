import { FRAME_TYPES, RARITY_KEYS, type FrameType, type RarityKey } from '@pokedex/shared';
import type { CardFrameCard } from '../cards/CardFrame';
// Real card art, dev-only: Vite resolves these to build-time URLs and (per its default
// asset handling) only emits the files a route actually imports, so none of this ships
// in the production bundle — the /_frames route itself is already excluded by
// router.tsx's import.meta.env.DEV guard, and these assets ride along with it.
import bulbasaurArt from './fixtures/bulbasaur-001.webp';
import charmeleonArt from './fixtures/charmeleon-008.webp';
import gengarArt from './fixtures/gengar-094.webp';
import snorlaxArt from './fixtures/snorlax-143.webp';
// A genuinely square source photo — not a synthetic image — so the gallery can show
// object-fit: contain letterboxing a wrong-ratio printing instead of cropping or
// stretching it, which a same-ratio fixture could never prove either way.
import eeveeWrongRatioArt from './fixtures/eevee-133-wrong-ratio.png';

// Static, no-API fixtures for the /_frames dev gallery — one representative card per
// FrameType (from the CardFrames canvas board's own SAMPLE data where it named one),
// so the gallery never depends on the worker being up or a session existing.
const SAMPLE_BY_FRAME_TYPE: Record<FrameType, { name: string; pokedexNumber: number | null }> = {
  grass: { name: 'Bulbasaur', pokedexNumber: 1 },
  fire: { name: 'Charmeleon', pokedexNumber: 5 },
  water: { name: 'Squirtle', pokedexNumber: 7 },
  lightning: { name: 'Pikachu', pokedexNumber: 25 },
  psychic: { name: 'Gengar', pokedexNumber: 94 },
  fighting: { name: 'Machamp', pokedexNumber: 68 },
  darkness: { name: 'Umbreon', pokedexNumber: 197 },
  metal: { name: 'Steelix', pokedexNumber: 208 },
  dragon: { name: 'Dragonite', pokedexNumber: 149 },
  fairy: { name: 'Sylveon', pokedexNumber: 700 },
  colorless: { name: 'Pidgeotto', pokedexNumber: 17 },
  trainer: { name: 'Professor’s Research', pokedexNumber: null },
  energy: { name: 'Grass Energy', pokedexNumber: null },
  'special-energy': { name: 'Twin Energy', pokedexNumber: null },
};

function cardFor(frameType: FrameType, overrides: Partial<CardFrameCard> = {}): CardFrameCard {
  const sample = SAMPLE_BY_FRAME_TYPE[frameType];
  return {
    id: `${frameType}-fixture`,
    name: sample.name,
    frameType,
    setCode: 'MEW',
    number: '001',
    rarityKey: 'C',
    pokedexNumber: sample.pokedexNumber,
    imageUrl: null,
    ...overrides,
  };
}

export const FRAME_TYPE_FIXTURES: Array<{ frameType: FrameType; card: CardFrameCard }> =
  FRAME_TYPES.map((frameType) => ({ frameType, card: cardFor(frameType) }));

export const RARITY_FIXTURES: Array<{ rarityKey: RarityKey; card: CardFrameCard }> =
  RARITY_KEYS.map((rarityKey, index) => ({
    rarityKey,
    card: cardFor('water', {
      id: `rarity-${rarityKey}`,
      rarityKey,
      number: String(index + 1).padStart(3, '0'),
    }),
  }));

export const ANY_FIXTURE = cardFor('fire', { id: 'any-fixture', name: 'Charizard' });

export const RAW_ART_FIXTURE = cardFor('grass', {
  id: 'raw-fixture',
  imageUrl: bulbasaurArt,
});

// Real, correctly-proportioned (245:337) art per frame type, to prove the art box
// never crops or stretches an ordinary printing.
export const REAL_ART_FIXTURES: Array<{ label: string; card: CardFrameCard }> = [
  {
    label: 'grass · real art',
    card: cardFor('grass', { id: 'real-grass', imageUrl: bulbasaurArt }),
  },
  { label: 'fire · real art', card: cardFor('fire', { id: 'real-fire', imageUrl: charmeleonArt }) },
  {
    label: 'psychic · real art',
    card: cardFor('psychic', { id: 'real-psychic', imageUrl: gengarArt }),
  },
  {
    label: 'colorless · real art',
    card: cardFor('colorless', {
      id: 'real-colorless',
      name: 'Snorlax',
      pokedexNumber: 143,
      imageUrl: snorlaxArt,
    }),
  },
];

// eevee-133-wrong-ratio.png is a real photo forced to a 320x320 square — proof that
// object-fit: contain letterboxes an odd-ratio source instead of cropping or
// stretching it into the card's 245:337 box.
export const WRONG_RATIO_FIXTURE: CardFrameCard = cardFor('colorless', {
  id: 'wrong-ratio',
  name: 'Eevee',
  pokedexNumber: 133,
  imageUrl: eeveeWrongRatioArt,
});

export const LIGHTNING_FIXTURE = cardFor('lightning', { id: 'lightning-fixture' });

export const LONG_NAME_MISSING_ART_FIXTURE = cardFor('psychic', {
  id: 'long-name-fixture',
  name: 'Alakazam ex Special Illustration Rare Full Art Alternate',
  setCode: 'SVI',
  number: '198',
  rarityKey: 'SIR',
});
