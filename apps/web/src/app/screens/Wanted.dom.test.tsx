// @vitest-environment happy-dom
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { catalogueCardViewSchema, type WantedEntry } from '@pokedex/shared';
import type { WantedFilters } from '../api/queries/wanted';
import { Wanted } from './Wanted';
import { ToastProvider } from '../ui/Toast';
import { WantedControl } from './card/WantedControl';
const mocks = vi.hoisted(() => ({
  mutate: vi.fn<(input: { cardId: string; binderId: string | null; wanted: boolean }) => void>(),
  list: vi.fn<(filters: WantedFilters) => void>(),
}));
const entry: WantedEntry = {
  key: 'general:card:card',
  scope: 'general',
  binderId: null,
  binderName: null,
  cardId: 'card',
  card: catalogueCardViewSchema.parse({
    id: 'card',
    name: 'Squirtle',
    language: 'en',
    category: 'pokemon',
    setId: 'base',
    setName: 'Base Set',
    number: '63',
    pokedexNumber: 7,
    frameType: 'water',
    rarityKey: 'C',
    setCode: 'BS',
    imageLowUrl: null,
    imageHighUrl: null,
    collection: null,
    price: {
      amountAud: 3.5,
      nativeAmount: 2,
      nativeCurrency: 'USD',
      source: 'tcgplayer',
      sourceCapturedAt: '2026-11-18T00:00:00.000Z',
      fxDate: '2026-11-18',
    },
  }),
  name: 'Squirtle',
  setName: 'Base Set',
  number: '63',
  language: 'en',
  pokedexNumber: 7,
  imageLowUrl: null,
  manual: true,
  unfilled: 0,
  ownedQuantity: 1,
  placedCount: 1,
  createdAt: 1,
  targetKind: 'exact-card',
};
vi.mock('./card/CardInspector', () => ({
  CardInspector: ({
    cardId,
    onClose,
    onDirtyChange,
  }: {
    cardId: string;
    onClose: () => void;
    onDirtyChange?: (dirty: boolean) => void;
  }) => (
    <div data-testid="wanted-card-inspector">
      <span>{cardId}</span>
      <button type="button" onClick={onClose}>
        Close inspector
      </button>
      <button type="button" onClick={() => onDirtyChange?.(true)}>
        Edit notes
      </button>
    </div>
  ),
}));
vi.mock('../api/queries/binders', () => ({
  useBinders: () => ({ data: [{ id: 'binder', name: 'National' }] }),
}));
vi.mock('../api/queries/wanted', async (original) => ({
  ...(await original<typeof import('../api/queries/wanted')>()),
  useSetWanted: () => ({ mutate: mocks.mutate, isPending: false, isError: false }),
  useWantedScopes: () => ({ data: [], isPending: false, isError: false }),
  useWantedList: (filters: WantedFilters) => {
    mocks.list(filters);
    return {
      isPending: false,
      isError: false,
      data: { total: 1, entries: [entry], nextOffset: null },
    };
  },
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({
    children,
    to,
    params = {},
  }: {
    children: ReactNode;
    to: string;
    params?: Record<string, string>;
  }) => <a href={to.replace(/\$[A-Za-z]+/g, (key) => params[key.slice(1)] ?? key)}>{children}</a>,
}));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.replaceChildren(container);
  root = createRoot(container);
  mocks.mutate.mockClear();
  mocks.list.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});
function Page() {
  const [search, setSearch] = useState<WantedFilters>({
    scope: 'all',
    includeUnfilled: false,
    q: '',
    sort: 'name',
    offset: 0,
  });
  return <Wanted search={search} onSearch={setSearch} />;
}
for (const [device, width, height] of [
  ['phone portrait', 390, 844],
  ['phone landscape', 844, 390],
  ['tablet portrait', 768, 1024],
  ['tablet landscape', 1024, 768],
  ['desktop', 1440, 1000],
] as const) {
  it(`keeps shopping controls usable on ${device}`, () => {
    Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
    act(() => root.render(<Page />));
    const toggle = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!toggle) throw new Error('Missing target toggle');
    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(true);
    const scope = container.querySelector('select');
    if (!scope) throw new Error('Missing scope');
    act(() => {
      scope.value = 'binder';
      scope.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(mocks.list.mock.lastCall?.[0].scope).toBe('binder');
    expect(toggle.disabled).toBe(false);
    act(() => toggle.click());
    expect(mocks.list.mock.lastCall?.[0].includeUnfilled).toBe(true);
    const remove = container.querySelector<HTMLButtonElement>(
      'button[aria-label^="Remove Squirtle"]',
    );
    expect(remove?.disabled).toBe(false);
    act(() => remove?.click());
    expect(mocks.mutate).toHaveBeenCalledWith({ cardId: 'card', binderId: null, wanted: false });
    expect(container.querySelector('.wanted-details')?.textContent).toBe('GeneralRemove');
    expect(container.querySelector('.wanted-details h2')).toBeNull();
    expect(container.querySelector('.wanted-details')?.textContent).not.toContain('owned');
    const placement = container.querySelectorAll('select')[1];
    if (!placement) throw new Error('Missing placement filter');
    act(() => {
      placement.value = 'placed';
      placement.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(mocks.list.mock.lastCall?.[0].placement).toBe('placed');
    const frame = container.querySelector('.wanted-item .card-frame');
    expect(frame?.classList.contains('card-frame-raw')).toBe(false);
    expect(frame?.textContent).toContain('#007');
    expect(frame?.textContent).toContain('BS');
    expect(frame?.querySelector('.card-frame-rarity')).not.toBeNull();
    expect(frame?.querySelector('.card-frame-price')?.textContent).toBe('~A$4');
    act(() =>
      root.render(
        <ToastProvider>
          <Page />
        </ToastProvider>,
      ),
    );
    act(() =>
      container.querySelector<HTMLButtonElement>('.wanted-item button.card-frame')?.click(),
    );
    expect(document.querySelector('.side-panel')).not.toBeNull();
    expect(document.querySelector('[data-testid="wanted-card-inspector"]')?.textContent).toContain(
      'card',
    );
    act(() =>
      [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find((b) => b.textContent === 'Close inspector')
        ?.click(),
    );
    expect(document.querySelector('.side-panel')).toBeNull();
  });
}
it('marks a specific printing for General or a chosen binder without placing it', () => {
  act(() => root.render(<WantedControl cardId="card" binderId="binder" />));
  const select = container.querySelector('select');
  if (!select) throw new Error('Missing list selector');
  expect(select.value).toBe('binder');
  const button = Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent === 'Mark as wanted',
  );
  if (!button) throw new Error('Missing wanted control');
  act(() => button.click());
  expect(mocks.mutate).toHaveBeenLastCalledWith({
    cardId: 'card',
    binderId: 'binder',
    wanted: true,
  });
  act(() => {
    select.value = 'general';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  act(() => button.click());
  expect(mocks.mutate).toHaveBeenLastCalledWith({ cardId: 'card', binderId: null, wanted: true });
});
