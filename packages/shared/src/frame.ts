import type { CardCategory } from './index';

export const FRAME_TYPES = [
  'grass',
  'fire',
  'water',
  'lightning',
  'psychic',
  'fighting',
  'darkness',
  'metal',
  'dragon',
  'fairy',
  'colorless',
  'trainer',
  'energy',
  'special-energy',
] as const;
export type FrameType = (typeof FRAME_TYPES)[number];

export const DEFAULT_FRAME_PALETTE: Record<FrameType, string> = {
  grass: '#3f6212',
  fire: '#9a3412',
  water: '#1e40af',
  lightning: '#a16207',
  psychic: '#6b21a8',
  fighting: '#7c3f1d',
  darkness: '#134e4a',
  metal: '#475569',
  dragon: '#3730a3',
  fairy: '#9d174d',
  colorless: '#57534e',
  trainer: '#334155',
  energy: '#0e7490',
  'special-energy': '#cbd5e1',
};

// TCGdex reports elemental types with the Pokemon TCG's own capitalisation
// ("Grass", "Lightning"); some sources use "Electric"/"Dark" synonyms, so
// both spellings are accepted here rather than trusting a single vocabulary.
const TYPE_NAME_TO_FRAME: Record<string, FrameType> = {
  grass: 'grass',
  fire: 'fire',
  water: 'water',
  lightning: 'lightning',
  electric: 'lightning',
  psychic: 'psychic',
  fighting: 'fighting',
  darkness: 'darkness',
  dark: 'darkness',
  metal: 'metal',
  steel: 'metal',
  dragon: 'dragon',
  fairy: 'fairy',
  colorless: 'colorless',
  normal: 'colorless',
};

function typeNameToFrame(value: string | null | undefined): FrameType | null {
  if (!value) return null;
  return TYPE_NAME_TO_FRAME[value.trim().toLowerCase()] ?? null;
}

// Basic energy cards don't always carry a `types` entry from TCGdex, so the
// card name ("Grass Energy") is the fallback source of truth for its type.
const BASIC_ENERGY_NAME_PATTERN = /^([A-Za-z]+)\s+Energy$/u;

export interface FrameTypeInput {
  category: CardCategory;
  types?: readonly string[] | null;
  subtype?: string | null;
  name: string;
}

export function frameTypeFor(input: FrameTypeInput): FrameType | null {
  if (input.category === 'trainer') return 'trainer';
  if (input.category === 'pokemon') return typeNameToFrame(input.types?.[0]);
  if (input.category === 'energy') {
    if (input.subtype?.trim().toLowerCase() === 'special') return 'special-energy';
    const fromTypes = typeNameToFrame(input.types?.[0]);
    if (fromTypes) return fromTypes;
    const parsedName = input.name.match(BASIC_ENERGY_NAME_PATTERN)?.[1];
    return typeNameToFrame(parsedName) ?? 'energy';
  }
  // 'special' is the manual/custom-card category; there is no reliable typing to infer.
  return null;
}

// Reverse of TYPE_NAME_TO_FRAME, grouped by frame — lets a SQL search filter
// match the raw TCGdex type strings for a requested elemental frame type
// without duplicating the mapping logic in SQL.
export const ELEMENTAL_FRAME_TYPES = FRAME_TYPES.filter(
  (type): type is Exclude<FrameType, 'trainer' | 'energy' | 'special-energy'> =>
    type !== 'trainer' && type !== 'energy' && type !== 'special-energy',
);
export const FRAME_TYPE_RAW_NAMES: Record<
  Exclude<FrameType, 'trainer' | 'energy' | 'special-energy'>,
  readonly string[]
> = {
  grass: ['grass'],
  fire: ['fire'],
  water: ['water'],
  lightning: ['lightning', 'electric'],
  psychic: ['psychic'],
  fighting: ['fighting'],
  darkness: ['darkness', 'dark'],
  metal: ['metal', 'steel'],
  dragon: ['dragon'],
  fairy: ['fairy'],
  colorless: ['colorless', 'normal'],
};

export const RARITY_KEYS = [
  'C',
  'U',
  'R',
  'HV',
  'RR',
  'UR',
  'IR',
  'SIR',
  'HR',
  'SR',
  'S',
  'ACE',
  'PR',
] as const;
export type RarityKey = (typeof RARITY_KEYS)[number];

export const RARITY_LABELS: Record<RarityKey, string> = {
  C: 'Common',
  U: 'Uncommon',
  R: 'Rare',
  HV: 'Holo Rare',
  RR: 'Double Rare',
  UR: 'Ultra Rare',
  IR: 'Illustration Rare',
  SIR: 'Special Illustration Rare',
  HR: 'Hyper Rare',
  SR: 'Secret Rare',
  S: 'Shiny Rare',
  ACE: 'ACE SPEC Rare',
  PR: 'Promo',
};

// Keyed by the lower-cased raw `catalogue_cards.rarity` text. TCG Pocket's own
// rarity vocabulary (diamonds/stars/shiny counts, "Crown") intentionally has
// no entry here: those cards go inactive in migration 021 and rarityKeyFor
// returning null for them is correct, not a gap.
const RARITY_ALIASES: Record<string, RarityKey> = {
  common: 'C',
  uncommon: 'U',
  rare: 'R',
  'rare holo': 'HV',
  'holo rare': 'HV',
  'holo rare v': 'HV',
  'holo rare vmax': 'HV',
  'holo rare vstar': 'HV',
  'rare holo lv.x': 'HV',
  'rare prime': 'HV',
  'pikachu rare': 'HV',
  legend: 'HV',
  'classic collection': 'HV',
  'radiant rare': 'HV',
  'amazing rare': 'HV',
  'full art trainer': 'HV',
  'black white rare': 'HV',
  'futuristic rare': 'HV',
  'double rare': 'RR',
  'ultra rare': 'UR',
  'illustration rare': 'IR',
  'special illustration rare': 'SIR',
  'hyper rare': 'HR',
  'mega hyper rare': 'HR',
  'secret rare': 'SR',
  'shiny rare': 'S',
  'shiny rare v': 'S',
  'shiny rare vmax': 'S',
  'shiny ultra rare': 'S',
  'ace spec rare': 'ACE',
  promo: 'PR',
};

export function rarityKeyFor(raw: string | null | undefined): RarityKey | null {
  if (!raw) return null;
  const normalised = raw.trim().toLowerCase();
  if (!normalised || normalised === 'none') return null;
  return RARITY_ALIASES[normalised] ?? null;
}

// Reverse of RARITY_ALIASES, grouped by key — lets a SQL search filter match
// every raw rarity string for a requested key without re-deriving the table.
export const RARITY_KEY_RAW_VALUES: Record<RarityKey, readonly string[]> = RARITY_KEYS.reduce(
  (acc, key) => {
    acc[key] = Object.entries(RARITY_ALIASES)
      .filter(([, value]) => value === key)
      .map(([raw]) => raw);
    return acc;
  },
  {} as Record<RarityKey, string[]>,
);
