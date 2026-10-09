// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSession } from '../api/queries/session';
import { ToastProvider } from '../ui/Toast';
import { LogoutButton } from './LogoutButton';

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
let requests: Array<{ method: string; path: string }>;
let signedIn: boolean;
let logoutStatus: number;

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
        if (logoutStatus !== 200)
          return Promise.resolve(json(logoutStatus, { ok: false, error: 'unavailable' }));
        signedIn = false;
        return Promise.resolve(json(200, { ok: true }));
      }
      return Promise.resolve(json(200, { ok: true, items: ['private'] }));
    }),
  );
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
  if (!session.data) return <p>Signed out</p>;
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

function logoutButton(): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (item) => item.textContent === 'Log out',
  );
  if (!button) throw new Error('Log out button missing');
  return button;
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  requests = [];
  signedIn = true;
  logoutStatus = 200;
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
  it('ends the session, drops private data and lands on sign-in', async () => {
    await render();
    expect(container.textContent).toContain('Signed in as Ash');
    expect(client.getQueryData(['private-data'])).toBeDefined();

    act(() => logoutButton().click());
    await flush();

    expect(requests).toContainEqual({ method: 'POST', path: '/api/auth/logout' });
    expect(container.textContent).toContain('Signed out');
    expect(client.getQueryData(['private-data'])).toBeUndefined();
  });

  it('keeps the person signed in and says so when the server refuses', async () => {
    logoutStatus = 503;
    await render();

    act(() => logoutButton().click());
    await flush();

    expect(container.textContent).toContain('Signed in as Ash');
    expect(document.body.textContent).toContain('Log out could not be completed');
    expect(logoutButton().disabled).toBe(false);
  });

  it('still signs out when clearing the private caches fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('caches', {
      keys: vi.fn().mockRejectedValueOnce(new Error('storage locked')).mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(true),
    });
    await render();

    act(() => logoutButton().click());
    await flush();

    expect(container.textContent).toContain('Signed out');
    expect(warn).toHaveBeenCalledWith('Private cache purge failed after logout', expect.any(Error));
  });
});
