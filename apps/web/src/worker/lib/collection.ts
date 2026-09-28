import {
  cardIdSchema,
  collectionStateSchema,
  type CollectionIncrementRequest,
  type CollectionMutationResult,
  type CollectionNotesPatchRequest,
  type CollectionSetRequest,
  type CollectionState,
} from '@pokedex/shared';
import { decodeSlotId, encodeSlotId, isoFromSeconds, newId, nowSeconds } from './db';

interface CollectionRow {
  card_id: string;
  quantity: number;
  notes: string | null;
  revision: number;
  updated_at: number;
}

interface MutationRow {
  request_hash: string;
  response_json: string;
}

export interface CollectionMutation extends Omit<CollectionSetRequest, 'expectedRevision'> {
  cardId: string;
  expectedRevision?: number;
}

export interface CollectionIncrementMutation extends CollectionIncrementRequest {
  cardId: string;
}

export interface CollectionNotesPatchMutation extends Omit<
  CollectionNotesPatchRequest,
  'expectedRevision'
> {
  cardId: string;
  expectedRevision?: number;
}

export type CollectionErrorCode =
  | 'card_not_found'
  | 'collection_not_found'
  | 'collection_revision_conflict'
  | 'collection_mutation_conflict'
  | 'collection_quantity_out_of_bounds'
  | 'collection_quantity_below_active_assignments'
  | 'collection_remove_no_loose_copies'
  | 'collection_remove_slot_not_found'
  | 'collection_remove_slot_required'
  | 'invalid_stored_mutation';

export type CollectionEventSource = 'add' | 'pocket' | 'loose' | 'miscount' | 'set' | 'import';

export interface ActiveBinderAssignmentLocation {
  binderId: string;
  versionId: string;
  page: number;
  row: number;
  column: number;
}

export interface RemoveCandidate {
  slotId: string;
  binderId: string;
  binderName: string;
  page: number;
  row: number;
  column: number;
}

export class CollectionDomainError extends Error {
  constructor(
    public readonly code: CollectionErrorCode,
    public readonly details?:
      { activeAssignments: ActiveBinderAssignmentLocation[] } | { candidates: RemoveCandidate[] },
  ) {
    super(code);
    this.name = 'CollectionDomainError';
  }
}

export interface CollectionRemoveInput {
  source: 'pocket' | 'loose' | 'miscount';
  slotId?: string;
}

function toState(row: CollectionRow): CollectionState {
  return {
    cardId: cardIdSchema.parse(row.card_id),
    quantity: row.quantity,
    notes: row.notes,
    revision: row.revision,
    updatedAt: isoFromSeconds(row.updated_at),
  };
}

function readStoredState(value: string): CollectionState {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new CollectionDomainError('invalid_stored_mutation');
  }
  const parsed = collectionStateSchema.safeParse(decoded);
  if (!parsed.success) throw new CollectionDomainError('invalid_stored_mutation');
  return parsed.data;
}

async function requestHash(value: readonly unknown[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// A custom card belongs to its owner alone (NULL owner_id = shared). Without
// the owner check, another user could put someone's private card into their
// own collection and then read its name and metadata back through every
// collection and binder view that joins the catalogue.
async function requireCollectionCard(
  db: D1Database,
  ownerId: string,
  cardId: string,
): Promise<void> {
  const card = await db
    .prepare('SELECT id FROM catalogue_cards WHERE id = ?1 AND (owner_id IS NULL OR owner_id = ?2)')
    .bind(cardId, ownerId)
    .first();
  if (!card) throw new CollectionDomainError('card_not_found');
}

async function readMutation(
  db: D1Database,
  ownerId: string,
  mutationId: string,
): Promise<MutationRow | null> {
  return db
    .prepare(
      'SELECT request_hash, response_json FROM collection_mutations WHERE owner_id = ?1 AND mutation_id = ?2',
    )
    .bind(ownerId, mutationId)
    .first<MutationRow>();
}

function replay(row: MutationRow, hash: string): CollectionMutationResult {
  if (row.request_hash !== hash) throw new CollectionDomainError('collection_mutation_conflict');
  return { state: readStoredState(row.response_json), replayed: true };
}

function mutationInsert(
  db: D1Database,
  ownerId: string,
  cardId: string,
  mutationId: string,
  hash: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO collection_mutations
        (owner_id, mutation_id, card_id, request_hash, response_json, created_at)
       SELECT ?1, ?2, card_id, ?3,
        json_object(
          'cardId', card_id,
          'quantity', quantity,
          'notes', notes,
          'revision', revision,
          'updatedAt', strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, 'unixepoch')
        ), ?4
       FROM collection_cards
       WHERE owner_id = ?1 AND card_id = ?5 AND last_mutation_id = ?2`,
    )
    .bind(ownerId, mutationId, hash, now, cardId);
}

export function eventInsert(
  db: D1Database,
  ownerId: string,
  cardId: string,
  delta: number,
  source: CollectionEventSource,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO collection_events (id, owner_id, card_id, delta, source, slot_id, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6)`,
    )
    .bind(newId('event'), ownerId, cardId, delta, source, now);
}

// The ledger row is inserted only when the mutation's own update landed,
// which is the one thing last_mutation_id proves inside the batch: a
// rejected update (revision conflict, quantity cap) matches zero rows here
// too, so the batch can never commit an event for a change that didn't happen.
export function appliedEventInsert(
  db: D1Database,
  ownerId: string,
  cardId: string,
  mutationId: string,
  delta: number,
  source: CollectionEventSource,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO collection_events (id, owner_id, card_id, delta, source, slot_id, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, NULL, ?6 FROM collection_cards
       WHERE owner_id = ?2 AND card_id = ?3 AND last_mutation_id = ?7`,
    )
    .bind(newId('event'), ownerId, cardId, delta, source, now, mutationId);
}

async function commitMutation(
  db: D1Database,
  ownerId: string,
  cardId: string,
  mutationId: string,
  hash: string,
  update: D1PreparedStatement,
  conflict: CollectionErrorCode,
  ledger?: { delta: number; source: CollectionEventSource },
): Promise<CollectionMutationResult> {
  const previous = await readMutation(db, ownerId, mutationId);
  if (previous) return replay(previous, hash);
  const now = nowSeconds();
  try {
    const statements = [update];
    // Only a real quantity change earns a ledger row — a no-op set (or an
    // idempotent replay, handled above) shouldn't pad the history.
    if (ledger && ledger.delta !== 0)
      statements.push(
        appliedEventInsert(db, ownerId, cardId, mutationId, ledger.delta, ledger.source, now),
      );
    statements.push(
      mutationInsert(db, ownerId, cardId, mutationId, hash, now),
      db
        .prepare(
          'SELECT request_hash, response_json FROM collection_mutations WHERE owner_id = ?1 AND mutation_id = ?2',
        )
        .bind(ownerId, mutationId),
    );
    const results = await db.batch<MutationRow>(statements);
    const inserted = results.at(-2)?.meta.changes ?? 0;
    const stored = results.at(-1)?.results.at(0);
    if (inserted !== 1 || !stored) throw new CollectionDomainError(conflict);
    return { state: readStoredState(stored.response_json), replayed: false };
  } catch (error) {
    const concurrent = await readMutation(db, ownerId, mutationId);
    if (concurrent) return replay(concurrent, hash);
    throw error;
  }
}

export async function getCollectionState(
  db: D1Database,
  ownerId: string,
  cardId: string,
): Promise<CollectionState | null> {
  const row = await db
    .prepare(
      'SELECT card_id, quantity, notes, revision, updated_at FROM collection_cards WHERE owner_id = ?1 AND card_id = ?2',
    )
    .bind(ownerId, cardId)
    .first<CollectionRow>();
  return row ? toState(row) : null;
}

export async function setCollectionState(
  db: D1Database,
  ownerId: string,
  input: CollectionMutation,
): Promise<CollectionMutationResult> {
  await requireCollectionCard(db, ownerId, input.cardId);
  const hash = await requestHash([
    'set',
    input.cardId,
    input.expectedRevision ?? null,
    input.quantity,
    input.notes,
  ]);
  const previous = await readMutation(db, ownerId, input.mutationId);
  if (previous) return replay(previous, hash);
  const current = await getCollectionState(db, ownerId, input.cardId);
  const expectedRevision = input.expectedRevision ?? current?.revision ?? 0;
  if ((current?.revision ?? 0) !== expectedRevision)
    throw new CollectionDomainError('collection_revision_conflict');
  const now = nowSeconds();
  try {
    return await commitMutation(
      db,
      ownerId,
      input.cardId,
      input.mutationId,
      hash,
      db
        .prepare(
          `INSERT INTO collection_cards
          (owner_id, card_id, quantity, notes, revision, updated_at, last_mutation_id)
         VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6)
         ON CONFLICT(owner_id, card_id) DO UPDATE SET
          quantity = excluded.quantity,
          notes = excluded.notes,
          revision = collection_cards.revision + 1,
          updated_at = excluded.updated_at,
          last_mutation_id = excluded.last_mutation_id
         WHERE collection_cards.revision = ?7
           AND excluded.quantity >= (
             SELECT COUNT(*) FROM binder_slots slot
             JOIN binder_pages page ON page.id = slot.binder_page_id
             JOIN binder_versions version ON version.id = page.binder_version_id
             JOIN binders binder ON binder.id = version.binder_id
             WHERE binder.owner_id = ?1 AND version.status = 'active'
               AND slot.assigned_card_id = ?2
           )`,
        )
        .bind(
          ownerId,
          input.cardId,
          input.quantity,
          input.notes,
          now,
          input.mutationId,
          expectedRevision,
        ),
      'collection_revision_conflict',
      { delta: input.quantity - (current?.quantity ?? 0), source: 'set' },
    );
  } catch (error) {
    const assigned = await db
      .prepare(
        `SELECT binder.id AS binder_id, version.id AS version_id, page.position,
          slot.row_index, slot.column_index FROM binder_slots slot
         JOIN binder_pages page ON page.id = slot.binder_page_id
         JOIN binder_versions version ON version.id = page.binder_version_id
         JOIN binders binder ON binder.id = version.binder_id
         WHERE binder.owner_id = ?1 AND version.status = 'active'
           AND slot.assigned_card_id = ?2
         ORDER BY binder.id, version.id, page.position, slot.row_index, slot.column_index`,
      )
      .bind(ownerId, input.cardId)
      .all<{
        binder_id: string;
        version_id: string;
        position: number;
        row_index: number;
        column_index: number;
      }>();
    if (assigned.results.length > input.quantity)
      throw new CollectionDomainError('collection_quantity_below_active_assignments', {
        activeAssignments: assigned.results.map((location) => ({
          binderId: location.binder_id,
          versionId: location.version_id,
          page: location.position,
          row: location.row_index,
          column: location.column_index,
        })),
      });
    throw error;
  }
}

// Statement builders for callers (binders.ts's placeCard) that need the
// quantity change to land in the same D1 batch() as other writes, so a
// failure anywhere in that batch leaves the quantity untouched rather than
// incrementing it ahead of a slot assignment that then fails separately.
export function quantityCapAssertion(
  db: D1Database,
  ownerId: string,
  cardId: string,
  delta: number,
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT CASE WHEN COALESCE(
          (SELECT quantity FROM collection_cards WHERE owner_id = ?1 AND card_id = ?2), 0
        ) + ?3 <= 9999
        THEN 1 ELSE json_extract('collection_quantity_out_of_bounds', '$') END AS valid`,
    )
    .bind(ownerId, cardId, delta);
}

export function incrementQuantityStatement(
  db: D1Database,
  ownerId: string,
  cardId: string,
  delta: number,
  mutationId: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO collection_cards
        (owner_id, card_id, quantity, notes, revision, updated_at, last_mutation_id)
       VALUES (?1, ?2, ?3, NULL, 1, ?4, ?5)
       ON CONFLICT(owner_id, card_id) DO UPDATE SET
        quantity = collection_cards.quantity + excluded.quantity,
        revision = collection_cards.revision + 1,
        updated_at = excluded.updated_at,
        last_mutation_id = excluded.last_mutation_id
       WHERE collection_cards.quantity + excluded.quantity <= 9999`,
    )
    .bind(ownerId, cardId, delta, now, mutationId);
}

export async function incrementCollectionQuantity(
  db: D1Database,
  ownerId: string,
  input: CollectionIncrementMutation,
): Promise<CollectionMutationResult> {
  await requireCollectionCard(db, ownerId, input.cardId);
  const now = nowSeconds();
  const hash = await requestHash(['increment', input.cardId, input.delta]);
  return commitMutation(
    db,
    ownerId,
    input.cardId,
    input.mutationId,
    hash,
    db
      .prepare(
        `INSERT INTO collection_cards
          (owner_id, card_id, quantity, notes, revision, updated_at, last_mutation_id)
         VALUES (?1, ?2, ?3, NULL, 1, ?4, ?5)
         ON CONFLICT(owner_id, card_id) DO UPDATE SET
          quantity = collection_cards.quantity + excluded.quantity,
          revision = collection_cards.revision + 1,
          updated_at = excluded.updated_at,
          last_mutation_id = excluded.last_mutation_id
         WHERE collection_cards.quantity + excluded.quantity <= 9999`,
      )
      .bind(ownerId, input.cardId, input.delta, now, input.mutationId),
    'collection_quantity_out_of_bounds',
    { delta: input.delta, source: 'add' },
  );
}

export async function patchCollectionNotes(
  db: D1Database,
  ownerId: string,
  input: CollectionNotesPatchMutation,
): Promise<CollectionMutationResult> {
  await requireCollectionCard(db, ownerId, input.cardId);
  const hash = await requestHash([
    'notes',
    input.cardId,
    input.expectedRevision ?? null,
    input.notes,
  ]);
  const previous = await readMutation(db, ownerId, input.mutationId);
  if (previous) return replay(previous, hash);
  const current = await getCollectionState(db, ownerId, input.cardId);
  const expectedRevision = input.expectedRevision ?? current?.revision ?? 0;
  if ((current?.revision ?? 0) !== expectedRevision)
    throw new CollectionDomainError('collection_revision_conflict');
  const now = nowSeconds();
  return commitMutation(
    db,
    ownerId,
    input.cardId,
    input.mutationId,
    hash,
    db
      .prepare(
        `INSERT INTO collection_cards
          (owner_id, card_id, quantity, notes, revision, updated_at, last_mutation_id)
         VALUES (?1, ?2, 0, ?3, 1, ?4, ?5)
         ON CONFLICT(owner_id, card_id) DO UPDATE SET
          notes = excluded.notes,
          revision = collection_cards.revision + 1,
          updated_at = excluded.updated_at,
          last_mutation_id = excluded.last_mutation_id
         WHERE collection_cards.revision = ?6`,
      )
      .bind(ownerId, input.cardId, input.notes, now, input.mutationId, expectedRevision),
    current ? 'collection_revision_conflict' : 'collection_not_found',
  );
}

export async function collectionSummary(
  db: D1Database,
  ownerId: string,
): Promise<{
  uniqueOwned: number;
  totalQuantity: number;
  noted: number;
}> {
  const row = await db
    .prepare(
      `SELECT COUNT(CASE WHEN quantity > 0 THEN 1 END) AS unique_owned,
        COALESCE(SUM(quantity), 0) AS total_quantity,
        COUNT(CASE WHEN notes IS NOT NULL AND notes <> '' THEN 1 END) AS noted
       FROM collection_cards WHERE owner_id = ?1`,
    )
    .bind(ownerId)
    .first<{ unique_owned: number; total_quantity: number; noted: number }>();
  return {
    uniqueOwned: row?.unique_owned ?? 0,
    totalQuantity: row?.total_quantity ?? 0,
    noted: row?.noted ?? 0,
  };
}

async function assignedSlotsForCard(
  db: D1Database,
  ownerId: string,
  cardId: string,
): Promise<RemoveCandidate[]> {
  const result = await db
    .prepare(
      `SELECT binder.id AS binder_id, binder.name AS binder_name, page.id AS page_id,
        page.position, slot.row_index, slot.column_index
       FROM binder_slots slot
       JOIN binder_pages page ON page.id = slot.binder_page_id
       JOIN binder_versions version ON version.id = page.binder_version_id
       JOIN binders binder ON binder.id = version.binder_id
       WHERE binder.owner_id = ?1 AND version.status = 'active' AND slot.assigned_card_id = ?2
       ORDER BY binder.id, page.position, slot.row_index, slot.column_index`,
    )
    .bind(ownerId, cardId)
    .all<{
      binder_id: string;
      binder_name: string;
      page_id: string;
      position: number;
      row_index: number;
      column_index: number;
    }>();
  return result.results.map((row) => ({
    slotId: encodeSlotId(row.page_id, row.row_index, row.column_index),
    binderId: row.binder_id,
    binderName: row.binder_name,
    page: row.position,
    row: row.row_index,
    column: row.column_index,
  }));
}

// Every invariant a removal depends on is re-asserted inside its batch, not
// just checked beforehand: D1's batch() is one transaction, but a guarded
// UPDATE that matches zero rows is not an error, and throwing once batch()
// has resolved can't roll anything back. A failing assertion raises a SQL
// error (json_extract on a non-JSON literal), which aborts the whole batch
// and leaves inventory and binder rows exactly as they were.
function collectionRevisionAssertion(
  db: D1Database,
  ownerId: string,
  cardId: string,
  expected: CollectionState,
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT CASE WHEN EXISTS (
          SELECT 1 FROM collection_cards WHERE owner_id = ?1 AND card_id = ?2
            AND revision = ?3 AND quantity = ?4 AND quantity > 0
        ) THEN 1 ELSE json_extract('collection_revision_conflict', '$') END AS valid`,
    )
    .bind(ownerId, cardId, expected.revision, expected.quantity);
}

const ACTIVE_ASSIGNMENT_COUNT = `(SELECT COUNT(*) FROM binder_slots slot
  JOIN binder_pages page ON page.id = slot.binder_page_id
  JOIN binder_versions version ON version.id = page.binder_version_id
  JOIN binders binder ON binder.id = version.binder_id
  WHERE binder.owner_id = ?1 AND version.status = 'active' AND slot.assigned_card_id = ?2)`;

const LOOSE_COPIES = `COALESCE(
  (SELECT quantity FROM collection_cards WHERE owner_id = ?1 AND card_id = ?2), 0
) - ${ACTIVE_ASSIGNMENT_COUNT}`;

function looseCopyAssertion(db: D1Database, ownerId: string, cardId: string): D1PreparedStatement {
  return db
    .prepare(
      `SELECT CASE WHEN ${LOOSE_COPIES} >= 1
        THEN 1 ELSE json_extract('collection_remove_no_loose_copies', '$') END AS valid`,
    )
    .bind(ownerId, cardId);
}

async function looseCopies(db: D1Database, ownerId: string, cardId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT ${LOOSE_COPIES} AS loose`)
    .bind(ownerId, cardId)
    .first<{ loose: number }>();
  return row?.loose ?? 0;
}

interface RemovablePocket {
  pageId: string;
  row: number;
  column: number;
  versionId: string;
  versionRevision: number;
  binderId: string;
}

const REMOVABLE_POCKET_WHERE = `slot.binder_page_id = ?1 AND slot.row_index = ?2
  AND slot.column_index = ?3 AND slot.assigned_card_id = ?4 AND binder.owner_id = ?5
  AND version.status = 'active' AND binder.active_version_id = version.id`;

// Only a pocket in the owner's current active version holds a physical copy:
// a draft is a plan and an archived version is history, so clearing either
// would decrement inventory while the real pocket stays assigned.
async function removablePocket(
  db: D1Database,
  ownerId: string,
  cardId: string,
  slotId: string,
): Promise<RemovablePocket | null> {
  const decoded = decodeSlotId(slotId);
  if (!decoded) return null;
  const row = await db
    .prepare(
      `SELECT version.id AS version_id, version.revision, binder.id AS binder_id
       FROM binder_slots slot
       JOIN binder_pages page ON page.id = slot.binder_page_id
       JOIN binder_versions version ON version.id = page.binder_version_id
       JOIN binders binder ON binder.id = version.binder_id
       WHERE ${REMOVABLE_POCKET_WHERE}`,
    )
    .bind(decoded.pageId, decoded.row, decoded.column, cardId, ownerId)
    .first<{ version_id: string; revision: number; binder_id: string }>();
  if (!row) return null;
  return {
    pageId: decoded.pageId,
    row: decoded.row,
    column: decoded.column,
    versionId: row.version_id,
    versionRevision: row.revision,
    binderId: row.binder_id,
  };
}

function removablePocketAssertion(
  db: D1Database,
  ownerId: string,
  cardId: string,
  pocket: RemovablePocket,
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT CASE WHEN EXISTS (
          SELECT 1 FROM binder_slots slot
          JOIN binder_pages page ON page.id = slot.binder_page_id
          JOIN binder_versions version ON version.id = page.binder_version_id
          JOIN binders binder ON binder.id = version.binder_id
          WHERE ${REMOVABLE_POCKET_WHERE} AND version.id = ?6 AND version.revision = ?7
        ) THEN 1 ELSE json_extract('collection_remove_slot_not_found', '$') END AS valid`,
    )
    .bind(
      pocket.pageId,
      pocket.row,
      pocket.column,
      cardId,
      ownerId,
      pocket.versionId,
      pocket.versionRevision,
    );
}

function decrementStatement(
  db: D1Database,
  ownerId: string,
  cardId: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE collection_cards SET quantity = quantity - 1, revision = revision + 1, updated_at = ?1
       WHERE owner_id = ?2 AND card_id = ?3 AND quantity > 0`,
    )
    .bind(now, ownerId, cardId);
}

async function removedState(
  db: D1Database,
  ownerId: string,
  cardId: string,
): Promise<CollectionState> {
  const updated = await getCollectionState(db, ownerId, cardId);
  if (!updated) throw new CollectionDomainError('collection_not_found');
  return updated;
}

async function removeLooseCopy(
  db: D1Database,
  ownerId: string,
  cardId: string,
  current: CollectionState,
  source: 'loose' | 'miscount',
  now: number,
): Promise<CollectionState> {
  try {
    await db.batch([
      looseCopyAssertion(db, ownerId, cardId),
      collectionRevisionAssertion(db, ownerId, cardId, current),
      decrementStatement(db, ownerId, cardId, now),
      eventInsert(db, ownerId, cardId, -1, source, now),
    ]);
  } catch (error) {
    // The batch rolled back; re-read to say why. A miscount only chose the
    // loose pile because one existed a moment ago, so losing that race is a
    // conflict to retry rather than a "nothing loose" answer.
    if ((await looseCopies(db, ownerId, cardId)) < 1)
      throw new CollectionDomainError(
        source === 'loose' ? 'collection_remove_no_loose_copies' : 'collection_revision_conflict',
      );
    const latest = await getCollectionState(db, ownerId, cardId);
    if (latest?.revision !== current.revision || latest.quantity !== current.quantity)
      throw new CollectionDomainError('collection_revision_conflict');
    throw error;
  }
  return removedState(db, ownerId, cardId);
}

async function removePocketCopy(
  db: D1Database,
  ownerId: string,
  cardId: string,
  current: CollectionState,
  slotId: string,
  source: 'pocket' | 'miscount',
  now: number,
): Promise<CollectionState> {
  // Scoped by owner: a slotId is just an opaque page/row/column encoding, so
  // without the binder-ownership join a guessed or observed slotId from
  // another owner's binder would blank *their* slot.
  const pocket = await removablePocket(db, ownerId, cardId, slotId);
  if (!pocket) throw new CollectionDomainError('collection_remove_slot_not_found');
  try {
    await db.batch([
      removablePocketAssertion(db, ownerId, cardId, pocket),
      collectionRevisionAssertion(db, ownerId, cardId, current),
      db
        .prepare(
          `UPDATE binder_slots SET assigned_card_id = NULL
           WHERE binder_page_id = ?1 AND row_index = ?2 AND column_index = ?3 AND assigned_card_id = ?4`,
        )
        .bind(pocket.pageId, pocket.row, pocket.column, cardId),
      decrementStatement(db, ownerId, cardId, now),
      // Emptying a pocket changes the layout, so it advances the version's
      // revision like any binder edit: an arrange that read the old revision
      // must fail its own check instead of restoring the removed assignment.
      db
        .prepare('UPDATE binder_versions SET revision = revision + 1 WHERE id = ?1')
        .bind(pocket.versionId),
      db.prepare('UPDATE binders SET updated_at = ?1 WHERE id = ?2').bind(now, pocket.binderId),
      db
        .prepare(
          `INSERT INTO collection_events (id, owner_id, card_id, delta, source, slot_id, created_at)
           VALUES (?1, ?2, ?3, -1, ?4, ?5, ?6)`,
        )
        .bind(newId('event'), ownerId, cardId, source, slotId, now),
    ]);
  } catch (error) {
    const latest = await removablePocket(db, ownerId, cardId, slotId);
    if (!latest) throw new CollectionDomainError('collection_remove_slot_not_found');
    const state = await getCollectionState(db, ownerId, cardId);
    if (
      latest.versionRevision !== pocket.versionRevision ||
      state?.revision !== current.revision ||
      state.quantity !== current.quantity
    )
      throw new CollectionDomainError('collection_revision_conflict');
    throw error;
  }
  return removedState(db, ownerId, cardId);
}

/**
 * Removes exactly one copy from the owner's inventory, per the three sources
 * the UI offers when a stated quantity goes down (research.md: "lowering
 * copies always asks where the copy comes from"):
 *  - pocket: unassign a named pocket in an active binder and decrement, atomically.
 *  - loose: decrement an unassigned copy; refused when none are loose.
 *  - miscount: same as loose when one is loose; otherwise behaves like
 *    pocket, but requires the caller to say which pocket since any of them
 *    could be the miscounted one.
 */
export async function removeCollectionCopy(
  db: D1Database,
  ownerId: string,
  cardId: string,
  input: CollectionRemoveInput,
): Promise<CollectionState> {
  await requireCollectionCard(db, ownerId, cardId);
  const current = await getCollectionState(db, ownerId, cardId);
  if (!current || current.quantity <= 0)
    throw new CollectionDomainError('collection_quantity_out_of_bounds');
  const now = nowSeconds();

  if (input.source === 'pocket') {
    if (!input.slotId) throw new CollectionDomainError('collection_remove_slot_required');
    return removePocketCopy(db, ownerId, cardId, current, input.slotId, 'pocket', now);
  }

  const assigned = await assignedSlotsForCard(db, ownerId, cardId);
  const loose = current.quantity - assigned.length;

  if (input.source === 'loose') {
    if (loose <= 0) throw new CollectionDomainError('collection_remove_no_loose_copies');
    return removeLooseCopy(db, ownerId, cardId, current, 'loose', now);
  }

  // miscount: prefer taking it from the unassigned pile; only ask which
  // pocket when every copy is currently placed somewhere.
  if (loose > 0) return removeLooseCopy(db, ownerId, cardId, current, 'miscount', now);
  if (!input.slotId)
    throw new CollectionDomainError('collection_remove_slot_required', { candidates: assigned });
  if (!assigned.some((candidate) => candidate.slotId === input.slotId))
    throw new CollectionDomainError('collection_remove_slot_not_found');
  return removePocketCopy(db, ownerId, cardId, current, input.slotId, 'miscount', now);
}
