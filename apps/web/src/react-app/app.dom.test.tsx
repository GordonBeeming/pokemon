// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './app';
import { CatalogueView } from './catalogue-view';
import { DevicesView } from './ui';

const apiMocks = vi.hoisted(() => ({
  me: vi.fn(),
  dashboard: vi.fn(),
  sets: vi.fn(),
  species: vi.fn(),
  tokens: vi.fn(),
  pair: vi.fn(),
  revokeToken: vi.fn(),
  search: vi.fn(),
}));

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return { ...actual, api: apiMocks };
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  if (!resolve) throw new Error('Deferred promise did not initialise.');
  return { promise, resolve };
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitFor(check: () => boolean, detail = ''): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (check()) return;
    await settle();
  }
  throw new Error(`Timed out waiting for the frontend state. ${detail}`);
}

describe('async frontend announcements', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    location.hash = '#devices';
    container = document.createElement('div');
    document.body.replaceChildren(container);
    root = createRoot(container);
    Object.values(apiMocks).forEach((mock) => mock.mockReset());
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it('announces route loading and completion with the loaded count', async () => {
    const tokens = deferred<Awaited<ReturnType<typeof apiMocks.tokens>>>();
    apiMocks.me.mockResolvedValue({ user: { id: 'owner' } });
    apiMocks.tokens.mockReturnValue(tokens.promise);

    act(() => root.render(<App />));
    await waitFor(
      () =>
        Array.from(container.querySelectorAll('[role="status"]')).some(
          (element) => element.textContent === 'Loading Devices.',
        ),
      `Rendered text: ${container.textContent ?? ''}`,
    );
    const liveStatus = Array.from(container.querySelectorAll('[role="status"]')).find(
      (element) => element.textContent === 'Loading Devices.',
    );
    expect(liveStatus?.textContent).toContain('Loading Devices.');
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();

    tokens.resolve([]);
    await settle();

    expect(liveStatus?.textContent).toContain('0 paired devices loaded.');
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it('replaces failed route loading with an announced retry state', async () => {
    apiMocks.me.mockResolvedValue({ user: { id: 'owner' } });
    apiMocks.tokens
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce([]);

    act(() => root.render(<App />));
    await waitFor(() => container.textContent?.includes('Devices could not load.') === true);

    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    const alerts = Array.from(container.querySelectorAll('[role="alert"]')).filter((element) =>
      element.textContent?.trim(),
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.textContent).toContain('Devices could not load.');
    expect(
      Array.from(container.querySelectorAll('[role="status"]')).some((element) =>
        element.textContent?.includes('Devices could not load.'),
      ),
    ).toBe(false);
    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Try again',
    );
    act(() => retry?.click());
    await waitFor(() => container.textContent?.includes('No scanner is paired.') === true);

    expect(apiMocks.tokens).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain('Devices could not load.');
    expect(container.textContent).not.toContain('The request could not be completed.');
  });

  it('reports clipboard rejection and leaves the visible code available', async () => {
    const copyFailed = vi.fn();
    const clipboard = { writeText: vi.fn().mockRejectedValue(new Error('clipboard denied')) };
    vi.stubGlobal('navigator', { ...navigator, clipboard });

    act(() => {
      root.render(
        <DevicesView
          tokens={[]}
          pairCode={{ ok: true, code: 'A1B2-C3D4', expiresAt: '2026-08-25T04:00:00Z' }}
          pending={false}
          pair={() => undefined}
          revoke={() => undefined}
          copied={() => undefined}
          copyFailed={copyFailed}
        />,
      );
    });
    const copy = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Copy code',
    );
    act(() => copy?.click());
    await settle();

    expect(clipboard.writeText).toHaveBeenCalledWith('A1B2-C3D4');
    expect(copyFailed).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('A1B2-C3D4');
  });

  it('uses keyset cursors for catalogue next and previous navigation', async () => {
    const firstPage = deferred<{ ok: true; total: number; cards: []; cursor: string }>();
    const secondPage = deferred<{ ok: true; total: number; cards: []; cursor: null }>();
    const previousPage = deferred<{ ok: true; total: number; cards: []; cursor: string }>();
    apiMocks.search
      .mockReturnValueOnce(firstPage.promise)
      .mockReturnValueOnce(secondPage.promise)
      .mockReturnValueOnce(previousPage.promise);

    act(() =>
      root.render(
        <CatalogueView initialParams={new URLSearchParams()} onNotice={() => undefined} />,
      ),
    );
    await waitFor(() => apiMocks.search.mock.calls.length === 1);
    const first = apiMocks.search.mock.calls[0]?.[0] as URLSearchParams;
    expect(first.has('offset')).toBe(false);
    expect(first.has('cursor')).toBe(false);
    await act(async () => {
      firstPage.resolve({ ok: true, total: 100, cards: [], cursor: 'cursor-2' });
      await firstPage.promise;
    });

    const next = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Next 50',
    );
    expect(next?.disabled).toBe(false);
    act(() => next?.click());
    await waitFor(() => apiMocks.search.mock.calls.length === 2);
    const second = apiMocks.search.mock.calls[1]?.[0] as URLSearchParams;
    expect(second.get('cursor')).toBe('cursor-2');
    expect(second.has('offset')).toBe(false);
    await act(async () => {
      secondPage.resolve({ ok: true, total: 100, cards: [], cursor: null });
      await secondPage.promise;
    });

    const previous = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Previous 50',
    );
    expect(previous?.disabled).toBe(false);
    act(() => previous?.click());
    await waitFor(() => apiMocks.search.mock.calls.length === 3);
    const third = apiMocks.search.mock.calls[2]?.[0] as URLSearchParams;
    expect(third.has('cursor')).toBe(false);
    expect(third.has('offset')).toBe(false);
    await act(async () => {
      previousPage.resolve({ ok: true, total: 100, cards: [], cursor: 'cursor-2' });
      await previousPage.promise;
    });
  });
});
