import { describe, expect, it } from 'vitest';
import { energyGroupName, energyOf } from './energy';

describe('energyOf', () => {
  it.each([
    ['Fire Energy', 'fire'],
    ['Basic Fire Energy', 'fire'],
    ['Darkness Energy', 'darkness'],
    ['Basic Metal Energy', 'metal'],
    ['Double Colorless Energy', 'special'],
    ['Rainbow Energy', 'special'],
    ['Unit Energy GrassFireWater', 'special'],
  ])('%s is %s', (name, group) => {
    expect(energyOf(name, 'energy')).toBe(group);
  });

  it('is null for cards that are not energy', () => {
    expect(energyOf('Fire Energy', 'trainer')).toBeNull();
    expect(energyOf('Charmander', 'pokemon')).toBeNull();
  });

  it('names each group', () => {
    expect(energyGroupName('all')).toBe('Any energy');
    expect(energyGroupName('special')).toBe('Special energy');
    expect(energyGroupName('fire')).toBe('Fire Energy');
  });
});
