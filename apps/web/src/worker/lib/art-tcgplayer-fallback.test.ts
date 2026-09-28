import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getArtResponse } from './art';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';

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
    put(key: string, value: Uint8Array, options?: { httpMetadata?: Record<string, unknown> }) {
      objects.set(key, { body: value, httpMetadata: options?.httpMetadata });
      return Promise.resolve(null);
    },
    get(key: string) {
      const stored = objects.get(key);
      if (!stored) return Promise.resolve(null);
      return Promise.resolve({
        key,
        size: stored.body.byteLength,
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
