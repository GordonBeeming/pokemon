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
 * "Team Rocket's Mewtwo ex". Two kinds of card name no owner but are collected the same
 * way, each as its own group: the "Dark" Pokémon of the Team Rocket era ("Dark
 * Charizard"), and Mega Evolutions, printed "Mega Charizard X ex" now and "M Gardevoir
 * EX" in the XY era. Null for every other card.
 */
export function trainerOf(cardName: string): TrainerGroup | null {
  const name = cardName.trim();
  if (/^Dark\s+\p{L}/u.test(name)) return { key: 'dark', name: 'Dark' };
  // "M " then a capital: "Mr. Mime" and "Mime Jr." have no space after the M.
  if (/^(?:Mega|M)\s+\p{Lu}/u.test(name)) return { key: 'mega', name: 'Mega' };
  const owner = /^(.+?)['’]s\s+\S/u.exec(name)?.[1]?.trim();
  if (!owner || !/\p{L}/u.test(owner)) return null;
  const key = keyOf(owner);
  const canonical = SAME_TRAINER[key];
  return canonical ? { key: keyOf(canonical), name: canonical } : { key, name: owner };
}
