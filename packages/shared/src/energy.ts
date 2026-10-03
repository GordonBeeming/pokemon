/** The basic energy types, in the order the game lists them. */
export const BASIC_ENERGY_TYPES = [
  'grass',
  'fire',
  'water',
  'lightning',
  'psychic',
  'fighting',
  'darkness',
  'metal',
  'fairy',
  'colorless',
] as const;
export type BasicEnergyType = (typeof BASIC_ENERGY_TYPES)[number];

/** What an energy pocket can ask for: any energy, any special energy, or one type. */
export type EnergyGroup = 'all' | 'special' | BasicEnergyType;
export const ENERGY_GROUPS: readonly EnergyGroup[] = ['all', ...BASIC_ENERGY_TYPES, 'special'];

const BASIC = new RegExp(`^(?:Basic\\s+)?(${BASIC_ENERGY_TYPES.join('|')})\\s+Energy$`, 'iu');

/**
 * The energy group a card belongs to: its type for a basic energy ("Fire Energy",
 * "Basic Fire Energy"), "special" for every other energy card ("Double Colorless
 * Energy"), and null for anything that isn't an energy card.
 */
export function energyOf(name: string, category: string): BasicEnergyType | 'special' | null {
  if (category !== 'energy') return null;
  const type = BASIC.exec(name.trim())?.[1]?.toLowerCase();
  return (BASIC_ENERGY_TYPES as readonly string[]).includes(type ?? '')
    ? (type as BasicEnergyType)
    : 'special';
}

/** How an energy group reads: "Any energy", "Fire Energy", "Special energy". */
export function energyGroupName(group: EnergyGroup): string {
  if (group === 'all') return 'Any energy';
  if (group === 'special') return 'Special energy';
  return `${group.charAt(0).toUpperCase()}${group.slice(1)} Energy`;
}
