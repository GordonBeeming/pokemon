import { describe, expect, it } from 'vitest';
import { pokedexNumberFromCardName } from './national-pokedex';

describe('pokedexNumberFromCardName', () => {
  it.each([
    ['Pikachu', 25],
    ['Pikachu ex', 25],
    ['Mew ex', 151],
    ['Mewtwo ex', 150],
    ['Dark Tyranitar', 248],
    ["Erika's Jigglypuff", 39],
    ['M Gardevoir EX', 282],
    ['Alolan Exeggutor', 103],
    ['Hisuian Zoroark', 571],
    ['Zacian V', 888],
    ['Arceus VSTAR', 493],
    ['Greninja BREAK', 658],
    ['Shining Celebi', 251],
    ['Ho-Oh', 250],
    ['Jangmo-o', 782],
    ['Nidoran♀', 29],
    ['Porygon-Z', 474],
    ['Porygon2', 233],
    ['Porygon', 137],
    ['Mr. Mime', 122],
    ['Mime Jr.', 439],
    ["Farfetch'd", 83],
  ])('reads %s as #%i', (name, number) => {
    expect(pokedexNumberFromCardName(name)).toBe(number);
  });

  it('gives a card naming several Pokémon the lowest number', () => {
    expect(pokedexNumberFromCardName('Darkrai & Cresselia LEGEND')).toBe(488);
    expect(pokedexNumberFromCardName('Pikachu & Zekrom GX')).toBe(25);
  });

  it('finds nothing in a name with no Pokémon', () => {
    expect(pokedexNumberFromCardName('Misty')).toBeNull();
    expect(pokedexNumberFromCardName('Professor Oak')).toBeNull();
  });
});
