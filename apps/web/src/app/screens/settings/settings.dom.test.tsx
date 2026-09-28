// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isLowContrast } from '../../cards/color';
import { ToastProvider } from '../../ui/Toast';
import { CatalogueSyncTab } from './CatalogueSyncTab';
import { FrameColoursTab } from './FrameColoursTab';
import { PeopleTab } from './PeopleTab';

async function step(action: () => unknown): Promise<void> {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}

let container: HTMLDivElement;
let root: Root;
let requests: Array<{ method: string; path: string; body: unknown }>;

type Answer = { status: number; body: unknown };

function stubFetch(answer: (method: string, path: string) => Answer): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      requests.push({
        method,
        path,
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      });
      const { status, body } = answer(method, path);
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
}

async function render(node: ReactNode): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await step(() =>
    root.render(
      <QueryClientProvider client={client}>
        <ToastProvider>{node}</ToastProvider>
      </QueryClientProvider>,
    ),
  );
  await flush();
}

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  requests = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await step(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('FrameColoursTab', () => {
  it('warns when a custom colour leaves neither white nor dark text readable', async () => {
    stubFetch(() => ({ status: 200, body: { ok: true, framePalette: {} } }));
    await render(<FrameColoursTab />);
    expect(container.textContent).not.toContain('Text hard to read');

    // Mid grey: about 4.5:1 short against both white and the dark ink.
    const grey = '#7a7a7a';
    expect(isLowContrast(grey)).toBe(true);
    const picker = container.querySelector<HTMLInputElement>(
      'input[aria-label="Fire custom colour"]',
    );
    if (!picker) throw new Error('fire picker missing');
    await step(() => {
      Reflect.set(HTMLInputElement.prototype, 'value', grey, picker);
      picker.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const fireRow = picker.closest('li');
    expect(fireRow?.textContent).toContain('Text hard to read');
    // Other types are unaffected.
    const grassRow = container
      .querySelector('input[aria-label="Grass custom colour"]')
      ?.closest('li');
    expect(grassRow?.textContent).not.toContain('Text hard to read');
  });

  it('saves a preset swatch as a whole-palette PUT', async () => {
    stubFetch(() => ({ status: 200, body: { ok: true, framePalette: {} } }));
    await render(<FrameColoursTab />);
    const swatch = container.querySelector<HTMLButtonElement>(
      '[aria-label="Grass frame colour"] button[aria-label="#166534"]',
    );
    await step(() => swatch?.click());
    await flush();
    const put = requests.find((request) => request.method === 'PUT');
    expect(put?.path).toBe('/api/settings/frame-palette');
    expect(put?.body).toEqual({ palette: { grass: '#166534' } });
  });
});

describe('PeopleTab', () => {
  const people = [
    {
      id: 'owner',
      label: 'Gordon',
      role: 'admin',
      disabledAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      passkeyCount: 1,
      lastUsedAt: null,
    },
    {
      id: 'user_2',
      label: 'Family',
      role: 'member',
      disabledAt: null,
      createdAt: '2026-09-01T00:00:00.000Z',
      passkeyCount: 1,
      lastUsedAt: null,
    },
  ];

  it('shows the last-admin refusal plainly and changes nothing', async () => {
    stubFetch((method, path) => {
      if (method === 'PATCH')
        return { status: 409, body: { ok: false, error: 'last_admin', requestId: 'r1' } };
      if (path === '/api/people') return { status: 200, body: { ok: true, people } };
      if (path === '/api/people/invites') return { status: 200, body: { ok: true, invites: [] } };
      return { status: 404, body: { ok: false, error: 'not_found' } };
    });
    await render(<PeopleTab meId="owner" />);
    const group = container.querySelector('[aria-label="Role for Gordon"]');
    const member = [...(group?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent === 'Member',
    );
    if (!member) throw new Error('member toggle missing');
    await step(() => member.click());
    await flush();

    const patch = requests.find((request) => request.method === 'PATCH');
    expect(patch?.path).toBe('/api/people/owner');
    expect(patch?.body).toEqual({ role: 'member' });
    const alert = [...container.querySelectorAll('[role="alert"]')].map((node) => node.textContent);
    expect(alert.join(' ')).toContain('Someone else needs to be an active admin first');
    // Still shown as admin: the refusal didn't flip the toggle.
    expect(group?.querySelector('[aria-pressed="true"]')?.textContent).toBe('Admin');
  });

  it('marks the signed-in person and offers role and disable controls per person', async () => {
    stubFetch((_method, path) => {
      if (path === '/api/people') return { status: 200, body: { ok: true, people } };
      if (path === '/api/people/invites') return { status: 200, body: { ok: true, invites: [] } };
      return { status: 404, body: { ok: false, error: 'not_found' } };
    });
    await render(<PeopleTab meId="owner" />);
    expect(container.textContent).toContain('Gordon (you)');
    expect(container.querySelectorAll('.person-row')).toHaveLength(2);
    expect(container.textContent).toContain('Invite someone');
  });
});

describe('CatalogueSyncTab prices', () => {
  function stubPrices(): void {
    stubFetch((method, path) => {
      if (method === 'POST' && path === '/api/prices/refresh')
        return { status: 200, body: { ok: true, workflowId: 'wf_prices' } };
      if (path.startsWith('/api/prices/refresh/'))
        return { status: 200, body: { ok: true, status: 'running' } };
      return { status: 200, body: { ok: true, lastSyncedAt: null } };
    });
  }

  function buttonNamed(name: string): HTMLButtonElement {
    const button = [...document.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === name,
    );
    if (!button) throw new Error(`no "${name}" button`);
    return button;
  }

  it('refreshes in-use prices with no body from the main button', async () => {
    stubPrices();
    await render(<CatalogueSyncTab />);
    await step(() => buttonNamed('Refresh prices').click());
    await flush();
    const post = requests.find((request) => request.method === 'POST');
    expect(post?.path).toBe('/api/prices/refresh');
    expect(post?.body).toBeUndefined();
  });

  it('asks before refreshing every card, then posts everyCard and confirms with a toast', async () => {
    stubPrices();
    await render(<CatalogueSyncTab />);
    await step(() => buttonNamed('Refresh every card…').click());
    expect(requests.some((request) => request.method === 'POST')).toBe(false);
    expect(document.body.textContent).toContain('over about an hour');

    await step(() => buttonNamed('Refresh every card').click());
    await flush();
    const post = requests.find((request) => request.method === 'POST');
    expect(post?.path).toBe('/api/prices/refresh');
    expect(post?.body).toEqual({ everyCard: true });
    expect(document.body.textContent).toContain("Refreshing every card's price in the background.");
    // No progress polling for the whole-catalogue walk.
    expect(requests.some((request) => request.path.startsWith('/api/prices/refresh/'))).toBe(false);
  });
});
