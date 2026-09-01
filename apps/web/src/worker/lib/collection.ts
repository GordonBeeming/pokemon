import {
  cardIdSchema,
  collectionStateSchema,
  type CollectionIncrementRequest,
  type CollectionMutationResult,
  type CollectionNotesPatchRequest,
  type CollectionSetRequest,
  type CollectionState,
} from '@pokedex/shared';
import { isoFromSeconds, nowSeconds } from './db';

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
  | 'invalid_stored_mutation';

export interface ActiveBinderAssignmentLocation {
  binderId: string;
  versionId: string;
  page: number;
  row: number;
  column: number;
}

export class CollectionDomainError extends Error {
  constructor(
    public readonly code: CollectionErrorCode,
    public readonly details?: { activeAssignments: ActiveBinderAssignmentLocation[] },
  ) {
    super(code);
    this.name = 'CollectionDomainError';
  }
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

async function requireCollectionCard(db: D1Database, cardId: string): Promise<void> {
  const card = await db
    .prepare('SELECT id FROM catalogue_cards WHERE id = ?1')
    .bind(cardId)
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

async function commitMutation(
  db: D1Database,
  ownerId: string,
  cardId: string,
  mutationId: string,
  hash: string,
  update: D1PreparedStatement,
  conflict: CollectionErrorCode,
): Promise<CollectionMutationResult> {
  const previous = await readMutation(db, ownerId, mutationId);
  if (previous) return replay(previous, hash);
  const now = nowSeconds();
  try {
    const results = await db.batch<MutationRow>([
      update,
      mutationInsert(db, ownerId, cardId, mutationId, hash, now),
      db
        .prepare(
          'SELECT request_hash, response_json FROM collection_mutations WHERE owner_id = ?1 AND mutation_id = ?2',
        )
        .bind(ownerId, mutationId),
    ]);
    const inserted = results[1]?.meta.changes ?? 0;
    const stored = results[2]?.results.at(0);
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
  await requireCollectionCard(db, input.cardId);
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

export async function incrementCollectionQuantity(
  db: D1Database,
  ownerId: string,
  input: CollectionIncrementMutation,
): Promise<CollectionMutationResult> {
  await requireCollectionCard(db, input.cardId);
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
  );
}

export async function patchCollectionNotes(
  db: D1Database,
  ownerId: string,
  input: CollectionNotesPatchMutation,
): Promise<CollectionMutationResult> {
  await requireCollectionCard(db, input.cardId);
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
