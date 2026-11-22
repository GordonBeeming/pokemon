// @vitest-environment happy-dom
import { DEFAULT_FRAME_PALETTE, type TrainerDexEntry } from '@pokedex/shared';
import { act, useEffect, useRef, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InsertPanel } from './InsertPanel';
import type { PickerQuery } from './CardPicker';
import type { ResolvedCard } from '../../../api/queries/binders';

const { collect, directory } = vi.hoisted(() => ({
  collect: vi.fn(),
  directory: { failed: false, retry: vi.fn() },
}));
const brock = { id: 'brock-card', name: 'Brock' } as ResolvedCard;
const trainers: TrainerDexEntry[] = [
  {
    key: 'brock',
    name: 'Brock',
    regions: ['Kanto'],
    cardCount: 2,
    ownedCount: 0,
    representative: null,
  },
  {
    key: 'cynthia',
    name: 'Cynthia',
    regions: ['Sinnoh'],
    cardCount: 1,
    ownedCount: 0,
    representative: null,
  },
  {
    key: 'no-cards',
    name: 'No cards',
    regions: ['Kanto'],
    cardCount: 0,
    ownedCount: 0,
    representative: null,
  },
];
vi.mock('../../../api/queries/binders', () => ({
  useInsertDestinations: () => ({
    data: { appendAt: { page: 0, row: 0, column: 0 } },
    isError: false,
  }),
}));
vi.mock('../../../api/queries/sets', () => ({ useSets: () => ({ data: [] }) }));
vi.mock('../../../api/queries/trainer-dex', () => ({
  useTrainerDex: () => ({
    data: directory.failed ? undefined : trainers,
    isPending: false,
    isError: directory.failed,
    error: directory.failed ? new Error('Unavailable') : null,
    refetch: directory.retry,
  }),
}));
vi.mock('./Panel', () => ({
  Panel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('./CardPicker', () => ({
  collectAllCards: collect,
  CardPicker: ({
    query,
    onPick,
    onTotal,
  }: {
    query: PickerQuery;
    onPick: (card: ResolvedCard) => void;
    onTotal: (n: number, q: PickerQuery) => void;
  }) => {
    const criteria = JSON.stringify(query);
    const ref = useRef({ onTotal, query });
    ref.current = { onTotal, query };
    useEffect(() => ref.current.onTotal(2, ref.current.query), [criteria]);
    return (
      <button
        type="button"
        data-character={query.filters?.character}
        data-language={query.filters?.language}
        onClick={() => onPick(brock)}
      >
        Pick trainer card
      </button>
    );
  },
}));

let root: Root;
let container: HTMLDivElement;
async function step(f: () => unknown) {
  await act(async () => {
    f();
    await Promise.resolve();
  });
}
function button(text: string) {
  const b = [...container.querySelectorAll('button')].find((b) => b.textContent === text);
  if (!b) throw Error('Missing ' + text);
  return b;
}
function chooseType(value: string) {
  const radio = container.querySelector<HTMLInputElement>(`input[type=radio][value="${value}"]`);
  if (!radio) throw Error('Missing type ' + value);
  radio.click();
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  directory.failed = false;
  collect.mockResolvedValue([brock]);
});
afterEach(async () => {
  await step(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});
async function render() {
  const onInsert = vi.fn();
  await step(() =>
    root.render(
      <InsertPanel
        versionId="version"
        at={{ page: 3, row: 2, column: 0 }}
        reservedPage={false}
        palette={DEFAULT_FRAME_PALETTE}
        pending={false}
        error={null}
        onInsert={onInsert}
        onClose={() => undefined}
      />,
    ),
  );
  return onInsert;
}

it('chooses a Trainer Dex person and inserts their selected exact card rather than a Trainer Pokemon group', async () => {
  const insert = await render();
  await step(() => chooseType('trainer-dex'));
  expect(container.textContent).toContain('Cynthia');
  expect(container.textContent).not.toContain('No cards');
  const region = container.querySelector('select');
  if (!region) throw Error('Missing region');
  await step(() => {
    region.value = 'Kanto';
    region.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(container.textContent).not.toContain('Cynthia');
  await step(() => button('BrockKanto · 2 cards').click());
  const pick = button('Pick trainer card');
  expect(pick.dataset.character).toBe('brock');
  expect(pick.dataset.language).toBe('en');
  await step(() => pick.click());
  await step(() => button('Insert 1 selected target').click());
  expect(insert).toHaveBeenCalledWith({ page: 3, row: 2, column: 0 }, [
    { kind: 'exact-card', cardId: 'brock-card', startsNewPage: false },
  ]);
});

it('selects all only within the chosen trainer and clears selections when choosing another', async () => {
  await render();
  await step(() => chooseType('trainer-dex'));
  await step(() => button('BrockKanto · 2 cards').click());
  await step(() => button('Select all 2 matches').click());
  expect(collect).toHaveBeenCalledWith(
    { q: '', filters: { character: 'brock', language: 'en' } },
    expect.any(Number),
    expect.any(AbortSignal),
  );
  expect(container.textContent).toContain('1 targets selected');
  await step(() => button('Choose another trainer').click());
  expect(container.textContent).toContain('0 targets selected');
  await step(() => button('CynthiaSinnoh · 1 card').click());
  expect(button('Pick trainer card').dataset.character).toBe('cynthia');
});

it('offers retry when Trainer Dex fails without showing an empty result count', async () => {
  directory.failed = true;
  await render();
  await step(() => chooseType('trainer-dex'));
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(container.textContent).not.toContain('0 trainers with cards');
  await step(() => button('Try again').click());
  expect(directory.retry).toHaveBeenCalledOnce();
});
