import {
  cardIdSchema,
  frameTypeFor,
  NATIONAL_POKEDEX_SIZE,
  rarityKeyFor,
  type CardCategory,
  type Illustrator,
} from '@pokedex/shared';
import { artistKey, preferredArtistName } from './artists';
import { cardTypes } from './catalogue';
import { getFavoriteIllustrators } from './settings';

interface IllustratorRow {
  artist: string;
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
  representative_owned: number;
}

function boundedPokedexNumber(value: number | null): number | null {
  return value !== null && Number.isInteger(value) && value >= 1 && value <= NATIONAL_POKEDEX_SIZE
    ? value
    : null;
}

/**
 * Every illustrator across active, non-custom catalogue cards (spellings of one person
 * merged), with this owner's counts and a deterministic representative card (their
 * owned card when they own one, otherwise the artist's card with art that sorts first:
 * newest set, lowest number within it), so the grid never reshuffles between loads.
 *
 * One query: a window function ranks each artist's cards per owner in a single pass
 * over catalogue_cards rather than a representative lookup per artist (~408 artists,
 * ~21k cards).
 */
export async function listIllustrators(db: D1Database, ownerId: string): Promise<Illustrator[]> {
  const favorites = await getFavoriteIllustrators(db, ownerId);
  const result = await db
    .prepare(
      `WITH coverage AS (
         SELECT c.artist,
           COUNT(*) AS total_cards,
           COUNT(CASE WHEN COALESCE(cc.quantity, 0) > 0 THEN 1 END) AS owned_cards
         FROM catalogue_cards c
         LEFT JOIN collection_cards cc ON cc.card_id = c.id AND cc.owner_id = ?1
         WHERE c.is_active = 1 AND c.is_custom = 0
           AND c.artist IS NOT NULL AND trim(c.artist) <> ''
           AND (c.owner_id IS NULL OR c.owner_id = ?1)
         GROUP BY c.artist
       ), ranked AS (
         SELECT c.artist, c.id, c.name, c.number, c.rarity, c.pokedex_number,
           c.category, c.subtype, c.types,
           COALESCE(set_meta.abbreviation, upper(c.set_id)) AS set_code,
           low.object_key AS low_key,
           c.has_tcgdex_source,
           CASE WHEN COALESCE(cc.quantity, 0) > 0 THEN 1 ELSE 0 END AS representative_owned,
           ROW_NUMBER() OVER (
             PARTITION BY c.artist
             ORDER BY
               CASE WHEN COALESCE(cc.quantity, 0) > 0 THEN 0 ELSE 1 END,
               -- Cached art first: a TCGdex source alone doesn't mean TCGdex has a scan
               -- (a brand-new set has cards long before it has images).
               CASE WHEN low.object_key IS NOT NULL THEN 0
                 WHEN c.has_tcgdex_source = 1 THEN 1 ELSE 2 END,
               CASE WHEN set_meta.release_date IS NULL THEN 1 ELSE 0 END,
               set_meta.release_date DESC,
               c.set_name,
               CASE WHEN c.number_sort IS NULL THEN 1 ELSE 0 END,
               c.number_sort,
               c.number, c.id
           ) AS rank
         FROM (
           -- A per-card EXISTS on card_sources(card_id); joining a DISTINCT list of every
           -- tcgdex card instead makes SQLite scan that list once per card.
           SELECT c.*, EXISTS (
             SELECT 1 FROM card_sources s
             WHERE s.card_id = c.id AND s.provider = 'tcgdex' AND s.active = 1
           ) AS has_tcgdex_source
           FROM catalogue_cards c
           WHERE c.is_active = 1 AND c.is_custom = 0
             AND c.artist IS NOT NULL AND trim(c.artist) <> ''
             AND (c.owner_id IS NULL OR c.owner_id = ?1)
         ) c
         LEFT JOIN collection_cards cc ON cc.card_id = c.id AND cc.owner_id = ?1
         LEFT JOIN catalogue_sets set_meta ON set_meta.set_id = c.set_id AND set_meta.language = c.language
         LEFT JOIN art_manifest low ON low.card_id = c.id AND low.variant = 'low'
       )
       SELECT coverage.artist, coverage.total_cards, coverage.owned_cards,
         ranked.id, ranked.name, ranked.number, ranked.rarity, ranked.pokedex_number,
         ranked.category, ranked.subtype, ranked.types, ranked.set_code, ranked.low_key,
         ranked.has_tcgdex_source, ranked.representative_owned
       FROM coverage
       JOIN ranked ON ranked.artist = coverage.artist AND ranked.rank = 1
       ORDER BY coverage.artist COLLATE NOCASE`,
    )
    .bind(ownerId)
    .all<IllustratorRow>();
  // Rows are per stored spelling; spellings of the same person merge into one entry.
  const groups = new Map<string, IllustratorRow[]>();
  for (const row of result.results) {
    const key = artistKey(row.artist);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()]
    .map((rows) => illustratorFrom(rows, favorites))
    .sort((a, b) => a.name.localeCompare(b.name, 'en-AU', { sensitivity: 'base' }));
}

function illustratorFrom(rows: readonly IllustratorRow[], favorites: Set<string>): Illustrator {
  const name = preferredArtistName(
    rows.map((row) => ({ name: row.artist, cards: row.total_cards })),
  );
  // Each row carries its own spelling's best card; the group keeps the best of those
  // by the same rule (owned, then cached art, then the spelling with the most cards).
  const artRank = (row: IllustratorRow) => (row.low_key ? 2 : row.has_tcgdex_source === 1 ? 1 : 0);
  const hasArt = (row: IllustratorRow) => artRank(row) > 0;
  const row = rows
    .slice()
    .sort(
      (a, b) =>
        b.representative_owned - a.representative_owned ||
        artRank(b) - artRank(a) ||
        b.total_cards - a.total_cards ||
        a.id.localeCompare(b.id),
    )[0];
  if (!row) throw new Error('an illustrator group always has at least one row');
  return {
    name,
    cardCount: rows.reduce((sum, entry) => sum + entry.total_cards, 0),
    ownedCount: rows.reduce((sum, entry) => sum + entry.owned_cards, 0),
    favorite: rows.some((entry) => favorites.has(entry.artist)) || favorites.has(name),
    representative: {
      id: cardIdSchema.parse(row.id),
      name: row.name,
      imageLowUrl: hasArt(row) ? `/api/art/${encodeURIComponent(row.id)}/low` : null,
      frameType: frameTypeFor({
        category: row.category,
        types: cardTypes(row),
        subtype: row.subtype,
        name: row.name,
      }),
      setCode: row.set_code,
      number: row.number,
      rarityKey: rarityKeyFor(row.rarity),
      pokedexNumber: boundedPokedexNumber(row.pokedex_number),
    },
  };
}
