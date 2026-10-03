import {
  cardIdSchema,
  frameTypeFor,
  NATIONAL_POKEDEX_SIZE,
  rarityKeyFor,
  type CardCategory,
  type IllustratorRepresentative,
} from '@pokedex/shared';
import { cardTypes } from './catalogue';

export interface GroupRow {
  group_key: string;
  sample_name: string;
  total_cards: number;
  owned_cards: number;
  id: string;
  name: string;
  number: string;
  rarity: string | null;
  pokedex_number: number | null;
  category: CardCategory;
  subtype: string | null;
  types: string | null;
  set_code: string;
  low_key: string | null;
  has_tcgdex_source: number;
}

/** Which grouping to count: the SQL naming each card's group, and which cards have one. */
export type GroupBy = 'trainer' | 'set';

const GROUP_SQL: Record<GroupBy, { key: string; where: string }> = {
  trainer: { key: 'c.trainer_key', where: 'c.trainer_key IS NOT NULL' },
  set: { key: "c.language || ':' || c.set_id", where: '1 = 1' },
};

/**
 * Every group of active cards this owner can see, with owned/total and a deterministic
 * card to show for it: an owned card when there is one, then one with cached art, then
 * the newest set's lowest number. One pass with a window function, the same way the
 * illustrators list picks its cards.
 */
export async function rankedGroups(
  db: D1Database,
  ownerId: string,
  by: GroupBy,
): Promise<GroupRow[]> {
  const group = GROUP_SQL[by];
  const result = await db
    .prepare(
      `WITH cards AS (
         SELECT c.*, ${group.key} AS group_key, EXISTS (
           SELECT 1 FROM card_sources s
           WHERE s.card_id = c.id AND s.provider = 'tcgdex' AND s.active = 1
         ) AS has_tcgdex_source
         FROM catalogue_cards c
         WHERE c.is_active = 1 AND ${group.where}
           AND (c.owner_id IS NULL OR c.owner_id = ?1)
       ), coverage AS (
         SELECT c.group_key, MIN(c.name) AS sample_name, COUNT(*) AS total_cards,
           COUNT(CASE WHEN COALESCE(cc.quantity, 0) > 0 THEN 1 END) AS owned_cards
         FROM cards c
         LEFT JOIN collection_cards cc ON cc.card_id = c.id AND cc.owner_id = ?1
         GROUP BY c.group_key
       ), ranked AS (
         SELECT c.group_key, c.id, c.name, c.number, c.rarity, c.pokedex_number,
           c.category, c.subtype, c.types,
           COALESCE(set_meta.abbreviation, upper(c.set_id)) AS set_code,
           low.object_key AS low_key, c.has_tcgdex_source,
           ROW_NUMBER() OVER (
             PARTITION BY c.group_key
             ORDER BY
               CASE WHEN COALESCE(cc.quantity, 0) > 0 THEN 0 ELSE 1 END,
               CASE WHEN low.object_key IS NOT NULL THEN 0
                 WHEN c.has_tcgdex_source = 1 THEN 1 ELSE 2 END,
               CASE WHEN set_meta.release_date IS NULL THEN 1 ELSE 0 END,
               set_meta.release_date DESC,
               CASE WHEN c.number_sort IS NULL THEN 1 ELSE 0 END,
               c.number_sort, c.number, c.id
           ) AS rank
         FROM cards c
         LEFT JOIN collection_cards cc ON cc.card_id = c.id AND cc.owner_id = ?1
         LEFT JOIN catalogue_sets set_meta
           ON set_meta.set_id = c.set_id AND set_meta.language = c.language
         LEFT JOIN art_manifest low ON low.card_id = c.id AND low.variant = 'low'
       )
       SELECT coverage.group_key, coverage.sample_name, coverage.total_cards,
         coverage.owned_cards, ranked.id, ranked.name, ranked.number, ranked.rarity,
         ranked.pokedex_number, ranked.category, ranked.subtype, ranked.types,
         ranked.set_code, ranked.low_key, ranked.has_tcgdex_source
       FROM coverage JOIN ranked ON ranked.group_key = coverage.group_key AND ranked.rank = 1`,
    )
    .bind(ownerId)
    .all<GroupRow>();
  return result.results;
}

export function groupRepresentative(row: GroupRow): IllustratorRepresentative {
  const hasArt = row.low_key !== null || row.has_tcgdex_source === 1;
  return {
    id: cardIdSchema.parse(row.id),
    name: row.name,
    imageLowUrl: hasArt ? `/api/art/${encodeURIComponent(row.id)}/low` : null,
    frameType: frameTypeFor({
      category: row.category,
      types: cardTypes(row),
      subtype: row.subtype,
      name: row.name,
    }),
    setCode: row.set_code,
    number: row.number,
    rarityKey: rarityKeyFor(row.rarity),
    pokedexNumber:
      row.pokedex_number !== null &&
      Number.isInteger(row.pokedex_number) &&
      row.pokedex_number >= 1 &&
      row.pokedex_number <= NATIONAL_POKEDEX_SIZE
        ? row.pokedex_number
        : null,
  };
}
