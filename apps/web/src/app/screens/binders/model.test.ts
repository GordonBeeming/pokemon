import { describe, expect, it } from 'vitest';
import type { BinderPageView } from '../../api/queries/binders';
import {
  capacityDescription,
  changedPockets,
  parseSlotId,
  pocketState,
  pocketTitle,
  slotIdOf,
  trackGeometry,
} from './model';

describe('slot ids', () => {
  it('round-trips the worker slotId shape, page ids containing colons included', () => {
    expect(parseSlotId(slotIdOf('page_abc', 2, 3))).toEqual({
      pageId: 'page_abc',
      row: 2,
      column: 3,
    });
    expect(parseSlotId('weird:page:1:0')).toEqual({ pageId: 'weird:page', row: 1, column: 0 });
  });

  it('drops nonsense instead of throwing', () => {
    expect(parseSlotId('nonsense')).toBeNull();
    expect(parseSlotId('page:x:1')).toBeNull();
    expect(parseSlotId(undefined)).toBeNull();
  });
});

describe('capacityDescription', () => {
  it('describes full and partial final pages', () => {
    expect(capacityDescription(18, 9)).toBe('18 pockets in this binder across 2 page faces.');
    expect(capacityDescription(20, 9)).toBe(
      '20 pockets in this binder across 3 page faces. The final page has 2 pockets.',
    );
    expect(capacityDescription(0, 9)).toBe('Enter at least 1 pocket.');
    expect(capacityDescription(1.5, 9)).toBe('Enter a whole number of pockets.');
  });
});

describe('pocket labels', () => {
  const base = { pageId: 'p', row: 0, column: 0, cardId: null, label: null, assignedCardId: null };
  it('names an any-printing target by number and species', () => {
    const slot = { ...base, entryKind: 'pokemon' as const, pokemonNumber: 25 };
    expect(pocketTitle(slot, new Map())).toBe('#0025 Pikachu');
    expect(pocketState(slot)).toBe('target');
  });
  it('treats a placed copy as placed whatever the target', () => {
    expect(
      pocketState({ ...base, entryKind: 'pokemon', pokemonNumber: 1, assignedCardId: 'c' }),
    ).toBe('placed');
  });
  it('labels reserved and empty sleeves in words', () => {
    expect(pocketTitle({ ...base, entryKind: 'reserved', label: 'Promos' }, new Map())).toBe(
      'Reserved: Promos',
    );
    expect(pocketTitle({ ...base, entryKind: 'empty' }, new Map())).toBe('Empty pocket');
  });
});

describe('changedPockets', () => {
  const page = (kinds: Array<'empty' | 'pokemon'>): BinderPageView => ({
    id: 'p',
    position: 0,
    slots: kinds.map((entryKind, index) => ({
      pageId: 'p',
      row: 0,
      column: index,
      cardId: null,
      entryKind,
      pokemonNumber: entryKind === 'pokemon' ? index + 1 : null,
    })),
  });
  it('lists exactly the pockets that differ', () => {
    expect(changedPockets(page(['pokemon', 'empty']), page(['pokemon', 'pokemon']))).toEqual([
      { row: 0, column: 1 },
    ]);
    expect(changedPockets(page(['empty']), page(['empty']))).toEqual([]);
  });
});

describe('trackGeometry', () => {
  it('fits the page and its peek columns inside the available width', () => {
    for (const width of [390, 1100, 1600])
      for (const peek of [0, 1, 2] as const) {
        const geometry = trackGeometry(width, 4, peek);
        expect(geometry.viewportWidth).toBeLessThanOrEqual(width);
        expect(geometry.pocketWidth).toBeGreaterThanOrEqual(40);
      }
  });
});
