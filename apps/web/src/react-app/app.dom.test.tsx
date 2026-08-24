// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './app';
import { DevicesView } from './ui';

const apiMocks = vi.hoisted(() => ({
  me: vi.fn(),
  dashboard: vi.fn(),
  sets: vi.fn(),
  species: vi.fn(),
  tokens: vi.fn(),
  pair: vi.fn(),
  revokeToken: vi.fn(),
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
});
