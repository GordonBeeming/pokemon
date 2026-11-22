// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { cardIdSchema, type BinderActivityResult } from '@pokedex/shared';
import { BinderActivity } from './BinderActivity';
import { PriceVisibilityContextForTests } from '../../cards/PriceVisibility';
const mocks = vi.hoisted(() => ({
  read: vi.fn<
    (id: string, query: URLSearchParams, signal?: AbortSignal) => Promise<BinderActivityResult>
  >(),
  checkpoint: vi.fn(),
  order: vi.fn(),
}));
vi.mock('../../api/queries/binder-activity', async (original) => ({
  ...(await original<typeof import('../../api/queries/binder-activity')>()),
  api: { binderActivity: mocks.read, createBinderCheckpoint: mocks.checkpoint },
}));
vi.mock('../../api/queries/binders', async (original) => {
  const actual = await original<typeof import('../../api/queries/binders')>();
  return { ...actual, binderApi: { ...actual.binderApi, orderStatus: mocks.order } };
});
let root: Root;
let container: HTMLDivElement;
const result: BinderActivityResult = {
  selectedBatch: 'before',
  pendingChanges: 3,
  sections: [
    { id: 'bookmark:Kanto Art', name: 'Kanto Art' },
    { id: 'bookmark:Johto', name: 'Johto' },
  ],
  batches: [
    { id: 'current', createdAt: 100, count: 0 },
    { id: 'before', createdAt: 50, count: 1 },
    { id: 'beginning', createdAt: null, count: 2 },
  ],
  total: 1,
  events: [
    {
      id: 1,
      kind: 'added',
      createdAt: 60,
      versionId: 'v',
      versionNumber: 1,
      page: 2,
      row: 0,
      column: 1,
      cardId: 'squirtle',
      card: {
        id: cardIdSchema.parse('squirtle'),
        name: 'Squirtle',
        category: 'pokemon',
        language: 'en',
        setId: 'base',
        setName: 'Base',
        setCode: 'BS',
        number: '7',
        pokedexNumber: 7,
        frameType: 'water',
        rarityKey: 'C',
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
      },
      name: 'Squirtle',
      setName: 'Base',
      number: '7',
      language: 'en',
      pokedexNumber: 7,
      region: null,
      sectionName: 'Kanto Art',
      imageLowUrl: null,
    },
  ],
};
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  mocks.read.mockReset().mockResolvedValue(result);
  mocks.order.mockReset().mockResolvedValue({ version: { id: 'v' }, pages: [] });
  mocks.checkpoint.mockReset().mockResolvedValue({ ok: true, checkpointId: 'new', created: true });
  container = document.createElement('div');
  document.body.replaceChildren(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});
async function settle() {
  await act(() => vi.advanceTimersByTimeAsync(250));
}
function button(text: string) {
  const match = Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent === text || b.getAttribute('aria-label') === text,
  );
  if (!match) throw new Error(`Missing button ${text}`);
  return match;
}
async function open() {
  act(() => root.render(<BinderActivity binderId="b" revision={1} />));
  await settle();
}
it('supports multiple bookmark sections, sorts and checkpoint navigation', async () => {
  await open();
  expect(mocks.read.mock.lastCall?.[1].get('sort')).toBe('binder');
  expect(container.textContent).toContain('Squirtle');
  expect(container.textContent).toContain('Kanto Art');
  const checks = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  act(() => {
    checks[0]?.click();
    checks[1]?.click();
  });
  await settle();
  expect(JSON.parse(mocks.read.mock.lastCall?.[1].get('sections') ?? '[]')).toEqual([
    'bookmark:Kanto Art',
    'bookmark:Johto',
  ]);
  const sort = Array.from(container.querySelectorAll('select')).find((s) =>
    s.parentElement?.textContent?.startsWith('Sort by'),
  );
  if (!sort) throw new Error('Missing sort');
  act(() => {
    sort.value = 'newest';
    sort.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
  expect(mocks.read.mock.lastCall?.[1].get('sort')).toBe('newest');
  act(() => button('Older batch').click());
  await settle();
  expect(mocks.read.mock.lastCall?.[1].get('batch')).toBe('beginning');
  await act(async () => {
    button('Create checkpoint').click();
    await Promise.resolve();
  });
  await settle();
  expect(mocks.checkpoint).toHaveBeenCalledWith('b');
  expect(mocks.read.mock.lastCall?.[1].has('batch')).toBe(false);
  expect(container.textContent).toContain('Checkpoint created');
});
it('shows fetch and checkpoint failures without showing stale results as current', async () => {
  mocks.read.mockRejectedValueOnce(new Error('Offline'));
  await open();
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(container.textContent).not.toContain('No matching placements');
  act(() => button('Try again').click());
  await settle();
  expect(container.textContent).toContain('Squirtle');
  mocks.checkpoint.mockRejectedValueOnce(new Error('Offline'));
  await act(async () => {
    button('Create checkpoint').click();
    await Promise.resolve();
  });
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(container.textContent).not.toContain('Checkpoint created');
});

it('disables checkpoints when the current batch has no changes even while viewing history', async () => {
  mocks.read.mockResolvedValue({ ...result, pendingChanges: 0 });
  await open();
  expect(button('Create checkpoint').disabled).toBe(true);
  act(() => button('Create checkpoint').click());
  expect(mocks.checkpoint).not.toHaveBeenCalled();
});
it('reports an empty concurrent checkpoint as a no-op', async () => {
  mocks.checkpoint.mockResolvedValue({ ok: true, checkpointId: 'existing', created: false });
  await open();
  await act(async () => {
    button('Create checkpoint').click();
    await Promise.resolve();
  });
  await settle();
  expect(container.textContent).toContain('No new changes to checkpoint.');
  expect(container.textContent).not.toContain('Checkpoint created.');
});

it('keeps a selected section visible when a different batch has no matches for it', async () => {
  mocks.read.mockResolvedValueOnce({
    ...result,
    sections: [...result.sections, { id: 'unbookmarked', name: 'Unbookmarked' }],
  });
  await open();
  const label = Array.from(container.querySelectorAll('label')).find(
    (l) => l.textContent === 'Unbookmarked',
  );
  const checkbox = label?.querySelector('input');
  if (!checkbox) throw new Error('Missing unbookmarked filter');
  act(() => checkbox.click());
  await settle();
  const retained = Array.from(container.querySelectorAll('label'))
    .find((l) => l.textContent === 'Unbookmarked')
    ?.querySelector('input');
  expect(retained?.checked).toBe(true);
});

it.each([
  [1440, 1000],
  [390, 844],
  [844, 390],
  [768, 1024],
  [1024, 768],
])('uses standard interactive card chrome with pocket details at %ix%i', async (width, height) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
  const onOpenCard = vi.fn();
  act(() => root.render(<BinderActivity binderId="b" revision={1} onOpenCard={onOpenCard} />));
  await settle();
  const tile = container.querySelector('.binder-activity-grid li');
  const frame = tile?.querySelector<HTMLButtonElement>('button.card-frame');
  expect(frame).not.toBeNull();
  expect(frame?.classList.contains('card-frame-raw')).toBe(false);
  expect(frame?.textContent).toContain('#007');
  expect(frame?.textContent).toContain('Kanto');
  expect(frame?.textContent).toContain('BS');
  expect(frame?.querySelector('.card-frame-rarity')).not.toBeNull();
  expect(frame?.querySelector('.card-frame-price')?.textContent).toBe('~A$4');
  expect(frame?.getAttribute('aria-label')).toContain('not owned');
  expect(tile?.textContent).toContain('Page 3 · row 1 · pocket 2');
  expect(tile?.textContent).toContain('Added');
  expect(tile?.textContent).not.toContain('AEST');
  expect(tile?.textContent).not.toContain('V1');
  act(() => frame?.click());
  expect(onOpenCard).toHaveBeenCalledWith('squirtle');
});

it('respects the standard hidden-price setting', async () => {
  act(() =>
    root.render(
      <PriceVisibilityContextForTests value={false}>
        <BinderActivity binderId="b" revision={1} />
      </PriceVisibilityContextForTests>,
    ),
  );
  await settle();
  expect(container.querySelector('.card-frame-code')).not.toBeNull();
  expect(container.querySelector('.card-frame-price')).toBeNull();
});

it.each([
  [1440, 1000],
  [390, 844],
  [844, 390],
  [768, 1024],
  [1024, 768],
])('receives outstanding orders across checkpoints at %ix%i', async (width, height) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
  const original = result.events[0];
  if (!original) throw new Error('Missing fixture event');
  let received = false;
  const onMutation = vi.fn();
  mocks.order.mockImplementation(() => {
    received = true;
    return Promise.resolve({ version: { id: 'v' }, pages: [] });
  });
  mocks.read.mockImplementation((_id, query) =>
    Promise.resolve(
      query.get('kind') === 'ordered'
        ? {
            ...result,
            total: received ? 0 : 1,
            events: received ? [] : [{ ...original, kind: 'ordered', versionRevision: 2 }],
          }
        : result,
    ),
  );
  act(() => root.render(<BinderActivity binderId="b" revision={1} onMutation={onMutation} />));
  await settle();
  const kind = [...container.querySelectorAll('select')].find((s) =>
    s.parentElement?.textContent?.startsWith('Changes'),
  );
  if (!kind) throw new Error('Missing change filter');
  act(() => {
    kind.value = 'ordered';
    kind.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
  expect(container.querySelector('.activity-batch-bar')).toBeNull();
  expect(container.textContent).toContain('across all checkpoints');
  expect(container.querySelector('.card-frame-order-badge')?.textContent).toBe('Ordered');
  await act(async () => {
    button('Mark received').click();
    await Promise.resolve();
  });
  await settle();
  expect(mocks.order).toHaveBeenCalledWith(
    'v',
    { page: 2, row: 0, column: 1 },
    'squirtle',
    'received',
    2,
  );
  expect(onMutation).toHaveBeenCalledOnce();
  expect(container.querySelectorAll('.binder-activity-grid li')).toHaveLength(0);
});
