import { cardIdSchema, collectionStateSchema, type CollectionState } from '@pokedex/shared';
import { isoFromSeconds, nowSeconds, requireCard } from './db';

interface CollectionRow {
  card_id: string;
  quantity: number;
  notes: string | null;
  updated_at: number;
}

interface MutationRow {
  response_json: string;
}

export interface CollectionMutation {
  cardId: string;
  quantity: number;
  notes: string | null;
  mutationId: string;
}

function toState(row: CollectionRow): CollectionState {
  return {
    cardId: cardIdSchema.parse(row.card_id),
    quantity: row.quantity,
    notes: row.notes,
    updatedAt: isoFromSeconds(row.updated_at),
  };
}

function readStoredState(value: string): CollectionState | null {
  const parsed = collectionStateSchema.safeParse(JSON.parse(value));
  return parsed.success ? parsed.data : null;
}

export async function getCollectionState(
  db: D1Database,
  ownerId: string,
  cardId: string,
): Promise<CollectionState | null> {
  const row = await db
    .prepare(
      'SELECT card_id, quantity, notes, updated_at FROM collection_cards WHERE owner_id = ?1 AND card_id = ?2',
    )
    .bind(ownerId, cardId)
    .first<CollectionRow>();
  return row ? toState(row) : null;
}

export async function setCollectionState(
  db: D1Database,
  ownerId: string,
  input: CollectionMutation,
): Promise<{ state: CollectionState; replayed: boolean }> {
  await requireCard(db, input.cardId);
  const previous = await db
    .prepare(
      'SELECT response_json FROM collection_mutations WHERE owner_id = ?1 AND mutation_id = ?2',
    )
    .bind(ownerId, input.mutationId)
    .first<MutationRow>();
  if (previous) {
    const state = readStoredState(previous.response_json);
    if (!state) throw new Error('invalid_stored_mutation');
    return { state, replayed: true };
  }
  const now = nowSeconds();
  const state: CollectionState = {
    cardId: cardIdSchema.parse(input.cardId),
    quantity: input.quantity,
    notes: input.notes,
    updatedAt: isoFromSeconds(now),
  };
  try {
    await db.batch([
      db
        .prepare(
          'INSERT INTO collection_mutations (owner_id, mutation_id, card_id, response_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5)',
        )
        .bind(ownerId, input.mutationId, input.cardId, JSON.stringify(state), now),
      db
        .prepare(
          `INSERT INTO collection_cards (owner_id, card_id, quantity, notes, revision, updated_at)
           VALUES (?1, ?2, ?3, ?4, 1, ?5)
           ON CONFLICT(owner_id, card_id) DO UPDATE SET quantity = excluded.quantity,
            notes = excluded.notes, revision = collection_cards.revision + 1, updated_at = excluded.updated_at`,
        )
        .bind(ownerId, input.cardId, input.quantity, input.notes, now),
    ]);
  } catch (error) {
    const replay = await db
      .prepare(
        'SELECT response_json FROM collection_mutations WHERE owner_id = ?1 AND mutation_id = ?2',
      )
      .bind(ownerId, input.mutationId)
      .first<MutationRow>();
    const replayState = replay ? readStoredState(replay.response_json) : null;
    if (!replayState) throw error;
    return { state: replayState, replayed: true };
  }
  return { state, replayed: false };
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
