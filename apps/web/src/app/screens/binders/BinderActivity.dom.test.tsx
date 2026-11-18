// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { BinderActivityResult } from '@pokedex/shared';
import { BinderActivity } from './BinderActivity';
const mocks = vi.hoisted(() => ({
  read: vi.fn<
    (id: string, query: URLSearchParams, signal?: AbortSignal) => Promise<BinderActivityResult>
  >(),
  checkpoint: vi.fn(),
}));
vi.mock('../../api/queries/binder-activity', async (original) => ({
  ...(await original<typeof import('../../api/queries/binder-activity')>()),
  api: { binderActivity: mocks.read, createBinderCheckpoint: mocks.checkpoint },
}));
let root: Root;
let container: HTMLDivElement;
const result: BinderActivityResult = {
  selectedBatch: 'before',
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
      name: 'Squirtle',
      setName: 'Base',
      number: '7',
      language: 'en',
      pokedexNumber: 7,
      region: 'Kanto',
      imageLowUrl: null,
    },
  ],
};
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  mocks.read.mockReset().mockResolvedValue(result);
  mocks.checkpoint.mockReset().mockResolvedValue('new');
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
    (b) => b.textContent === text,
  );
  if (!match) throw new Error(`Missing button ${text}`);
  return match;
}
async function open() {
  act(() => root.render(<BinderActivity binderId="b" revision={1} />));
  await settle();
}
it('supports multiple regions, sorts and checkpoint navigation', async () => {
  await open();
  expect(container.textContent).toContain('Squirtle');
  expect(container.textContent).toContain('AEST');
  const checks = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  act(() => {
    checks[0]?.click();
    checks[1]?.click();
  });
  await settle();
  expect(mocks.read.mock.lastCall?.[1].get('regions')).toBe('Kanto,Johto');
  const sort = Array.from(container.querySelectorAll('select')).find((s) =>
    s.parentElement?.textContent?.startsWith('Sort by'),
  );
  if (!sort) throw new Error('Missing sort');
  act(() => {
    sort.value = 'binder';
    sort.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
  expect(mocks.read.mock.lastCall?.[1].get('sort')).toBe('binder');
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
