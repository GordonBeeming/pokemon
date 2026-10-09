// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { useSession } from '../api/queries/session';
import { ToastProvider } from '../ui/Toast';
import { LogoutButton } from './LogoutButton';

const exit = vi.hoisted(() => ({ reloadSignedOut: vi.fn(), announceLoggedOut: vi.fn() }));
vi.mock('../api/session-exit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/session-exit')>()),
  ...exit,
}));

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
let requests: Array<{ method: string; path: string }>;
let signedIn: boolean;
let logout: 'ok' | 'refused' | 'lost';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubServer(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      requests.push({ method, path });
      if (path === '/api/auth/me')
        return Promise.resolve(
          signedIn
            ? json(200, { ok: true, sub: 'user-1', label: 'Ash', role: 'admin' })
            : json(401, { ok: false, error: 'unauthorized' }),
        );
      if (path === '/api/auth/logout') {
        if (logout === 'refused')
          return Promise.resolve(json(503, { ok: false, error: 'unavailable' }));
        signedIn = false;
        if (logout === 'lost') return Promise.reject(new TypeError('Failed to fetch'));
        return Promise.resolve(json(200, { ok: true }));
      }
      return Promise.resolve(json(200, { ok: true, items: ['private'] }));
    }),
  );
}

function stubCaches(keys: () => Promise<string[]>): ReturnType<typeof vi.fn> {
  const remove = vi.fn().mockResolvedValue(true);
  vi.stubGlobal('caches', { keys: vi.fn(keys), delete: remove });
  return remove;
}

// Stands in for the shell: one session-gated screen plus a private query whose cache
// must not outlive the session.
function Harness(): ReactElement {
  const session = useSession();
  useQuery({
    queryKey: ['private-data'],
    queryFn: () => fetch('/api/private').then((response) => response.json()),
    enabled: session.data !== undefined,
  });
  if (session.isLoading) return <p>Checking</p>;
  if (session.error instanceof ApiError && session.error.status === 401) return <p>Signed out</p>;
  if (session.isError) return <p>Could not start</p>;
  if (!session.data) return <p>Checking</p>;
  return (
    <div>
      <p>Signed in as {session.data.label}</p>
      <LogoutButton />
    </div>
  );
}

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

async function render(): Promise<void> {
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <Harness />
        </ToastProvider>
      </QueryClientProvider>,
    );
  });
  await flush();
}

async function clickLogout(): Promise<void> {
  const button = Array.from(container.querySelectorAll('button')).find(
    (item) => item.textContent === 'Log out',
  );
  if (!button) throw new Error('Log out button missing');
  act(() => button.click());
  await flush();
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  requests = [];
  signedIn = true;
  logout = 'ok';
  exit.reloadSignedOut.mockReset();
  exit.announceLoggedOut.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal('navigator', {});
  stubServer();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('LogoutButton', () => {
  it('ends the session, drops private data, tells other tabs and reloads', async () => {
    await render();
    expect(container.textContent).toContain('Signed in as Ash');
    expect(client.getQueryData(['private-data'])).toBeDefined();

    await clickLogout();

    expect(requests).toContainEqual({ method: 'POST', path: '/api/auth/logout' });
    expect(client.getQueryData(['private-data'])).toBeUndefined();
    expect(exit.announceLoggedOut).toHaveBeenCalledTimes(1);
    expect(exit.reloadSignedOut).toHaveBeenCalledTimes(1);
  });

  it('keeps the person signed in and says so when the server refuses', async () => {
    logout = 'refused';
    await render();

    await clickLogout();

    expect(container.textContent).toContain('Signed in as Ash');
    expect(document.body.textContent).toContain('Log out could not be completed');
    expect(exit.reloadSignedOut).not.toHaveBeenCalled();
  });

  it('treats a lost response as signed out once the server confirms it', async () => {
    logout = 'lost';
    await render();

    await clickLogout();

    expect(document.body.textContent).not.toContain('Log out could not be completed');
    expect(exit.reloadSignedOut).toHaveBeenCalledTimes(1);
  });

  it('still signs out when the browser refuses CacheStorage on every call', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    stubCaches(() => Promise.reject(new Error('storage locked')));
    await render();

    await clickLogout();

    expect(exit.reloadSignedOut).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Private cache purge failed after logout', expect.any(Error));
  });

  it('shows sign-in, not a startup error, for a 401 while CacheStorage is refused', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    stubCaches(() => Promise.reject(new Error('storage locked')));
    signedIn = false;

    await render();

    expect(container.textContent).toContain('Signed out');
  });

  it('keeps the public shell cache when purging', async () => {
    const remove = stubCaches(() => Promise.resolve(['pokedex-shell-v3', 'pokedex-private-1']));
    await render();

    await clickLogout();

    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith('pokedex-private-1');
  });
});
