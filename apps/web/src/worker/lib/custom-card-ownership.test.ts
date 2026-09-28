import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createArtUploadTokens, getArtResponse, listArtManifest, uploadArt } from './art';
import { getBinderAssignmentCandidates } from './binders';
import { listCatalogueSources } from './catalogue';
import {
  incrementCollectionQuantity,
  patchCollectionNotes,
  removeCollectionCopy,
  setCollectionState,
} from './collection';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';

const USER_A = 'user-a';
const USER_B = 'user-b';
const SHARED = 'shared-7';
const CUSTOM_A = 'custom-a';

let raw: DatabaseSync;
let db: D1Database;

beforeEach(() => {
  raw = new DatabaseSync(':memory:');
  applyAllMigrations(raw);
  raw.exec(`
    INSERT INTO users (id, label, role, created_at) VALUES
      ('${USER_A}', 'A', 'admin', 1), ('${USER_B}', 'B', 'member', 1);
    INSERT INTO catalogue_cards
      (id, name, language, category, set_id, set_name, number, pokedex_number, is_custom, owner_id, created_at, updated_at)
    VALUES
      ('${SHARED}', 'Squirtle', 'en', 'pokemon', 'base', 'Base', '7', 7, 0, NULL, 1, 1),
      ('${CUSTOM_A}', 'A''s Secret Squirtle', 'en', 'pokemon', 'custom', 'Custom', '1', 7, 1, '${USER_A}', 1, 1);
    INSERT INTO art_manifest (card_id, variant, object_key, sha256, bytes, version, updated_at)
    VALUES
      ('${SHARED}', 'high', 'cards/${SHARED}/high/${'a'.repeat(64)}.webp', '${'a'.repeat(64)}', 10, 1, 1),
      ('${CUSTOM_A}', 'high', 'cards/${CUSTOM_A}/high/${'b'.repeat(64)}.webp', '${'b'.repeat(64)}', 10, 1, 1);
  `);
  db = sqliteD1(raw);
});

afterEach(() => raw.close());

// Any R2 access at all means the ownership check came too late.
const untouchableArt = new Proxy({} as R2Bucket, {
  get() {
    throw new Error('R2 must not be reached for a card the caller cannot see');
  },
});

function table(sql: string): unknown[] {
  return raw.prepare(sql).all();
}

describe("custom-card art is only visible and writable by the card's owner", () => {
  it("leaves B's manifest without A's custom card, and keeps it in A's", async () => {
    const forB = await listArtManifest(db, USER_B, null, 100);
    expect(forB.entries.map((entry) => entry.cardId)).toEqual([SHARED]);
    const forA = await listArtManifest(db, USER_A, null, 100);
    expect(forA.entries.map((entry) => entry.cardId)).toEqual([CUSTOM_A, SHARED]);
  });

  it("answers B's image read for A's custom card as not found, before touching R2", async () => {
    await expect(
      getArtResponse(
        db,
        untouchableArt,
        USER_B,
        CUSTOM_A,
        'high',
        new Request('https://example.test/art'),
      ),
    ).resolves.toBeNull();
  });

  it("refuses to issue B an upload ticket for A's custom card", async () => {
    await expect(
      createArtUploadTokens(db, USER_B, [
        { cardId: CUSTOM_A, variant: 'high', sha256: 'c'.repeat(64), maxBytes: 100 },
      ]),
    ).rejects.toMatchObject({ code: 'card_not_found', status: 404 });
    expect(table('SELECT * FROM art_upload_tokens')).toEqual([]);
  });

  it('refuses to redeem a ticket whose holder does not own the custom card', async () => {
    const [ticket] = await createArtUploadTokens(db, USER_A, [
      { cardId: CUSTOM_A, variant: 'high', sha256: 'c'.repeat(64), maxBytes: 100 },
    ]);
    if (!ticket) throw new Error('ticket_missing');
    // A ticket issued to B before issuing was owner-aware.
    raw.exec(`UPDATE art_upload_tokens SET owner_id = '${USER_B}'`);
    const manifestBefore = table('SELECT * FROM art_manifest ORDER BY card_id');
    await expect(
      uploadArt(
        db,
        untouchableArt,
        ticket.token,
        ticket.ticketId,
        new Request('https://example.test/upload', { method: 'PUT', body: 'x' }),
      ),
    ).rejects.toMatchObject({ code: 'art_upload_token_invalid' });
    expect(table('SELECT * FROM art_manifest ORDER BY card_id')).toEqual(manifestBefore);
    expect(table('SELECT consumed_at FROM art_upload_tokens')).toEqual([{ consumed_at: null }]);
  });

  it('refuses to redeem a ticket once its holder has been disabled', async () => {
    const [ticket] = await createArtUploadTokens(db, USER_B, [
      { cardId: SHARED, variant: 'low', sha256: 'd'.repeat(64), maxBytes: 100 },
    ]);
    if (!ticket) throw new Error('ticket_missing');
    raw.exec(`UPDATE users SET disabled_at = 2 WHERE id = '${USER_B}'`);
    await expect(
      uploadArt(
        db,
        untouchableArt,
        ticket.token,
        ticket.ticketId,
        new Request('https://example.test/upload', { method: 'PUT', body: 'x' }),
      ),
    ).rejects.toMatchObject({ code: 'art_upload_token_invalid' });
    expect(table('SELECT consumed_at FROM art_upload_tokens')).toEqual([{ consumed_at: null }]);
  });
});

describe("collection writes refuse another owner's custom card", () => {
  it.each([
    [
      'set',
      () =>
        setCollectionState(db, USER_B, {
          cardId: CUSTOM_A,
          mutationId: crypto.randomUUID(),
          expectedRevision: 0,
          quantity: 1,
          notes: null,
        }),
    ],
    [
      'increment',
      () =>
        incrementCollectionQuantity(db, USER_B, {
          cardId: CUSTOM_A,
          mutationId: crypto.randomUUID(),
          delta: 1,
        }),
    ],
    [
      'notes',
      () =>
        patchCollectionNotes(db, USER_B, {
          cardId: CUSTOM_A,
          mutationId: crypto.randomUUID(),
          expectedRevision: 0,
          notes: 'mine now',
        }),
    ],
    ['remove', () => removeCollectionCopy(db, USER_B, CUSTOM_A, { source: 'loose' })],
  ])('%s: card_not_found, and B gets no row for it', async (_name, attempt) => {
    await expect(attempt()).rejects.toMatchObject({ code: 'card_not_found' });
    expect(table('SELECT * FROM collection_cards')).toEqual([]);
    expect(table('SELECT * FROM collection_events')).toEqual([]);
  });

  it('A can still write their own custom card', async () => {
    const result = await incrementCollectionQuantity(db, USER_A, {
      cardId: CUSTOM_A,
      mutationId: crypto.randomUUID(),
      delta: 1,
    });
    expect(result.state.quantity).toBe(1);
  });

  it("never offers A's custom card as an assignment candidate to B", async () => {
    // B's collection naming A's card is what the old existence-only check let
    // through; the candidates query must stay safe even with that row present.
    raw.exec(`
      INSERT INTO collection_cards (owner_id, card_id, quantity, revision, updated_at) VALUES
        ('${USER_B}', '${CUSTOM_A}', 1, 1, 1), ('${USER_B}', '${SHARED}', 1, 1, 1);
      INSERT INTO binders (id, owner_id, name, created_at, updated_at)
      VALUES ('binder-b', '${USER_B}', 'B', 1, 1);
      INSERT INTO binder_versions
        (id, binder_id, version_number, status, layout_kind, rows, columns, capacity, created_at, revision)
      VALUES ('version-b', 'binder-b', 1, 'active', '2x2', 2, 2, 4, 1, 1);
      UPDATE binders SET active_version_id = 'version-b' WHERE id = 'binder-b';
      INSERT INTO binder_pages (id, binder_version_id, position) VALUES ('page-b', 'version-b', 0);
      INSERT INTO binder_slots (binder_page_id, row_index, column_index, card_id, pokemon_number, entry_kind)
      VALUES ('page-b', 0, 0, NULL, 7, 'pokemon'), ('page-b', 0, 1, NULL, NULL, 'empty'),
        ('page-b', 1, 0, NULL, NULL, 'empty'), ('page-b', 1, 1, NULL, NULL, 'empty');
    `);
    const result = await getBinderAssignmentCandidates(db, USER_B, 'version-b', {
      page: 0,
      row: 0,
      column: 0,
    });
    expect(result.candidates.map((candidate) => candidate.cardId)).toEqual([SHARED]);
  });
});

describe("the desktop card-sources list leaves out another owner's custom card", () => {
  beforeEach(() => {
    raw.exec(`
      INSERT INTO card_sources
        (provider, source_id, card_id, language, source_updated_at, checksum, active, imported_at)
      VALUES
        ('tcgdex', 'base-7', '${SHARED}', 'en', 1, '${'a'.repeat(64)}', 1, 1),
        ('tcgdex', 'custom-7', '${CUSTOM_A}', 'en', 1, '${'b'.repeat(64)}', 1, 1);
    `);
  });

  it('shows B only shared cards and A their own custom card too, on every page', async () => {
    const forB = await listCatalogueSources(db, USER_B, null, 100);
    expect(forB.entries.map((entry) => entry.cardId)).toEqual([SHARED]);
    const forA = await listCatalogueSources(db, USER_A, null, 100);
    expect(forA.entries.map((entry) => entry.cardId)).toEqual([CUSTOM_A, SHARED]);
    const firstForB = await listCatalogueSources(db, USER_B, null, 1);
    expect(firstForB.entries.map((entry) => entry.cardId)).toEqual([SHARED]);
    // A cursor from A's first page still never lets B see A's card.
    const firstForA = await listCatalogueSources(db, USER_A, null, 1);
    expect(firstForA.entries.map((entry) => entry.cardId)).toEqual([CUSTOM_A]);
    const nextForB = await listCatalogueSources(db, USER_B, firstForA.cursor, 100);
    expect(nextForB.entries.map((entry) => entry.cardId)).toEqual([SHARED]);
  });
});
