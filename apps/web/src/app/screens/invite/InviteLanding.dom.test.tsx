// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InviteLanding } from './InviteLanding';

async function step(action: () => unknown): Promise<void> {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}

let container: HTMLDivElement;
let root: Root;
const token = 'a'.repeat(64);

function stubInvite(body: Record<string, unknown>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true, ...body }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ),
  );
}

async function render(): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await step(() =>
    root.render(
      <QueryClientProvider client={client}>
        <InviteLanding token={token} onJoined={vi.fn()} />
      </QueryClientProvider>,
    ),
  );
  for (let i = 0; i < 40 && container.textContent?.includes('Checking your invite'); i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await step(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('InviteLanding', () => {
  it('shows who invited and the label for a valid link, with a device-name form', async () => {
    stubInvite({
      valid: true,
      expired: false,
      used: false,
      label: 'Sam',
      role: 'member',
      expiresAt: '2026-10-05T00:00:00.000Z',
      invitedBy: 'Gordon Beeming',
    });
    await render();
    expect(container.textContent).toContain('Gordon Beeming invited you as Sam.');
    expect(container.querySelector('input')).not.toBeNull();
    expect(container.textContent).toContain('Create my passkey');
  });

  it('asks for a new link when the invite was used or cancelled', async () => {
    stubInvite({
      valid: false,
      expired: false,
      used: true,
      label: null,
      role: null,
      expiresAt: null,
      invitedBy: null,
    });
    await render();
    expect(container.textContent).toContain('This invite link no longer works');
    expect(container.textContent).toContain('already been used or was cancelled');
    expect(container.querySelector('input')).toBeNull();
  });
});
