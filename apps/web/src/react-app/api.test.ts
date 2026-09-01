import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './api';

const card = {
  id: 'card-1',
  name: 'Bulbasaur',
  language: 'en',
  category: 'pokemon',
  setId: 'sv8',
  setName: 'Stellar Crown',
  number: '001',
  imageLowUrl: '/api/art/card-1/low',
  imageHighUrl: '/api/art/card-1/high',
  collection: null,
  price: {
    amountAud: null,
    nativeAmount: null,
    nativeCurrency: null,
    source: null,
    sourceCapturedAt: null,
    fxDate: null,
  },
};
const version = {
  id: 'version-1',
  binderId: 'binder-1',
  versionNumber: 1,
  status: 'draft',
  layout: { kind: '3x3', rows: 3, columns: 3 },
  revision: 2,
  pageCount: 1,
};
const page = {
  id: 'page-1',
  position: 0,
  slots: [{ pageId: 'page-1', row: 0, column: 0, cardId: null }],
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
  vi.stubGlobal('navigator', {});
});

function bodyAt(index: number): unknown {
  const body = vi.mocked(fetch).mock.calls[index]?.[1]?.body;
  if (typeof body !== 'string') throw new Error(`Request ${index} did not contain a JSON body`);
  return JSON.parse(body);
}

describe('API client', () => {
  it('validates paginated catalogue responses with same-origin art', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ ok: true, total: 1, cards: [card], cursor: null })),
    );
    const result = await api.search(
      new URLSearchParams({ q: 'bulbasaur', limit: '50', offset: '0' }),
    );
    expect(result.cards[0]?.imageLowUrl).toBe('/api/art/card-1/low');
    expect(result.cards[0]?.imageHighUrl).toBe('/api/art/card-1/high');
    expect(fetch).toHaveBeenCalledWith(
      '/api/catalogue/search?q=bulbasaur&limit=50&offset=0',
      expect.objectContaining({ credentials: 'same-origin' }),
    );
  });

  it('sends revisioned collection set, increment, and notes requests', async () => {
    vi.mocked(fetch).mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            ok: true,
            state: {
              cardId: 'card-1',
              quantity: 2,
              notes: 'First page',
              revision: 3,
              updatedAt: '2026-08-24T00:00:00.000Z',
            },
            replayed: false,
          }),
        ),
      ),
    );
    const mutationId = 'b45a42d1-7332-4982-9eb3-b45f54fb8a5e';
    await api.setCollection('card-1', {
      mutationId,
      expectedRevision: 2,
      quantity: 2,
      notes: 'First page',
    });
    await api.incrementCollection('card-1', { mutationId, delta: 1 });
    await api.patchCollectionNotes('card-1', {
      mutationId,
      expectedRevision: 3,
      notes: 'First page',
    });
    const requests = vi.mocked(fetch).mock.calls;
    expect(bodyAt(0)).toMatchObject({
      mutationId,
      expectedRevision: 2,
      quantity: 2,
    });
    expect(requests[1]?.[0]).toBe('/api/collection/card-1/increment');
    expect(requests[1]?.[1]?.method).toBe('POST');
    expect(requests[2]?.[0]).toBe('/api/collection/card-1/notes');
    expect(requests[2]?.[1]?.method).toBe('PATCH');
  });

  it('uses paged binder reads and revisioned atomic swap', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ok: true, binder: { version, pages: [page], nextPage: null } }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            binder: { version: { ...version, revision: 3 }, pages: [page] },
          }),
        ),
      );
    await api.binder('version-1', 4, 1);
    await api.swapSlots('version-1', {
      expectedRevision: 2,
      source: { page: 4, row: 0, column: 0 },
      target: { page: 4, row: 0, column: 1 },
    });
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      '/api/binders/versions/version-1?page=4&limit=1',
    );
    expect(vi.mocked(fetch).mock.calls[1]?.[0]).toBe('/api/binders/versions/version-1/swap');
    expect(bodyAt(1)).toMatchObject({
      expectedRevision: 2,
      source: { page: 4 },
      target: { page: 4 },
    });
  });

  it('accepts additive binder response fields across a rolling deployment', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          responseGeneration: 2,
          binder: {
            responseGeneration: 2,
            version: { ...version, capacity: 9, responseGeneration: 2 },
            pages: [
              {
                ...page,
                kind: 'slots',
                responseGeneration: 2,
                slots: [
                  {
                    ...page.slots[0],
                    entryKind: 'empty',
                    responseGeneration: 2,
                  },
                ],
              },
            ],
          },
        }),
        { status: 201 },
      ),
    );

    await expect(
      api.createBinder('Regional collection', { kind: '3x3', rows: 3, columns: 3 }, 9),
    ).resolves.toMatchObject({ version: { id: 'version-1', capacity: 9 } });
    expect(bodyAt(0)).toEqual({
      name: 'Regional collection',
      layout: { kind: '3x3', rows: 3, columns: 3 },
      capacity: 9,
    });
  });

  it('reads planner summaries and previews a full-Pokedex insert', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            summary: {
              pageIds: ['page-1'],
              revision: 2,
              targets: 4,
              placed: 2,
              reservedSleeves: 1,
              reservedPages: 0,
              generatedPadding: 0,
              available: 4,
              capacity: 9,
              pageSize: 9,
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            preview: {
              currentCapacity: 9,
              requiredCapacity: 18,
              additionalPockets: 9,
              pageIncrement: 9,
              generatedPadding: 1,
            },
          }),
        ),
      );
    await expect(api.plannerSummary('version-1')).resolves.toMatchObject({ pageSize: 9 });
    await expect(
      api.previewFullPokedex('version-1', { page: 0, row: 0, column: 0 }, true, 2),
    ).resolves.toMatchObject({ requiredCapacity: 18 });
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      '/api/binders/versions/version-1/planner-summary',
    );
    expect(vi.mocked(fetch).mock.calls[1]?.[0]).toBe(
      '/api/binders/versions/version-1/full-pokedex/preview',
    );
    expect(vi.mocked(fetch).mock.calls[1]?.[1]?.method).toBe('POST');
    expect(bodyAt(1)).toEqual({
      at: { page: 0, row: 0, column: 0 },
      regionPageBreaks: true,
      expectedRevision: 2,
    });
  });

  it('preserves exact and Pokemon shortage planning details', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          shortages: [
            {
              cardId: 'card-1',
              required: 2,
              owned: 1,
              assigned: 1,
              available: 0,
              missing: 2,
            },
          ],
          pokemonShortages: [
            {
              pokemonNumber: 25,
              required: 2,
              owned: 1,
              assigned: 1,
              available: 0,
              missing: 2,
            },
          ],
          readyToPlace: { exactTargets: 3, pokemonTargets: 4 },
          nextOffset: 100,
        }),
      ),
    );

    await expect(api.binderShortages('version-1')).resolves.toEqual({
      ok: true,
      shortages: [
        {
          cardId: 'card-1',
          required: 2,
          owned: 1,
          assigned: 1,
          available: 0,
          missing: 2,
        },
      ],
      pokemonShortages: [
        {
          pokemonNumber: 25,
          required: 2,
          owned: 1,
          assigned: 1,
          available: 0,
          missing: 2,
        },
      ],
      readyToPlace: { exactTargets: 3, pokemonTargets: 4 },
      nextOffset: 100,
    });
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      '/api/binders/versions/version-1/shortages?offset=0&limit=100',
    );
  });

  it('preserves status, request ID, and retry timing on structured errors', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          error: 'rate_limited',
          requestId: 'request-123',
        }),
        { status: 429, headers: { 'retry-after': '30', 'x-request-id': 'request-123' } },
      ),
    );
    await expect(api.pair()).rejects.toMatchObject({
      code: 'rate_limited',
      status: 429,
      requestId: 'request-123',
      retryAfterSeconds: 30,
    });
  });

  it('preserves typed capacity details on structured errors', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          error: 'binder_capacity_exceeded',
          requestId: 'request-409',
          details: {
            currentCapacity: 9,
            requiredCapacity: 18,
            additionalPockets: 9,
            pageIncrement: 9,
          },
        }),
        { status: 409 },
      ),
    );
    await expect(api.pair()).rejects.toMatchObject({
      code: 'binder_capacity_exceeded',
      requestId: 'request-409',
      details: { requiredCapacity: 18 },
    });
  });

  it.each([
    ['not-json', 500, 'invalid_response'],
    [JSON.stringify({ ok: true, total: 'one', cards: [] }), 200, 'invalid_response'],
    [
      JSON.stringify({ ok: false, error: 'binder_version_not_draft' }),
      409,
      'binder_version_not_draft',
    ],
  ])('handles malformed and error response %s', async (body, status, code) => {
    vi.mocked(fetch).mockResolvedValue(new Response(body, { status }));
    const error = await api.search(new URLSearchParams()).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code });
  });

  it('rejects malformed passkey options before the browser library sees them', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ challenge: 42 })));
    await expect(api.authenticationOptions()).rejects.toMatchObject({ code: 'invalid_response' });
  });
});
