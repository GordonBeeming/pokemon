export interface TrainerGroup {
  /** Letters and digits only, lower case: what pockets and filters match on. */
  key: string;
  /** How the trainer reads on a card ("Team Rocket", "Lt. Surge"). */
  name: string;
}

function keyOf(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

// Older printings say "Rocket's Zapdos" for the same team.
const SAME_TRAINER: Readonly<Record<string, string>> = { rocket: 'Team Rocket' };

/**
 * The trainer whose Pokémon a card is: the owner before "'s" in "Lillie's Comfey" or
 * "Team Rocket's Mewtwo ex". The "Dark" Pokémon of the Team Rocket era ("Dark Charizard")
 * name no owner and are kept as their own group. Null for every other card.
 */
export function trainerOf(cardName: string): TrainerGroup | null {
  const name = cardName.trim();
  if (/^Dark\s+\p{L}/u.test(name)) return { key: 'dark', name: 'Dark' };
  const owner = /^(.+?)['’]s\s+\S/u.exec(name)?.[1]?.trim();
  if (!owner || !/\p{L}/u.test(owner)) return null;
  const key = keyOf(owner);
  const canonical = SAME_TRAINER[key];
  return canonical ? { key: keyOf(canonical), name: canonical } : { key, name: owner };
}
