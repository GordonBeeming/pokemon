import { describe, expect, it } from 'vitest';
import { cardIdSchema } from '@pokedex/shared';
import { apiRoutes, parseDesktopBearer } from './index';
import { binderSuggestionEmptySlots, loadAllBinderPages, loadAllBinderShortages } from './desktop';

const token = 'a'.repeat(64);

describe('desktop bearer parsing', () => {
  it('loads every binder page for MCP suggestions', async () => {
    const offsets: number[] = [];
    const pages = await loadAllBinderPages((offset) => {
      offsets.push(offset);
      return Promise.resolve({
        version: {
          id: 'version-1',
          binderId: 'binder-1',
          versionNumber: 1,
          status: 'draft' as const,
          layout: { kind: '2x2' as const, rows: 2 as const, columns: 2 as const },
          revision: 1,
          pageCount: 5,
        },
        pages: Array.from({ length: offset === 0 ? 4 : 1 }, (_value, index) => ({
          id: `page-${offset + index}`,
          position: offset + index,
          slots: [],
        })),
        nextPage: offset === 0 ? 4 : null,
      });
    });

    expect(offsets).toEqual([0, 4]);
    expect(pages.map((page) => page.position)).toEqual([0, 1, 2, 3, 4]);
  });

  it('loads every binder shortage page for MCP suggestions', async () => {
    const offsets: number[] = [];
    const shortages = await loadAllBinderShortages((offset) => {
      offsets.push(offset);
      const count = offset === 0 ? 100 : 1;
      return Promise.resolve({
        shortages: Array.from({ length: count }, (_value, index) => ({
          cardId: cardIdSchema.parse(`card-${offset + index}`),
          required: 2,
          owned: 1,
          missing: 1,
        })),
        pokemonShortages: [
          {
            pokemonNumber: offset === 0 ? 1 : 2,
            required: 2,
            owned: 1,
            assigned: 1,
            available: 0,
            missing: 2,
          },
        ],
        readyToPlace: { exactTargets: 3, pokemonTargets: 4 },
        nextOffset: offset === 0 ? 100 : null,
      });
    });

    expect(offsets).toEqual([0, 100]);
    expect(shortages.shortages).toHaveLength(101);
    expect(shortages.pokemonShortages.map((item) => item.pokemonNumber)).toEqual([1, 2]);
    expect(shortages.readyToPlace).toEqual({ exactTargets: 3, pokemonTargets: 4 });
  });

  it('only suggests real empty pockets and excludes reserved pages', () => {
    const slot = (column: number, entryKind: 'empty' | 'reserved' | 'exact-card' | 'pokemon') => ({
      pageId: 'page-1',
      row: 0,
      column,
      cardId: entryKind === 'exact-card' ? cardIdSchema.parse('card-1') : null,
      entryKind,
    });
    const suggestions = binderSuggestionEmptySlots([
      {
        id: 'page-1',
        position: 0,
        kind: 'slots',
        slots: [slot(0, 'empty'), slot(1, 'reserved'), slot(2, 'exact-card'), slot(3, 'pokemon')],
      },
      {
        id: 'page-2',
        position: 1,
        kind: 'reserved',
        slots: [{ ...slot(0, 'empty'), pageId: 'page-2' }],
      },
    ]);

    expect(suggestions.map(({ page, column, entryKind }) => ({ page, column, entryKind }))).toEqual(
      [{ page: 0, column: 0, entryKind: 'empty' }],
    );
  });

  it('accepts an exact paired bearer token', () => {
    expect(parseDesktopBearer(`Bearer ${token}`)).toBe(token);
  });

  it('rejects missing, malformed, raw, and alternate authorization schemes', () => {
    expect(parseDesktopBearer(undefined)).toBeNull();
    expect(parseDesktopBearer(token)).toBeNull();
    expect(parseDesktopBearer(`Basic ${token}`)).toBeNull();
    expect(parseDesktopBearer(`Bearer  ${token}`)).toBeNull();
    expect(parseDesktopBearer(`Bearer ${token.slice(0, -1)}`)).toBeNull();
  });

  it('enforces bearer and browser-session policy structurally', async () => {
    const env = {} as CloudflareEnv;
    const catalogue = await apiRoutes.request('/desktop/catalogue/search', undefined, env);
    expect(catalogue.status).toBe(401);
    await expect(catalogue.json()).resolves.toMatchObject({ error: 'desktop_token_invalid' });

    const tokenManagement = await apiRoutes.request('/desktop/tokens', undefined, env);
    expect(tokenManagement.status).toBe(401);
    await expect(tokenManagement.json()).resolves.toMatchObject({ error: 'unauthorized' });

    const unknown = await apiRoutes.request(
      '/desktop/unknown',
      { headers: { authorization: `Bearer ${token}` } },
      env,
    );
    expect(unknown.status).toBe(404);
  });

  it('returns a strict 429 with Retry-After before pair redemption work', async () => {
    const env = Object.assign({} as CloudflareEnv, {
      AUTH_COORDINATOR: {
        getByName: () => ({
          rateLimit: () => Promise.resolve({ allowed: false, remaining: 0, retryAfter: 42 }),
        }),
      },
    });
    const response = await apiRoutes.request(
      '/desktop/pair/redeem',
      { method: 'POST', body: JSON.stringify({ code: 'A'.repeat(24), label: 'Scanner' }) },
      env,
    );
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('42');
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: 'rate_limited' });
  });

  it('never accepts an art upload credential from the URL path', async () => {
    const response = await apiRoutes.request(`/desktop/art/uploads/${token}`, { method: 'PUT' });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: 'art_upload_token_invalid' });
  });
});
