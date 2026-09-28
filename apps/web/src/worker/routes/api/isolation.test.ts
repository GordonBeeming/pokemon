// The heart of ws-users: proves a second user (B) can never read or change
// the first user's (A's) data through any id-taking route, and that a
// guessed id 404s rather than 403ing (so an attacker can't even confirm the
// id exists). Two real, pre-existing cross-owner gaps were found while
// writing this file (see reports/ws-users.md) and messaged to ws-data-2, who
// owns the files that needed the fix; both are now fixed and covered below
// as plain `it` cases.
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSession, getPasskeys, SESSION_COOKIE } from '../../lib/auth';
import { restoreBackup } from '../../lib/backup';
import { applyAllMigrations, sqliteD1 } from '../../lib/d1-test-helper';
import { encodeSlotId } from '../../lib/db';
import { ApplicationError } from '../../lib/log';
import { patchPerson } from '../../lib/people';
import { apiRoutes } from './index';
import { passkeyRoutes } from '../auth/passkey';

const database = new DatabaseSync(':memory:');
afterAll(() => database.close());
const db = sqliteD1(database);

const SESSION_SECRET = 'isolation-test-session-secret-thirty-two-bytes';
const env = { DB: db, SESSION_SECRET, SESSION_SECRET_PREV: '' } as unknown as CloudflareEnv;

const VERSION_A = 'version-a';
const BINDER_A = 'binder-a';
const PAGE_A = 'page-a';
const BOOKMARK_A = 'bookmark-a';
const CARD_1 = 'card-1';
const CUSTOM_A = 'custom-a';
const DESKTOP_TOKEN_A = 'a'.repeat(64);
const DESKTOP_TOKEN_B = 'b'.repeat(64);
const PASSKEY_A = 'passkey-a';

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

let userA: string;
let userB: string;
let desktopTokenAId: string;
let cookieA: string;
let cookieB: string;

beforeAll(async () => {
  applyAllMigrations(database);
  database.exec(`
    INSERT INTO users (id, label, role, created_at) VALUES
      ('user-a', 'A', 'admin', 1), ('user-b', 'B', 'member', 1);
    INSERT INTO catalogue_cards
      (id, name, language, category, set_id, set_name, number, created_at, updated_at)
    VALUES ('${CARD_1}', 'Card', 'en', 'pokemon', 'set-1', 'Set', '1', 1, 1);
    INSERT INTO catalogue_cards
      (id, name, language, category, set_id, set_name, number, is_custom, owner_id, created_at, updated_at)
    VALUES ('${CUSTOM_A}', 'A''s Custom Card', 'en', 'special', 'custom', 'Custom', '1', 1, 'user-a', 1, 1);
    INSERT INTO collection_cards (owner_id, card_id, quantity, revision, updated_at)
    VALUES ('user-a', '${CARD_1}', 2, 1, 1), ('user-b', '${CARD_1}', 1, 1, 1);
    INSERT INTO binders (id, owner_id, name, created_at, updated_at)
    VALUES ('${BINDER_A}', 'user-a', 'A Binder', 1, 1);
    INSERT INTO binder_versions
      (id, binder_id, version_number, status, layout_kind, rows, columns, capacity, created_at, revision)
    VALUES ('${VERSION_A}', '${BINDER_A}', 1, 'active', '2x2', 2, 2, 4, 1, 1);
    UPDATE binders SET active_version_id = '${VERSION_A}' WHERE id = '${BINDER_A}';
    INSERT INTO binder_pages (id, binder_version_id, position) VALUES ('${PAGE_A}', '${VERSION_A}', 0);
    INSERT INTO binder_slots (binder_page_id, row_index, column_index, card_id, assigned_card_id, entry_kind)
    VALUES
      ('${PAGE_A}', 0, 0, '${CARD_1}', '${CARD_1}', 'exact-card'),
      ('${PAGE_A}', 0, 1, NULL, NULL, 'empty'),
      ('${PAGE_A}', 1, 0, NULL, NULL, 'empty'),
      ('${PAGE_A}', 1, 1, NULL, NULL, 'empty');
    INSERT INTO binder_bookmarks (id, binder_page_id, row_index, column_index, name, created_at)
    VALUES ('${BOOKMARK_A}', '${PAGE_A}', 0, 0, 'Starter', 1);
    INSERT INTO backup_runs (id, object_key, checksum, owner_id, backup_epoch, created_at)
    VALUES ('backup-a', 'backups/user-a/backup-a/manifest.json', '${'c'.repeat(64)}', 'user-a', 1, 1);
  `);
  database.exec(
    `INSERT INTO passkeys (id, user_id, public_key, counter, created_at) VALUES ('${PASSKEY_A}', 'user-a', x'00', 0, 1);`,
  );
  const tokenAHash = await sha256Hex(DESKTOP_TOKEN_A);
  const tokenBHash = await sha256Hex(DESKTOP_TOKEN_B);
  database.exec(
    `INSERT INTO desktop_tokens (token_hash, owner_id, label, scopes, created_at) VALUES
      ('${tokenAHash}', 'user-a', 'A desktop', '["catalogue:read","collection:write","binders:write","art:write"]', 1),
      ('${tokenBHash}', 'user-b', 'B desktop', '["catalogue:read","collection:write","binders:write","art:write"]', 1);`,
  );
  userA = 'user-a';
  userB = 'user-b';
  const tokenRow = await db
    .prepare('SELECT token_hash FROM desktop_tokens WHERE owner_id = ?1')
    .bind('user-a')
    .first<{ token_hash: string }>();
  if (!tokenRow) throw new Error('test setup invariant broken');
  desktopTokenAId = tokenRow.token_hash;
  cookieA = `${SESSION_COOKIE}=${await createSession(db, { sub: userA, label: 'A' }, env)}`;
  cookieB = `${SESSION_COOKIE}=${await createSession(db, { sub: userB, label: 'B' }, env)}`;
});

function browserInit(cookie: string, method: string, body?: unknown): RequestInit {
  const headers = new Headers({ cookie });
  if (body !== undefined) headers.set('content-type', 'application/json');
  return { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined };
}

function desktopInit(token: string, method: string, body?: unknown): RequestInit {
  const headers = new Headers({ authorization: `Bearer ${token}` });
  if (body !== undefined) headers.set('content-type', 'application/json');
  return { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined };
}

interface RouteCase {
  name: string;
  method: string;
  browserPath: string;
  desktopPath?: string;
  body?: unknown;
}

// Every one of these is scoped by (ownerId, versionId) or (ownerId, binderId)
// at the very first query the underlying lib function makes (readVersion /
// an equivalent owner_id-joined lookup), before any other field in the body
// is used — so a syntactically valid body reaches that check regardless of
// whether the rest of it would make sense for a *real* mutation.
const routeCases: RouteCase[] = [
  {
    name: 'get version',
    method: 'GET',
    browserPath: `/binders/versions/${VERSION_A}`,
    desktopPath: `/desktop/binders/versions/${VERSION_A}`,
  },
  {
    name: 'shortages',
    method: 'GET',
    browserPath: `/binders/versions/${VERSION_A}/shortages`,
    desktopPath: `/desktop/binders/versions/${VERSION_A}/shortages`,
  },
  {
    name: 'planner summary',
    method: 'GET',
    browserPath: `/binders/versions/${VERSION_A}/planner-summary`,
    desktopPath: `/desktop/binders/versions/${VERSION_A}/planner-summary`,
  },
  {
    name: 'assignment candidates',
    method: 'GET',
    browserPath: `/binders/versions/${VERSION_A}/assignment-candidates?page=0&row=0&column=0`,
    desktopPath: `/desktop/binders/versions/${VERSION_A}/assignment-candidates?page=0&row=0&column=0`,
  },
  {
    name: 'set slot',
    method: 'PUT',
    browserPath: `/binders/versions/${VERSION_A}/slot`,
    desktopPath: `/desktop/binders/versions/${VERSION_A}/slot`,
    body: { page: 0, row: 0, column: 0, cardId: null, expectedRevision: 1 },
  },
  {
    name: 'swap slots',
    method: 'POST',
    browserPath: `/binders/versions/${VERSION_A}/swap`,
    desktopPath: `/desktop/binders/versions/${VERSION_A}/swap`,
    body: {
      source: { page: 0, row: 0, column: 0 },
      target: { page: 0, row: 0, column: 1 },
      expectedRevision: 1,
    },
  },
  {
    name: 'insert entries',
    method: 'POST',
    browserPath: `/binders/versions/${VERSION_A}/entries/insert`,
    desktopPath: `/desktop/binders/versions/${VERSION_A}/entries/insert`,
    body: { at: { page: 0, row: 0, column: 0 }, entries: [{ kind: 'empty' }], expectedRevision: 1 },
  },
  {
    name: 'remove entry',
    method: 'POST',
    browserPath: `/binders/versions/${VERSION_A}/entries/remove`,
    desktopPath: `/desktop/binders/versions/${VERSION_A}/entries/remove`,
    body: { at: { page: 0, row: 0, column: 0 }, expectedRevision: 1 },
  },
  {
    name: 'move entry',
    method: 'POST',
    browserPath: `/binders/versions/${VERSION_A}/entries/move`,
    desktopPath: `/desktop/binders/versions/${VERSION_A}/entries/move`,
    body: { from: { page: 0, row: 0, column: 0 }, offset: 1, expectedRevision: 1 },
  },
  {
    name: 'set assignment',
    method: 'PUT',
    browserPath: `/binders/versions/${VERSION_A}/assignment`,
    desktopPath: `/desktop/binders/versions/${VERSION_A}/assignment`,
    body: { at: { page: 0, row: 0, column: 0 }, cardId: null, expectedRevision: 1 },
  },
  {
    name: 'set page break',
    method: 'PUT',
    browserPath: `/binders/versions/${VERSION_A}/page-break`,
    desktopPath: `/desktop/binders/versions/${VERSION_A}/page-break`,
    body: { at: { page: 0, row: 0, column: 0 }, startsNewPage: true, expectedRevision: 1 },
  },
  {
    name: 'reserve page',
    method: 'PUT',
    browserPath: `/binders/versions/${VERSION_A}/reserved-page`,
    desktopPath: `/desktop/binders/versions/${VERSION_A}/reserved-page`,
    body: { page: 0, reserved: true, label: 'Trades', expectedRevision: 1 },
  },
  {
    name: 'get bookmarks',
    method: 'GET',
    browserPath: `/binders/versions/${VERSION_A}/bookmarks`,
    desktopPath: `/desktop/binders/versions/${VERSION_A}/bookmarks`,
  },
  {
    name: 'set bookmark',
    method: 'PUT',
    browserPath: `/binders/versions/${VERSION_A}/bookmarks`,
    desktopPath: `/desktop/binders/versions/${VERSION_A}/bookmarks`,
    body: { pageId: PAGE_A, row: 1, column: 1, name: 'Favorite' },
  },
  {
    name: 'remove bookmark',
    method: 'DELETE',
    browserPath: `/binders/versions/${VERSION_A}/bookmarks/${BOOKMARK_A}`,
    desktopPath: `/desktop/binders/versions/${VERSION_A}/bookmarks/${BOOKMARK_A}`,
  },
  {
    name: 'resize capacity',
    method: 'PUT',
    browserPath: `/binders/versions/${VERSION_A}/capacity`,
    desktopPath: `/desktop/binders/versions/${VERSION_A}/capacity`,
    body: { capacity: 8, expectedRevision: 1 },
  },
  {
    name: 'insert full pokedex',
    method: 'POST',
    browserPath: `/binders/versions/${VERSION_A}/full-pokedex`,
    desktopPath: `/desktop/binders/versions/${VERSION_A}/full-pokedex`,
    body: { at: { page: 0, row: 0, column: 0 }, regionPageBreaks: true, expectedRevision: 1 },
  },
  {
    name: 'preview full pokedex',
    method: 'POST',
    browserPath: `/binders/versions/${VERSION_A}/full-pokedex/preview`,
    desktopPath: `/desktop/binders/versions/${VERSION_A}/full-pokedex/preview`,
    body: { at: { page: 0, row: 0, column: 0 }, regionPageBreaks: true, expectedRevision: 1 },
  },
  {
    name: 'get destinations',
    method: 'GET',
    browserPath: `/binders/versions/${VERSION_A}/destinations?cardId=${CARD_1}`,
    desktopPath: `/desktop/binders/versions/${VERSION_A}/destinations?cardId=${CARD_1}`,
  },
  {
    name: 'delete binder',
    method: 'DELETE',
    browserPath: `/binders/${BINDER_A}`,
    desktopPath: `/desktop/binders/${BINDER_A}`,
    body: { confirmationName: 'A Binder' },
  },
  // Browser-only (no desktop equivalent registered).
  {
    name: 'clone version',
    method: 'POST',
    browserPath: `/binders/versions/${VERSION_A}/clone`,
    body: { expectedRevision: 1 },
  },
  {
    name: 'discard draft version',
    method: 'DELETE',
    browserPath: `/binders/versions/${VERSION_A}`,
    body: { expectedRevision: 1 },
  },
  {
    name: 'activate version',
    method: 'POST',
    browserPath: `/binders/versions/${VERSION_A}/activate`,
    body: { expectedRevision: 1 },
  },
  {
    name: 'arrange version',
    method: 'POST',
    browserPath: `/binders/versions/${VERSION_A}/arrange`,
    body: { mode: 'set-number', expectedRevision: 1 },
  },
  {
    name: 'add page',
    method: 'POST',
    browserPath: `/binders/versions/${VERSION_A}/pages`,
    body: { expectedRevision: 1 },
  },
  {
    name: 'delete page',
    method: 'DELETE',
    browserPath: `/binders/versions/${VERSION_A}/pages/${PAGE_A}`,
    body: { expectedRevision: 1 },
  },
  {
    name: 'reorder pages',
    method: 'PUT',
    browserPath: `/binders/versions/${VERSION_A}/pages/order`,
    body: { pageIds: [PAGE_A], expectedRevision: 1 },
  },
  {
    name: 'preview paste',
    method: 'POST',
    browserPath: `/binders/versions/${VERSION_A}/entries/paste/preview`,
    body: {
      at: { page: 0, row: 0, column: 0 },
      cardIds: [CARD_1],
      mode: 'insert',
      expectedRevision: 1,
    },
  },
  {
    name: 'paste',
    method: 'POST',
    browserPath: `/binders/versions/${VERSION_A}/entries/paste`,
    body: {
      at: { page: 0, row: 0, column: 0 },
      cardIds: [CARD_1],
      mode: 'insert',
      expectedRevision: 1,
    },
  },
  {
    name: 'patch binder display',
    method: 'PATCH',
    browserPath: `/binders/${BINDER_A}`,
    body: { showFrame: true },
  },
];

describe('B can never reach A binder/page/slot/bookmark data by a guessed id', () => {
  it("sanity check: A's own session can read the version these 404 checks target", async () => {
    const response = await apiRoutes.request(
      `/binders/versions/${VERSION_A}`,
      browserInit(cookieA, 'GET'),
      env,
    );
    expect(response.status).toBe(200);
  });

  it.each(routeCases)('$name: $method $browserPath (browser session)', async (route) => {
    const response = await apiRoutes.request(
      route.browserPath,
      browserInit(cookieB, route.method, route.body),
      env,
    );
    expect(response.status).toBe(404);
    expect(response.status).not.toBe(403);
    await expect(response.json()).resolves.toMatchObject({ ok: false });
  });

  it.each(routeCases.filter((route) => route.desktopPath))(
    '$name: $method $desktopPath (desktop bearer)',
    async (route) => {
      const response = await apiRoutes.request(
        route.desktopPath as string,
        desktopInit(DESKTOP_TOKEN_B, route.method, route.body),
        env,
      );
      expect(response.status).toBe(404);
      expect(response.status).not.toBe(403);
      await expect(response.json()).resolves.toMatchObject({ ok: false });
    },
  );

  it('rejects placing a card into a binder id B does not own, from either surface', async () => {
    const body = {
      binderId: BINDER_A,
      slotId: encodeSlotId(PAGE_A, 0, 1),
      addCopy: false,
      expectedRevision: 1,
    };
    const browser = await apiRoutes.request(
      `/cards/${CARD_1}/place`,
      browserInit(cookieB, 'POST', body),
      env,
    );
    expect(browser.status).toBe(404);
  });

  it('lists and deletes desktop tokens scoped to the caller only, never another owner', async () => {
    const list = await apiRoutes.request('/desktop/tokens', browserInit(cookieB, 'GET'), env);
    expect(list.status).toBe(200);
    const listed: { tokens: Array<{ id: string; label: string }> } = await list.json();
    expect(listed.tokens.map((token) => token.id)).not.toContain(desktopTokenAId);
    expect(listed.tokens.every((token) => token.label !== 'A desktop')).toBe(true);

    const remove = await apiRoutes.request(
      `/desktop/tokens/${desktopTokenAId}`,
      browserInit(cookieB, 'DELETE'),
      env,
    );
    expect(remove.status).toBe(404);
    const stillActive = await db
      .prepare('SELECT revoked_at FROM desktop_tokens WHERE token_hash = ?1')
      .bind(desktopTokenAId)
      .first<{ revoked_at: number | null }>();
    expect(stillActive?.revoked_at).toBeNull();
  });

  it("never lists another owner's binders", async () => {
    const response = await apiRoutes.request('/binders', browserInit(cookieB, 'GET'), env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ binders: [] });
  });
});

describe('routes/auth/**: a passkey belongs to one account, not to whoever is signed in', () => {
  it("refuses to rename or delete another user's passkey", async () => {
    const rename = await passkeyRoutes.request(
      `/${PASSKEY_A}`,
      browserInit(cookieB, 'PATCH', { name: 'Stolen' }),
      env,
    );
    expect(rename.status).toBe(404);
    const remove = await passkeyRoutes.request(
      `/${PASSKEY_A}`,
      browserInit(cookieB, 'DELETE'),
      env,
    );
    expect(remove.status).toBe(404);
    expect(await getPasskeys(db, userA)).toHaveLength(1);
  });
});

describe('collection state is keyed by (owner, card) — B can only ever touch their own row', () => {
  it("setting/incrementing/annotating B's own quantity never changes A's", async () => {
    await apiRoutes.request(
      `/collection/${CARD_1}`,
      browserInit(cookieB, 'PUT', {
        mutationId: '00000000-0000-4000-8000-0000000000b1',
        expectedRevision: 1,
        quantity: 3,
        notes: 'mine',
      }),
      env,
    );
    await apiRoutes.request(
      `/collection/${CARD_1}/increment`,
      browserInit(cookieB, 'POST', {
        mutationId: '00000000-0000-4000-8000-0000000000b2',
        delta: 1,
      }),
      env,
    );
    await apiRoutes.request(
      `/collection/${CARD_1}/notes`,
      browserInit(cookieB, 'PATCH', {
        mutationId: '00000000-0000-4000-8000-0000000000b3',
        expectedRevision: 2,
        notes: 'B only',
      }),
      env,
    );
    const stateA = await db
      .prepare(
        'SELECT quantity, notes, revision FROM collection_cards WHERE owner_id = ?1 AND card_id = ?2',
      )
      .bind(userA, CARD_1)
      .first();
    expect(stateA).toEqual({ quantity: 2, notes: null, revision: 1 });
  });

  // Fixed by ws-data-2: unassignAndDecrement's slot lookup and UPDATE now
  // join through to binders.owner_id, so a 'pocket' removal can no longer
  // accept another owner's real slotId just because the caller separately
  // owns a loose copy of the same card.
  it("does not let a guessed slotId from A's binder be used in B's own pocket removal", async () => {
    const response = await apiRoutes.request(
      `/collection/${CARD_1}/remove`,
      browserInit(cookieB, 'POST', { source: 'pocket', slotId: encodeSlotId(PAGE_A, 0, 0) }),
      env,
    );
    expect(response.status).toBe(404);
    const slot = await db
      .prepare(
        'SELECT assigned_card_id FROM binder_slots WHERE binder_page_id = ?1 AND row_index = 0 AND column_index = 0',
      )
      .bind(PAGE_A)
      .first<{ assigned_card_id: string | null }>();
    expect(slot?.assigned_card_id).toBe(CARD_1);
  });
});

describe('custom cards are per-owner catalogue data, not shared', () => {
  // Fixed by ws-data-2: createCustomCard now takes an ownerId, and both
  // searchCards and getCardDetail filter catalogue_cards.owner_id.
  it("hides another owner's custom card from search and detail", async () => {
    const detail = await apiRoutes.request(
      `/catalogue/${CUSTOM_A}`,
      browserInit(cookieB, 'GET'),
      env,
    );
    expect(detail.status).toBe(404);
  });

  // Fixed by ws-data-2: resolveCatalogueCards's WHERE clause now has the
  // same (c.owner_id IS NULL OR c.owner_id = ?1) filter as getCardDetail
  // and searchCards.
  it("hides another owner's custom card from the batch resolve route too", async () => {
    const response = await apiRoutes.request(
      '/catalogue/cards/resolve',
      browserInit(cookieB, 'POST', { cardIds: [CUSTOM_A] }),
      env,
    );
    const body: { cards: unknown[] } = await response.json();
    expect(body.cards).toHaveLength(0);
  });
});

describe("backups: a restore can only ever load the caller's own backup", () => {
  it("rejects restoring another owner's backup before ever touching R2", async () => {
    const art = {
      get: () => {
        throw new Error('restoreBackup must not reach R2 for a backup it does not own');
      },
    } as unknown as R2Bucket;
    await expect(restoreBackup(db, art, userB, 'backup-a')).rejects.toMatchObject(
      new ApplicationError('backup_not_found', 404),
    );
  });
});

describe('final integrity check', () => {
  it("leaves every one of A's rows exactly as seeded after every attempt above", async () => {
    expect(
      await db
        .prepare('SELECT revision FROM binder_versions WHERE id = ?1')
        .bind(VERSION_A)
        .first(),
    ).toEqual({ revision: 1 });
    expect(
      await db.prepare('SELECT name FROM binders WHERE id = ?1').bind(BINDER_A).first(),
    ).toEqual({ name: 'A Binder' });
    expect(
      await db
        .prepare('SELECT COUNT(*) AS count FROM binder_bookmarks WHERE binder_page_id = ?1')
        .bind(PAGE_A)
        .first(),
    ).toEqual({ count: 1 });
    expect(
      await db
        .prepare(
          'SELECT quantity, revision FROM collection_cards WHERE owner_id = ?1 AND card_id = ?2',
        )
        .bind(userA, CARD_1)
        .first(),
    ).toEqual({ quantity: 2, revision: 1 });
    expect(await getPasskeys(db, userA)).toHaveLength(1);
  });
});

describe('catalogue sync rewrites the shared catalogue, so only admins may start it', () => {
  it.each([
    '/catalogue/full-sync',
    '/catalogue/sync',
    '/catalogue/sync/runs',
    '/catalogue/sync/runs/any-run/cards',
    '/catalogue/sync/runs/any-run/finalize',
    '/prices/refresh',
  ])('member B gets 403 on POST %s', async (path) => {
    const response = await apiRoutes.request(path, browserInit(cookieB, 'POST', {}), env);
    expect(response.status).toBe(403);
  });
});

describe("another owner's custom card stays private through art and collection routes", () => {
  beforeAll(() => {
    database.exec(`
      INSERT INTO art_manifest (card_id, variant, object_key, sha256, bytes, version, updated_at)
      VALUES
        ('${CARD_1}', 'high', 'cards/${CARD_1}/high/${'1'.repeat(64)}.webp', '${'1'.repeat(64)}', 10, 1, 1),
        ('${CUSTOM_A}', 'high', 'cards/${CUSTOM_A}/high/${'2'.repeat(64)}.webp', '${'2'.repeat(64)}', 10, 1, 1);
    `);
  });

  it("leaves A's custom card out of B's art manifest", async () => {
    const response = await apiRoutes.request('/art/manifest', browserInit(cookieB, 'GET'), env);
    expect(response.status).toBe(200);
    const body: { entries: Array<{ cardId: string }> } = await response.json();
    expect(body.entries.map((entry) => entry.cardId)).toEqual([CARD_1]);
  });

  it("404s B's read of A's custom card art", async () => {
    const response = await apiRoutes.request(
      `/art/${CUSTOM_A}/high`,
      browserInit(cookieB, 'GET'),
      env,
    );
    expect(response.status).toBe(404);
  });

  it("404s B's upload ticket request for A's custom card and issues nothing", async () => {
    const response = await apiRoutes.request(
      '/desktop/art/upload-tokens',
      desktopInit(DESKTOP_TOKEN_B, 'POST', {
        cardId: CUSTOM_A,
        variant: 'high',
        sha256: '3'.repeat(64),
        maxBytes: 100,
      }),
      env,
    );
    expect(response.status).toBe(404);
    expect(
      await db
        .prepare('SELECT COUNT(*) AS count FROM art_upload_tokens WHERE card_id = ?1')
        .bind(CUSTOM_A)
        .first(),
    ).toEqual({ count: 0 });
  });

  it("404s B's collection writes naming A's custom card and creates no row", async () => {
    const set = await apiRoutes.request(
      `/collection/${CUSTOM_A}`,
      browserInit(cookieB, 'PUT', {
        mutationId: '00000000-0000-4000-8000-0000000000c1',
        expectedRevision: 0,
        quantity: 1,
        notes: null,
      }),
      env,
    );
    expect(set.status).toBe(404);
    const increment = await apiRoutes.request(
      `/collection/${CUSTOM_A}/increment`,
      browserInit(cookieB, 'POST', {
        mutationId: '00000000-0000-4000-8000-0000000000c2',
        delta: 1,
      }),
      env,
    );
    expect(increment.status).toBe(404);
    expect(
      await db
        .prepare('SELECT COUNT(*) AS count FROM collection_cards WHERE card_id = ?1')
        .bind(CUSTOM_A)
        .first(),
    ).toEqual({ count: 0 });
  });
});

// ws-harden-auth: end-to-end proof for review finding 4, through the real
// HTTP routes and guards rather than the lib-level unit tests in
// auth.test.ts/desktop-auth.test.ts. Disables B (a plain member, so no
// last-admin concern) and must be the last block in this file — every
// earlier describe above assumes B is still an active account.
describe('disabling a user closes every one of their live credentials, end to end', () => {
  it('401s an existing cookie session and an existing desktop bearer token the moment the owner is disabled', async () => {
    const beforeDisable = await apiRoutes.request('/people/me', browserInit(cookieB, 'GET'), env);
    expect(beforeDisable.status).toBe(200);
    const desktopBeforeDisable = await apiRoutes.request(
      '/desktop/binders',
      desktopInit(DESKTOP_TOKEN_B, 'GET'),
      env,
    );
    expect(desktopBeforeDisable.status).toBe(200);

    await patchPerson(db, userB, { disabled: true });

    const afterDisable = await apiRoutes.request('/people/me', browserInit(cookieB, 'GET'), env);
    expect(afterDisable.status).toBe(401);
    const desktopAfterDisable = await apiRoutes.request(
      '/desktop/binders',
      desktopInit(DESKTOP_TOKEN_B, 'GET'),
      env,
    );
    expect(desktopAfterDisable.status).toBe(401);
  });

  it('refuses a passkey registration ceremony started for the now-disabled account', async () => {
    const response = await passkeyRoutes.request(
      '/register/options',
      browserInit(cookieB, 'POST', {}),
      env,
    );
    expect(response.status).toBe(401);
  });
});
