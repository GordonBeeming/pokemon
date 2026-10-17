// @vitest-environment happy-dom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BinderSlotView, ResolvedCard } from '../../../api/queries/binders';
import { DEFAULT_FRAME_PALETTE } from '@pokedex/shared';
import { ChangeTargetPanel } from './ChangeTargetPanel';

const claydol = {
  id: 'card-claydol-xy7',
  name: 'Claydol',
  language: 'en',
  category: 'pokemon',
  setId: 'xy7',
  setName: 'Ancient Origins',
  number: '33',
  imageLowUrl: null,
  imageHighUrl: null,
  pokedexNumber: 344,
  collection: null,
  price: {
    amountAud: null,
    nativeAmount: null,
    nativeCurrency: null,
    source: null,
    sourceCapturedAt: null,
    fxDate: null,
  },
  frameType: 'psychic',
  setCode: 'AOR',
  rarityKey: 'U',
} as ResolvedCard;

// The real picker searches the catalogue; these tests only need a card to come back.
vi.mock('./CardPicker', () => ({
  CardPicker: ({ onPick }: { onPick: (card: ResolvedCard) => void }): ReactElement => (
    <button type="button" onClick={() => onPick(claydol)}>
      Pick Claydol
    </button>
  ),
}));

let container: HTMLDivElement;
let root: Root;

async function step(action: () => unknown): Promise<void> {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}

function slot(overrides: Partial<BinderSlotView>): BinderSlotView {
  return {
    pageId: 'page_1',
    row: 0,
    column: 1,
    cardId: null,
    entryKind: 'empty',
    label: null,
    pokemonNumber: null,
    assignedCardId: null,
    startsNewPage: false,
    ...overrides,
  };
}

function button(name: string): HTMLButtonElement {
  const found = Array.from(document.body.querySelectorAll('button')).find(
    (item) => item.textContent?.trim() === name,
  );
  if (!found) throw new Error(`Button not found: ${name}`);
  return found;
}

async function pickAndConfirm(target: BinderSlotView, mode: 'same' | 'any') {
  const onChoose = vi.fn();
  const onPlace = vi.fn();
  await step(() =>
    root.render(
      <ChangeTargetPanel
        slot={target}
        pocketLabel="Page 1 · row 1, pocket 2"
        cards={new Map()}
        palette={DEFAULT_FRAME_PALETTE}
        pending={false}
        error={null}
        onChoose={onChoose}
        onPlace={onPlace}
        onClose={() => undefined}
      />,
    ),
  );
  if (mode === 'any') {
    const option = Array.from(document.body.querySelectorAll('label')).find(
      (item) => item.textContent?.trim() === 'Replace with any card',
    );
    if (!option) throw new Error('Replace with any card option missing');
    await step(() => option.click());
  }
  await step(() => button('Pick Claydol').click());
  const confirm = document.body.querySelector<HTMLButtonElement>('.copy-choice .button-primary');
  if (!confirm) throw new Error('Confirm button missing');
  const label = confirm.textContent;
  await step(() => confirm.click());
  return { onChoose, onPlace, label, text: document.body.textContent ?? '' };
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await step(() => root.unmount());
  container.remove();
});

describe('ChangeTargetPanel', () => {
  it('places the picked copy and keeps a Pokémon sleeve’s target in same-type mode', async () => {
    const result = await pickAndConfirm(slot({ entryKind: 'pokemon', pokemonNumber: 344 }), 'same');
    expect(result.label).toBe('Place this copy');
    expect(result.onPlace).toHaveBeenCalledWith(claydol);
    expect(result.onChoose).not.toHaveBeenCalled();
  });

  it('places a copy for a group sleeve in same-type mode', async () => {
    const result = await pickAndConfirm(
      slot({ entryKind: 'illustrator', groupKey: 'ken-sugimori', groupName: 'Ken Sugimori' }),
      'same',
    );
    expect(result.onPlace).toHaveBeenCalledWith(claydol);
    expect(result.onChoose).not.toHaveBeenCalled();
  });

  it('still retargets a typed sleeve when replacing with any card', async () => {
    const result = await pickAndConfirm(slot({ entryKind: 'pokemon', pokemonNumber: 344 }), 'any');
    expect(result.label).toBe('Set as target');
    expect(result.onChoose).toHaveBeenCalledWith(claydol);
    expect(result.onPlace).not.toHaveBeenCalled();
  });

  it('still retargets an exact-card sleeve in same-type mode', async () => {
    const result = await pickAndConfirm(
      slot({ entryKind: 'exact-card', cardId: 'card-claydol-dp4', pokemonNumber: 344 }),
      'same',
    );
    expect(result.onChoose).toHaveBeenCalledWith(claydol);
    expect(result.onPlace).not.toHaveBeenCalled();
  });
});
