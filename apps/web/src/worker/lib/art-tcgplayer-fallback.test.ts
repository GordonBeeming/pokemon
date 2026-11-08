import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getArtResponse } from './art';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';
import { csvGroups } from './tcgcsv';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  vi.unstubAllGlobals();
});

function setup(): D1Database {
  const raw = new DatabaseSync(':memory:');
  databases.push(raw);
  applyAllMigrations(raw);
  raw.exec(`
    INSERT INTO users(id,label,created_at) VALUES('owner','Owner',1);
    INSERT INTO catalogue_cards(id,name,language,category,set_id,set_name,number,created_at,updated_at)
    VALUES('card','Card','en','pokemon','set','Set','1',1,1);
    INSERT INTO card_sources(provider,source_id,card_id,language,source_updated_at,checksum,active,imported_at)
    VALUES('tcgdex','set-1','card','en',1,'${'a'.repeat(64)}',1,1);
  `);
  return sqliteD1(raw);
}

function fakeR2() {
  const objects = new Map<string, { body: Uint8Array; httpMetadata?: Record<string, unknown> }>();
  return {
    put(
      key: string,
      value: Uint8Array | string,
      options?: { httpMetadata?: Record<string, unknown> },
    ) {
      objects.set(key, {
        body: typeof value === 'string' ? new TextEncoder().encode(value) : value,
        httpMetadata: options?.httpMetadata,
      });
      return Promise.resolve(null);
    },
    get(key: string) {
      const stored = objects.get(key);
      if (!stored) return Promise.resolve(null);
      return Promise.resolve({
        key,
        size: stored.body.byteLength,
        json() {
          return Promise.resolve(JSON.parse(new TextDecoder().decode(stored.body)));
        },
        httpMetadata: stored.httpMetadata,
        writeHttpMetadata(headers: Headers) {
          const contentType = stored.httpMetadata?.contentType;
          if (typeof contentType === 'string') headers.set('content-type', contentType);
        },
        httpEtag: '"etag"',
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(stored.body);
            controller.close();
          },
        }),
      });
    },
    objects,
  } as unknown as R2Bucket & { objects: Map<string, { body: Uint8Array }> };
}

const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const request = () => new Request('https://example.test/art');

describe('TCGplayer art fallback', () => {
  let db: D1Database;
  beforeEach(() => {
    db = setup();
  });

  it('keeps a primary provider outage from permanently caching fallback art', async () => {
    const network = vi.fn(() => Promise.resolve(new Response(null, { status: 503 })));
    vi.stubGlobal('fetch', network);
    const art = fakeR2();
    expect(await getArtResponse(db, art, 'owner', 'card', 'low', request())).toBeNull();
    expect(network).toHaveBeenCalledTimes(1);
    expect(art.objects.size).toBe(0);
  });

  it('uses a validated stale feed during a provider outage', async () => {
    const art = fakeR2();
    const data = {
      results: [{ groupId: 24451, name: 'ME: Mega Evolution Promo', abbreviation: 'MEP' }],
    };
    await art.put(
      'catalogue/tcgcsv-v1/groups.json',
      JSON.stringify({ fetchedAt: Math.floor(Date.now() / 1000) - 86400, data }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(null, { status: 503 }))),
    );
    expect(await csvGroups(art)).toEqual(data);
  });

  it('remembers a confirmed fallback miss briefly', async () => {
    await db
      .prepare(
        "UPDATE catalogue_cards SET name='Moltres',set_id='mep',set_name='MEP Black Star Promos',number='096' WHERE id='card'",
      )
      .run();
    const network = vi.fn((input: RequestInfo) => {
      const url = typeof input === 'string' ? input : input.url;
      return Promise.resolve(
        url.includes('api.tcgdex.net')
          ? new Response(null, { status: 404 })
          : Response.json({ results: [] }),
      );
    });
    vi.stubGlobal('fetch', network);
    const art = fakeR2();
    expect(await getArtResponse(db, art, 'owner', 'card', 'low', request())).toBeNull();
    const afterFirst = network.mock.calls.length;
    expect(await getArtResponse(db, art, 'owner', 'card', 'low', request())).toBeNull();
    // Only the primary lookup is retried; the alternate provider miss is cached.
    expect(network.mock.calls.length).toBe(afterFirst + 1);
  });

  it('finds exact promo artwork through TCGCSV even when the card is absent from TCGdex', async () => {
    await db
      .prepare(
        "UPDATE catalogue_cards SET name='Moltres', set_id='mep', set_name='MEP Black Star Promos', number='096' WHERE id='card'",
      )
      .run();
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo) => {
        const url = typeof input === 'string' ? input : input.url;
        if (url.includes('api.tcgdex.net'))
          return Promise.resolve(new Response(null, { status: 404 }));
        if (url.endsWith('/groups'))
          return Promise.resolve(
            Response.json({
              results: [{ groupId: 24451, name: 'ME: Mega Evolution Promo', abbreviation: 'MEP' }],
            }),
          );
        if (url.endsWith('/products'))
          return Promise.resolve(
            Response.json({
              results: [
                {
                  productId: 713264,
                  groupId: 24451,
                  categoryId: 3,
                  name: 'Moltres - 096 (30th Celebration)',
                  imageUrl: 'https://tcgplayer-cdn.tcgplayer.com/product/713264_200w.jpg',
                  extendedData: [
                    { name: 'Number', value: '096' },
                    { name: 'Card Type', value: 'Fire' },
                  ],
                },
              ],
            }),
          );
        if (url === 'https://tcgplayer-cdn.tcgplayer.com/product/713264_in_1000x1000.jpg')
          return Promise.resolve(new Response(jpegBytes));
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    const art = fakeR2();
    const response = await getArtResponse(db, art, 'owner', 'card', 'low', request());
    expect(response?.status).toBe(200);
    const calls = vi.mocked(fetch).mock.calls.length;
    expect((await getArtResponse(db, art, 'owner', 'card', 'low', request()))?.status).toBe(200);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(calls);
  });

  it("does not fetch fallback images for another user's private card", async () => {
    await db.prepare("INSERT INTO users(id,label,created_at) VALUES('kid','Kid',1)").run();
    await db.prepare("UPDATE catalogue_cards SET owner_id='kid',is_custom=1 WHERE id='card'").run();
    const network = vi.fn();
    vi.stubGlobal('fetch', network);
    expect(await getArtResponse(db, fakeR2(), 'owner', 'card', 'low', request())).toBeNull();
    expect(network).not.toHaveBeenCalled();
  });

  it('caches the TCGplayer product image when TCGdex has no image for the card', async () => {
    const art = fakeR2();
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo) => {
        const url = typeof input === 'string' ? input : input.url;
        if (url.includes('api.tcgdex.net')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                id: 'set-1',
                // No `image` field and no gallery match, so tcgdexArtImageBase
                // returns null and the TCGplayer fallback is exercised.
                variants_detailed: [{ thirdParty: { tcgplayer: 219333 } }],
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          );
        }
        if (url.includes('tcgplayer-cdn.tcgplayer.com')) {
          return Promise.resolve(
            new Response(jpegBytes, {
              status: 200,
              headers: { 'content-length': String(jpegBytes.byteLength) },
            }),
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    const response = await getArtResponse(db, art, 'owner', 'card', 'low', request());
    expect(response?.status).toBe(200);
    expect(response?.headers.get('content-type')).toBe('image/jpeg');
    const manifest = await db
      .prepare('SELECT object_key FROM art_manifest WHERE card_id = ?1 AND variant = ?2')
      .bind('card', 'low')
      .first<{ object_key: string }>();
    expect(manifest?.object_key).toMatch(/\.jpg$/u);
  });

  it('returns nothing when TCGdex has no image and no TCGplayer link either', async () => {
    const art = fakeR2();
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ id: 'set-1' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      ),
    );
    const response = await getArtResponse(db, art, 'owner', 'card', 'low', request());
    expect(response).toBeNull();
  });

  it('returns nothing when every provider fails, including the TCGplayer fetch itself', async () => {
    const art = fakeR2();
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo) => {
        const url = typeof input === 'string' ? input : input.url;
        if (url.includes('api.tcgdex.net')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                id: 'set-1',
                variants_detailed: [{ thirdParty: { tcgplayer: 1 } }],
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          );
        }
        return Promise.resolve(new Response(null, { status: 404 }));
      }),
    );
    const response = await getArtResponse(db, art, 'owner', 'card', 'low', request());
    expect(response).toBeNull();
  });
});
