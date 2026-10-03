import { describe, expect, it } from 'vitest';
import { trainerOf } from './trainers';

describe('trainerOf', () => {
  it.each([
    ["Lillie's Comfey", 'lillie', 'Lillie'],
    ["Team Rocket's Mewtwo ex", 'teamrocket', 'Team Rocket'],
    ["Rocket's Zapdos", 'teamrocket', 'Team Rocket'],
    ['Dark Charizard', 'dark', 'Dark'],
    ["Lt. Surge's Raichu", 'ltsurge', 'Lt. Surge'],
    ["N's Zekrom", 'n', 'N'],
    ['Erika’s Jigglypuff', 'erika', 'Erika'],
  ])('%s belongs to %s', (card, key, name) => {
    expect(trainerOf(card)).toEqual({ key, name });
  });

  it.each(['Pikachu', 'Darkrai', 'Professor Oak', "_____'s Pikachu", 'Farfetch’d'])(
    '%s has no trainer',
    (card) => {
      expect(trainerOf(card)).toBeNull();
    },
  );
});
