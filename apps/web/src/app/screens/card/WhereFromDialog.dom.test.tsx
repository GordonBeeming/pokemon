// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WhereFromDialog, type WhereFromDialogProps } from './WhereFromDialog';

let container: HTMLDivElement, root: Root, queryClient: QueryClient;

interface RecordedCall {
  body: unknown;
}
let calls: RecordedCall[];

interface RequestBody {
  source: string;
  slotId?: string;
}

function parseBody(init: RequestInit | undefined): RequestBody {
  if (typeof init?.body !== 'string') return { source: '' };
  return JSON.parse(init.body) as RequestBody;
}

function stubFetch(responder: (body: RequestBody) => { status: number; json: unknown }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((_input: string, init?: RequestInit) => {
      const body = parseBody(init);
      calls.push({ body });
      const { status, json } = responder(body);
      return Promise.resolve(
        new Response(JSON.stringify(json), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
}

function renderDialog(props: Partial<WhereFromDialogProps> = {}): Promise<void> {
  const defaults: WhereFromDialogProps = {
    open: true,
    onClose: vi.fn(),
    cardId: 'card-1',
    cardName: 'Pikachu',
    placedIn: [
      { binderId: 'b1', binderName: 'National Pokedex', slotId: 'p1:0:0', page: 0, row: 0, col: 0 },
    ],
    looseCopies: 1,
    onRemoved: vi.fn(),
  };
  return step(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <WhereFromDialog {...defaults} {...props} />
      </QueryClientProvider>,
    ),
  );
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  calls = [];
});
afterEach(async () => {
  await step(() => root.unmount());
  container.remove();
  queryClient.clear();
  vi.unstubAllGlobals();
});

describe('WhereFromDialog', () => {
  it('offers a pocket option per placement, disables loose at zero, and posts source:"pocket" with its slotId', async () => {
    stubFetch(() => ({
      status: 200,
      json: {
        ok: true,
        state: {
          cardId: 'card-1',
          quantity: 1,
          notes: null,
          revision: 2,
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    }));
    const onRemoved = vi.fn();
    await renderDialog({ looseCopies: 0, onRemoved });

    const pocketRadio = container.querySelector<HTMLInputElement>('input[name="remove-source"]');
    const looseRadio = container.querySelectorAll<HTMLInputElement>(
      'input[name="remove-source"]',
    )[1];
    expect(pocketRadio).not.toBeNull();
    expect(looseRadio?.disabled).toBe(true);

    await step(() => pocketRadio?.click());
    const confirmButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Remove 1 copy',
    );
    await step(() => confirmButton?.click());

    expect(calls).toEqual([{ body: { source: 'pocket', slotId: 'p1:0:0' } }]);
    expect(onRemoved).toHaveBeenCalledTimes(1);
  });

  it('posts source:"loose" when the loose option is chosen and loose copies exist', async () => {
    stubFetch(() => ({
      status: 200,
      json: {
        ok: true,
        state: {
          cardId: 'card-1',
          quantity: 1,
          notes: null,
          revision: 2,
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    }));
    await renderDialog({ looseCopies: 2 });

    const looseRadio = container.querySelectorAll<HTMLInputElement>(
      'input[name="remove-source"]',
    )[1];
    expect(looseRadio?.disabled).toBe(false);
    await step(() => looseRadio?.click());
    const confirmButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Remove 1 copy',
    );
    await step(() => confirmButton?.click());

    expect(calls).toEqual([{ body: { source: 'loose' } }]);
  });

  it('posts source:"miscount" with no slotId first, and falls back to a slot picker on collection_remove_slot_required', async () => {
    stubFetch((body) => {
      if (body.source === 'miscount' && !body.slotId) {
        return {
          status: 409,
          json: {
            ok: false,
            error: 'collection_remove_slot_required',
            details: {
              candidates: [
                {
                  slotId: 'p2:1:1',
                  binderId: 'b1',
                  binderName: 'National Pokedex',
                  page: 1,
                  row: 1,
                  column: 1,
                },
              ],
            },
          },
        };
      }
      return {
        status: 200,
        json: {
          ok: true,
          state: {
            cardId: 'card-1',
            quantity: 0,
            notes: null,
            revision: 3,
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      };
    });
    const onRemoved = vi.fn();
    await renderDialog({ placedIn: [], looseCopies: 0, onRemoved });

    const miscountRadio = container.querySelectorAll<HTMLInputElement>(
      'input[name="remove-source"]',
    )[1];
    await step(() => miscountRadio?.click());
    const confirmButton = () =>
      Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Remove 1 copy',
      );
    await step(() => confirmButton()?.click());

    // The server pushed back with candidates — the dialog now shows a slot picker
    // instead of closing or erroring.
    expect(container.querySelector('[aria-label="Which pocket to empty"]')).not.toBeNull();
    expect(onRemoved).not.toHaveBeenCalled();

    const slotRadio = container.querySelector<HTMLInputElement>('input[name="miscount-slot"]');
    await step(() => slotRadio?.click());
    await step(() => confirmButton()?.click());

    expect(calls.at(-1)).toEqual({ body: { source: 'miscount', slotId: 'p2:1:1' } });
    expect(onRemoved).toHaveBeenCalledTimes(1);
  });
});

async function step(action: () => unknown): Promise<void> {
  await act(async () => {
    await action();
    await Promise.resolve();
  });
}
