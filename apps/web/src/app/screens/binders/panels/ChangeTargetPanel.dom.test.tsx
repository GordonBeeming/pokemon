// @vitest-environment happy-dom
import { DEFAULT_FRAME_PALETTE } from '@pokedex/shared';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BinderSlotView, ResolvedCard } from '../../../api/queries/binders';
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

function button(name: string): HTMLButtonElement {
  const found = Array.from(document.body.querySelectorAll('button')).find(
    (item) => item.textContent?.trim() === name,
  );
  if (!found) throw new Error(`Button not found: ${name}`);
  return found;
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
  // Placing a copy is Find cards' job; Change target only ever changes the target.
  it('sets the picked card as the target, even on a Pokémon sleeve in same-type mode', async () => {
    const onChoose = vi.fn();
    const slot: BinderSlotView = {
      pageId: 'page_1',
      row: 0,
      column: 1,
      cardId: null,
      entryKind: 'pokemon',
      label: null,
      pokemonNumber: 344,
      assignedCardId: null,
      startsNewPage: false,
    };
    await step(() =>
      root.render(
        <ChangeTargetPanel
          slot={slot}
          pocketLabel="Page 1 · row 1, pocket 2"
          cards={new Map()}
          palette={DEFAULT_FRAME_PALETTE}
          pending={false}
          error={null}
          onChoose={onChoose}
          onClose={() => undefined}
        />,
      ),
    );
    await step(() => button('Pick Claydol').click());
    await step(() => button('Set as target').click());

    expect(onChoose).toHaveBeenCalledWith(claydol);
  });
});
