// @vitest-environment happy-dom
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import {
  DEFAULT_FRAME_PALETTE,
  wantedMutationSchema,
  binderSlotSchema,
  catalogueCardViewSchema,
} from '@pokedex/shared';
import { renderWithProviders, flush } from '../test-harness';
import { FindCardsPanel } from './FindCardsPanel';
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
const card = catalogueCardViewSchema.parse({
  id: 'card',
  name: 'Squirtle',
  language: 'en',
  category: 'pokemon',
  setId: 'base',
  setName: 'Base',
  number: '63',
  pokedexNumber: 7,
  frameType: 'water',
  rarityKey: 'C',
  setCode: 'BS',
  imageLowUrl: null,
  imageHighUrl: null,
  collection: null,
  price: {
    amountAud: null,
    nativeAmount: null,
    nativeCurrency: null,
    source: null,
    sourceCapturedAt: null,
    fxDate: null,
  },
});
const slot = binderSlotSchema.parse({
  pageId: 'p',
  row: 0,
  column: 0,
  entryKind: 'exact-card',
  pokemonNumber: null,
  cardId: 'card',
  label: null,
  assignedCardId: null,
});
async function setup(fail = false) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const scopes = new Set<string>(),
    requests: Array<{ path: string; method: string; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      await Promise.resolve();
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      requests.push({ path, method: init?.method ?? 'GET', body });
      if (init?.method === 'PUT') {
        const input = wantedMutationSchema.parse(body);
        if (fail)
          return new Response(JSON.stringify({ ok: false, error: 'internal_error' }), {
            status: 500,
          });
        if (input.wanted) scopes.add(input.binderId ?? 'general');
        else scopes.delete(input.binderId ?? 'general');
      }
      return new Response(
        JSON.stringify({
          ok: true,
          scopes: [...scopes].map((scope) => ({
            scope,
            binderName: scope === 'general' ? null : 'Binder',
            createdAt: 1,
          })),
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    }),
  );
  const onAssign = vi.fn(),
    onAddAndPlace = vi.fn();
  const result = await renderWithProviders(container, () => (
    <FindCardsPanel
      slot={slot}
      title="Squirtle"
      reservedPage={false}
      editable
      palette={DEFAULT_FRAME_PALETTE}
      binderId="binder"
      slotId="p:0:0"
      spares={[]}
      sparesLoading={false}
      sparesError={null}
      exactCard={card}
      addBlockedReason={null}
      pending={false}
      error={null}
      onAssign={onAssign}
      onAddAndPlace={onAddAndPlace}
      onUnassign={vi.fn()}
      onPageBreak={vi.fn()}
      onClose={vi.fn()}
    />
  ));
  root = result.root;
  await flush();
  await step(() =>
    [...document.querySelectorAll<HTMLElement>('.segmented-control-option')]
      .find((e) => e.textContent === 'Wishlist')
      ?.click(),
  );
  await flush();
  return { requests, onAssign, onAddAndPlace };
}
function tile() {
  return document.querySelector<HTMLButtonElement>('.find-wanted-tile button')!;
}
it.each([
  [1440, 1000],
  [390, 844],
  [844, 390],
  [768, 1024],
  [1024, 768],
])(
  'marks binder or General wants without placing or adding copies at %ix%i',
  async (width, height) => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
    const { requests, onAssign, onAddAndPlace } = await setup();
    expect(tile().getAttribute('aria-pressed')).toBe('false');
    await step(() => tile().click());
    await flush();
    expect(tile().getAttribute('aria-pressed')).toBe('true');
    expect(requests.filter((r) => r.method === 'PUT').at(-1)?.body).toEqual({
      cardId: 'card',
      binderId: 'binder',
      wanted: true,
    });
    const select = document.querySelector('select')!;
    await step(() => {
      select.value = 'general';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(tile().getAttribute('aria-pressed')).toBe('false');
    await step(() => tile().click());
    await flush();
    expect(requests.filter((r) => r.method === 'PUT').at(-1)?.body).toEqual({
      cardId: 'card',
      binderId: null,
      wanted: true,
    });
    await step(() => tile().click());
    await flush();
    expect(requests.filter((r) => r.method === 'PUT').at(-1)?.body).toEqual({
      cardId: 'card',
      binderId: null,
      wanted: false,
    });
    expect(onAssign).not.toHaveBeenCalled();
    expect(onAddAndPlace).not.toHaveBeenCalled();
    expect(requests.every((r) => r.path.startsWith('/api/wanted'))).toBe(true);
  },
);
it('keeps the wishlist unmarked and reports a failed save', async () => {
  const { onAssign, onAddAndPlace } = await setup(true);
  await step(() => tile().click());
  await flush();
  expect(document.querySelector('[role=alert]')).not.toBeNull();
  expect(tile().getAttribute('aria-pressed')).toBe('false');
  expect(onAssign).not.toHaveBeenCalled();
  expect(onAddAndPlace).not.toHaveBeenCalled();
});
