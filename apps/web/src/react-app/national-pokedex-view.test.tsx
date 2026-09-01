// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NationalPokedexView } from './national-pokedex-view';
import { NATIONAL_POKEDEX } from '@pokedex/shared';

describe('National Pokédex planning view', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div');
    document.body.replaceChildren(container);
    root = createRoot(container);
  });

  afterEach(() => act(() => root.unmount()));

  it('bundles every National Pokédex species even without catalogue coverage', () => {
    expect(NATIONAL_POKEDEX).toHaveLength(1025);
    expect(NATIONAL_POKEDEX[0]).toMatchObject({
      number: 1,
      name: 'Bulbasaur',
      discoveryCategory: 'Kanto',
    });
    expect(NATIONAL_POKEDEX.at(-1)).toMatchObject({
      number: 1025,
      name: 'Pecharunt',
      discoveryCategory: 'Paldea',
    });

    act(() => {
      root.render(
        <NationalPokedexView
          coverage={[
            {
              number: 7,
              totalCards: 3,
              ownedCards: 1,
              types: ['Water'],
              representative: {
                cardId: 'squirtle-card',
                cardName: 'Squirtle',
                setName: '151',
                number: '007',
                imageLowUrl: '/api/art/squirtle-card/low',
                imageHighUrl: '/api/art/squirtle-card/high',
                explicit: false,
              },
            },
          ]}
          previews={[]}
          query=""
          ownership="all"
          page={0}
          focusNumber={null}
          restoreScrollY={0}
          pendingNumber={null}
          onQueryChange={() => undefined}
          onOwnershipChange={() => undefined}
          onPageChange={() => undefined}
          onChoose={() => undefined}
        />,
      );
    });

    expect(container.textContent).toContain('Bulbasaur');
    expect(container.textContent).toContain('Squirtle');
    expect(
      container.querySelector('[data-pokedex-number="1"] .card-tile-title small')?.textContent,
    ).toBe('#0001 · Kanto');
    expect(container.querySelector('.national-progress')?.getAttribute('aria-label')).toBe(
      '1 of 1025 species owned',
    );
    expect(container.textContent).not.toContain('physical printings indexed');
    expect(container.textContent).not.toContain('variants not loaded yet');
    expect(
      container.querySelector('[data-pokedex-number="1"] .card-art-frame')?.classList,
    ).toContain('card-art-unowned');
    expect(
      container.querySelector('[data-pokedex-number="7"] .card-art-frame')?.classList,
    ).not.toContain('card-art-unowned');
  });

  it('finds and filters species by first-found region', () => {
    const onPageChange = vi.fn();
    act(() => {
      root.render(
        <NationalPokedexView
          coverage={[]}
          previews={[]}
          query="Hisui"
          ownership="all"
          page={3}
          focusNumber={null}
          restoreScrollY={0}
          pendingNumber={null}
          onQueryChange={() => undefined}
          onOwnershipChange={() => undefined}
          onPageChange={onPageChange}
          onChoose={() => undefined}
        />,
      );
    });
    expect(container.textContent).toContain('Wyrdeer');
    expect(container.textContent).not.toContain('Bulbasaur');
    expect(container.textContent).not.toContain('Pecharunt');
    const picker = container.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]');
    if (!picker) throw new Error('Region picker did not render.');
    expect(picker.textContent).toContain('All');
    act(() => picker.click());
    expect(container.querySelector('[role="listbox"]')?.textContent).toContain('Hisui');
    expect(onPageChange).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Wyrdeer');
    expect(container.textContent).not.toContain('Bulbasaur');
  });

  it('finds species by the types on their indexed card variants', () => {
    act(() => {
      root.render(
        <NationalPokedexView
          coverage={[
            {
              number: 1,
              totalCards: 2,
              ownedCards: 0,
              types: ['Grass'],
              representative: {
                cardId: 'bulbasaur-card',
                cardName: 'Bulbasaur',
                setName: '151',
                number: '001',
                imageLowUrl: null,
                imageHighUrl: null,
                explicit: false,
              },
            },
          ]}
          previews={[]}
          query="grass"
          ownership="all"
          page={0}
          focusNumber={null}
          restoreScrollY={0}
          pendingNumber={null}
          onQueryChange={() => undefined}
          onOwnershipChange={() => undefined}
          onPageChange={() => undefined}
          onChoose={() => undefined}
        />,
      );
    });

    expect(container.querySelectorAll('.species-row')).toHaveLength(1);
    expect(container.textContent).toContain('Bulbasaur');
    expect(container.textContent).not.toContain('No Pokémon match these filters.');
  });

  it('operates the region picker from the keyboard and announces pre-region counts', async () => {
    const onRegionChange = vi.fn();
    act(() => {
      root.render(
        <NationalPokedexView
          coverage={[]}
          previews={[]}
          query=""
          ownership="all"
          page={0}
          region="All"
          focusNumber={null}
          restoreScrollY={0}
          pendingNumber={null}
          onQueryChange={() => undefined}
          onOwnershipChange={() => undefined}
          onPageChange={() => undefined}
          onRegionChange={onRegionChange}
          onChoose={() => undefined}
        />,
      );
    });
    const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]');
    if (!trigger) throw new Error('Region picker trigger missing.');
    const selectedId = trigger.getAttribute('aria-labelledby')?.split(' ').at(-1);
    expect(selectedId).toBeTruthy();
    expect(document.getElementById(selectedId ?? '')?.textContent).toBe('All (1,025)');
    await act(() =>
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })),
    );
    const listbox = container.querySelector<HTMLElement>('[role="listbox"]');
    if (!listbox) throw new Error('Region picker listbox missing.');
    expect(listbox.textContent).toContain('Kanto');
    const counts = Array.from(listbox.querySelectorAll('[role="option"]')).map((option) =>
      option.textContent?.replace(/\s+/gu, ' ').trim(),
    );
    expect(trigger.textContent).toContain('All (1,025)');
    expect(counts).toContain('All (1,025)');
    expect(counts).toContain('Kanto (151)');
    await act(() =>
      listbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })),
    );
    await act(() =>
      listbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    );
    expect(onRegionChange).toHaveBeenCalledWith('Paldea');
    expect(document.activeElement).toBe(trigger);
  });

  it('dismisses the region picker when Tab moves focus away', async () => {
    act(() => {
      root.render(
        <NationalPokedexView
          coverage={[]}
          previews={[]}
          query=""
          ownership="all"
          page={0}
          region="All"
          focusNumber={null}
          restoreScrollY={0}
          pendingNumber={null}
          onQueryChange={() => undefined}
          onOwnershipChange={() => undefined}
          onPageChange={() => undefined}
          onRegionChange={() => undefined}
          onChoose={() => undefined}
        />,
      );
    });
    const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]');
    if (!trigger) throw new Error('Region picker trigger missing.');
    await act(() =>
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })),
    );
    const listbox = container.querySelector<HTMLElement>('[role="listbox"]');
    if (!listbox) throw new Error('Region picker listbox missing.');
    await act(async () => {
      listbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });

  it('finds any species and opens its variants', () => {
    const choose = vi.fn();
    let query = '';
    const render = (): void =>
      root.render(
        <NationalPokedexView
          coverage={[]}
          previews={[]}
          query={query}
          ownership="all"
          page={0}
          focusNumber={null}
          restoreScrollY={0}
          pendingNumber={null}
          onQueryChange={(value) => {
            query = value;
            render();
          }}
          onOwnershipChange={() => undefined}
          onPageChange={() => undefined}
          onChoose={choose}
        />,
      );
    act(() => {
      render();
    });
    const search = container.querySelector<HTMLInputElement>('input[type="search"]');
    act(() => {
      if (!search) throw new Error('search input missing');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        search,
        'Pecharunt',
      );
      search.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    });
    const row = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Pecharunt'),
    );
    expect(row).toBeDefined();
    act(() => row?.click());
    expect(choose).toHaveBeenCalledWith(
      expect.objectContaining({ number: 1025, name: 'Pecharunt', discoveryCategory: 'Paldea' }),
    );
  });
});
