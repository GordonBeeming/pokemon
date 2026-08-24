import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

const card = {
  id: 'card-1',
  name: 'Bulbasaur',
  language: 'en',
  category: 'pokemon',
  setId: 'sv8',
  setName: 'Stellar Crown',
  number: '001',
  imageLowUrl: null,
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
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});
describe('API client', () => {
  it('posts binder activation', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          binder: {
            id: 'version-1',
            binderId: 'binder-1',
            versionNumber: 1,
            status: 'active',
            layout: { kind: '3x3', rows: 3, columns: 3 },
            slots: [],
            shortages: [],
          },
        }),
      ),
    );
    await api.activateBinder('version-1');
    expect(fetch).toHaveBeenCalledWith(
      '/api/binders/versions/version-1/activate',
      expect.objectContaining({ method: 'POST' }),
    );
  });
  it('accepts a draft binder latest version', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          binders: [
            {
              id: 'binder-1',
              name: 'Illustration binder',
              activeVersionId: null,
              latestVersionId: 'version-1',
              updatedAt: '2026-08-24T00:00:00.000Z',
            },
          ],
        }),
      ),
    );
    await expect(api.binders()).resolves.toMatchObject([{ latestVersionId: 'version-1' }]);
  });
  it('uses POST for passkey authentication options', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          challenge: 'test',
          rpId: 'localhost',
          timeout: 60000,
          userVerification: 'preferred',
          allowCredentials: [],
        }),
      ),
    );
    await api.authenticationOptions();
    expect(fetch).toHaveBeenCalledWith(
      '/api/auth/passkey/auth/options',
      expect.objectContaining({ method: 'POST' }),
    );
  });
  it('surfaces rejected binder mutations as API errors', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: 'binder_version_not_draft' }), {
        status: 409,
      }),
    );
    await expect(api.addPage('binder-version')).rejects.toMatchObject({
      code: 'binder_version_not_draft',
    });
  });
  it('uses paginated catalogue search', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ ok: true, total: 1, cards: [card] })),
    );
    const result = await api.search(
      new URLSearchParams({ q: 'bulbasaur', limit: '50', offset: '0' }),
    );
    expect(result.cards).toHaveLength(1);
    expect(fetch).toHaveBeenCalledWith(
      '/api/catalogue/search?q=bulbasaur&limit=50&offset=0',
      expect.objectContaining({ credentials: 'same-origin' }),
    );
  });
  it('sends mutation IDs for collection writes', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          state: {
            cardId: 'card-1',
            quantity: 2,
            notes: 'First page',
            updatedAt: '2026-08-24T00:00:00.000Z',
          },
        }),
      ),
    );
    await api.setCollection('card-1', 2, 'First page', 'b45a42d1-7332-4982-9eb3-b45f54fb8a5e');
    const request = vi.mocked(fetch).mock.calls[0];
    const body = request?.[1]?.body;
    if (typeof body !== 'string') throw new Error('Expected a JSON request body');
    expect(JSON.parse(body)).toMatchObject({
      quantity: 2,
      mutationId: 'b45a42d1-7332-4982-9eb3-b45f54fb8a5e',
    });
  });
});
