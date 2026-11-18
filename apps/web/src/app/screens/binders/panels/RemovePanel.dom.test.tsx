// @vitest-environment happy-dom
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { binderSlotSchema } from '@pokedex/shared';
import { renderWithProviders, flush } from '../test-harness';
import { RemovePanel } from './PocketPanels';
async function step(action: () => unknown) {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}
let root: Root | undefined;
afterEach(async () => {
  await step(() => root?.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
function button() {
  return [...document.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('keep target'),
  )!;
}
async function render(canRemoveCopy = true) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const onUnassign = vi.fn(),
    onCopyRemoved = vi.fn(),
    onLeaveGap = vi.fn();
  const slot = binderSlotSchema.parse({
    pageId: 'p',
    row: 0,
    column: 0,
    entryKind: 'pokemon',
    pokemonNumber: 7,
    cardId: null,
    label: null,
    assignedCardId: 'card',
  });
  const rendered = await renderWithProviders(container, () => (
    <RemovePanel
      slot={slot}
      slotId="p:0:0"
      target="Squirtle (any printing)"
      canRemoveCopy={canRemoveCopy}
      pending={false}
      error={null}
      onUnassign={onUnassign}
      onCopyRemoved={onCopyRemoved}
      onLeaveGap={onLeaveGap}
      onCloseGap={vi.fn()}
      onClose={vi.fn()}
    />
  ));
  root = rendered.root;
  await flush();
  return { onUnassign, onCopyRemoved, onLeaveGap };
}
it.each([
  [1440, 1000],
  [390, 844],
  [844, 390],
  [768, 1024],
  [1024, 768],
])('keeps target and collection by default at %ix%i', async (width, height) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
  const handlers = await render();
  const copy = document.querySelector<HTMLInputElement>('input[type=checkbox]');
  expect(copy?.checked).toBe(false);
  expect(document.body.textContent).toContain('Squirtle (any printing)');
  await step(() => button().click());
  expect(handlers.onUnassign).toHaveBeenCalledOnce();
  expect(handlers.onCopyRemoved).not.toHaveBeenCalled();
  expect(handlers.onLeaveGap).not.toHaveBeenCalled();
});
it('removes only the named pocket copy in one request when explicitly selected', async () => {
  const fetch = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>().mockResolvedValue(
    new Response(
      JSON.stringify({
        ok: true,
        state: {
          cardId: 'card',
          quantity: 0,
          notes: null,
          revision: 2,
          updatedAt: '2026-11-18T00:00:00.000Z',
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    ),
  );
  vi.stubGlobal('fetch', fetch);
  const handlers = await render();
  await step(() => document.querySelector<HTMLInputElement>('input[type=checkbox]')?.click());
  await step(() => button().click());
  await flush();
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0]?.[0]).toBe('/api/collection/card/remove');
  const body = fetch.mock.calls[0]?.[1]?.body;
  expect(JSON.parse(typeof body === 'string' ? body : '{}')).toEqual({
    source: 'pocket',
    slotId: 'p:0:0',
  });
  expect(handlers.onCopyRemoved).toHaveBeenCalledOnce();
  expect(handlers.onUnassign).not.toHaveBeenCalled();
  expect(handlers.onLeaveGap).not.toHaveBeenCalled();
});
it('keeps the panel open when removal fails and disables collection deletion for drafts', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: 'collection_remove_slot_not_found' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
  const handlers = await render();
  await step(() => document.querySelector<HTMLInputElement>('input[type=checkbox]')?.click());
  await step(() => button().click());
  await flush();
  expect(document.querySelector('[role=alert]')).not.toBeNull();
  expect(handlers.onCopyRemoved).not.toHaveBeenCalled();
});
it('disables owned-copy removal while editing a draft', async () => {
  await render(false);
  expect(document.querySelector<HTMLInputElement>('input[type=checkbox]')?.disabled).toBe(true);
});
