// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { BinderSpaceSearch } from './binder-space-search';
const search = vi.hoisted(() => vi.fn());
vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  api: { searchBinder: search },
}));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  search.mockReset();
  container = document.createElement('div');
  document.body.replaceChildren(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});
async function enter(text: string) {
  act(() => {
    const input = container.querySelector('input');
    if (!input) throw new Error('Missing search');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(() => vi.advanceTimersByTimeAsync(260));
}
it('jumps to the exact result and clears results when the query is cleared', async () => {
  const match = {
    page: 24,
    row: 1,
    column: 2,
    label: '#0025 Pikachu',
    kind: 'pokemon',
    placed: false,
  };
  search.mockResolvedValue({ matches: [match], nextOffset: null });
  const jump = vi.fn();
  act(() =>
    root.render(<BinderSpaceSearch versionId="v" revision={1} pending={false} onJump={jump} />),
  );
  await enter('Pikachu');
  expect(container.textContent).toContain('Page 25 · Row 2, column 3 · Unfilled');
  act(() => container.querySelector<HTMLButtonElement>('.binder-space-results button')?.click());
  expect(jump).toHaveBeenCalledWith(match);
  await enter('');
  expect(container.querySelector('.binder-space-results')).toBeNull();
});
it('ignores stale results and shows failures without presenting them as no matches', async () => {
  let finish: ((value: unknown) => void) | undefined;
  search.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  act(() =>
    root.render(
      <BinderSpaceSearch versionId="v" revision={1} pending={false} onJump={() => undefined} />,
    ),
  );
  await enter('old');
  search.mockRejectedValueOnce(new Error('Offline'));
  await enter('new');
  act(() => {
    finish?.({
      matches: [{ page: 0, row: 0, column: 0, label: 'Stale', kind: 'reserved', placed: false }],
      nextOffset: null,
    });
  });
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(container.textContent).not.toContain('Stale');
  expect(container.textContent).not.toContain('No matching spaces.');
});
