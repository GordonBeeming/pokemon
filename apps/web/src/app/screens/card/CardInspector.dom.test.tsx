// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../ui/Toast';
import { CardInspector } from './CardInspector';

let container: HTMLDivElement, root: Root, queryClient: QueryClient;
let incrementCalls: unknown[];

const ZERO_COPY_CARD = {
  ok: true,
  card: {
    id: 'card-1',
    name: 'Pikachu',
    language: 'en',
    category: 'pokemon',
    setId: '151',
    setName: '151',
    number: '025',
    imageLowUrl: null,
    supertype: null,
    subtype: null,
    species: 'Pikachu',
    rarity: 'Common',
    artist: null,
    imageHighUrl: null,
    source: { provider: 'tcgdex', sourceId: 'swsh-1', updatedAt: '2026-01-01T00:00:00.000Z' },
    notes: null,
    pokedexNumber: 25,
    collection: null,
    price: {
      amountAud: null,
      nativeAmount: null,
      nativeCurrency: null,
      source: null,
      sourceCapturedAt: null,
      fxDate: null,
    },
    frameType: 'lightning',
    setCode: 'MEW',
    rarityKey: 'C',
  },
};

function stubFetch(): void {
  incrementCalls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      if (input.startsWith('/api/catalogue/card-1'))
        return Promise.resolve(jsonResponse(ZERO_COPY_CARD));
      if (input === '/api/cards/card-1/binder-matches')
        return Promise.resolve(jsonResponse({ ok: true, binders: [] }));
      if (input === '/api/collection/card-1/increment') {
        incrementCalls.push(
          typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
        );
        return Promise.resolve(
          jsonResponse({
            ok: true,
            state: {
              cardId: 'card-1',
              quantity: 1,
              notes: null,
              revision: 1,
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
            replayed: false,
          }),
        );
      }
      throw new Error(`unexpected fetch: ${input}`);
    }),
  );
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  stubFetch();
});
afterEach(async () => {
  await step(() => root.unmount());
  container.remove();
  queryClient.clear();
  vi.unstubAllGlobals();
});

describe('CardInspector — 0 copies', () => {
  it('shows "Add first copy" instead of a quantity counter, and never fades the art', async () => {
    await step(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <CardInspector cardId="card-1" onClose={vi.fn()} />
          </ToastProvider>
        </QueryClientProvider>,
      ),
    );
    await flushUntil(() => container.textContent?.includes('Pikachu') === true);

    expect(container.textContent).toContain('Not owned');
    expect(container.querySelector('output')).toBeNull();
    const addFirst = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Add first copy'),
    );
    expect(addFirst).toBeDefined();

    // forceSolid: the frame renders as if owned (solid background, full-opacity
    // art) even at 0 copies — ownership is stated in words, not by fading the art.
    const img = container.querySelector<HTMLImageElement>('.card-frame-art');
    expect(img?.style.opacity).toBe('1');

    await step(() => addFirst?.click());
    await flushUntil(() => incrementCalls.length > 0);
    const [call] = incrementCalls as Array<{ mutationId: unknown; delta: number }>;
    expect(typeof call?.mutationId).toBe('string');
    expect(call?.delta).toBe(1);
  });
});

async function step(action: () => unknown): Promise<void> {
  await act(async () => {
    await action();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function flushUntil(predicate: () => boolean, attempts = 50): Promise<void> {
  for (let i = 0; i < attempts && !predicate(); i++) {
    await step(() => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  if (!predicate()) throw new Error('flushUntil: condition never became true');
}
