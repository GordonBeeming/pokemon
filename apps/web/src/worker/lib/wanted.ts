import { GALLERY_PAGE_SIZE } from '@pokedex/shared';
import {
  NATIONAL_POKEDEX,
  wantedListSchema,
  wantedScopesSchema,
  type WantedQuery,
  type CatalogueCardView,
} from '@pokedex/shared';
import { nowSeconds } from './db';
import { ApplicationError } from './log';
import { resolveCatalogueCards } from './catalogue';

async function requireCard(db: D1Database, ownerId: string, cardId: string) {
  const card = await db
    .prepare('SELECT id FROM catalogue_cards WHERE id=?1 AND (owner_id IS NULL OR owner_id=?2)')
    .bind(cardId, ownerId)
    .first();
  if (!card) throw new ApplicationError('card_not_found', 404);
}
async function requireBinder(db: D1Database, ownerId: string, scope: string) {
  if (scope === 'general' || scope === 'all') return;
  if (
    !(await db
      .prepare('SELECT id FROM binders WHERE id=? AND owner_id=?')
      .bind(scope, ownerId)
      .first())
  )
    throw new ApplicationError('binder_not_found', 404);
}
export async function wantedScopes(db: D1Database, ownerId: string, cardId: string) {
  await requireCard(db, ownerId, cardId);
  const rows = await db
    .prepare(
      `SELECT w.scope,b.name AS binderName,w.created_at AS createdAt FROM wanted_cards w LEFT JOIN binders b ON b.id=w.binder_id WHERE w.owner_id=?1 AND w.card_id=?2 ORDER BY w.created_at DESC,w.scope`,
    )
    .bind(ownerId, cardId)
    .all();
  return wantedScopesSchema.parse(rows.results);
}
export async function setWanted(
  db: D1Database,
  ownerId: string,
  cardId: string,
  binderId: string | null,
  wanted: boolean,
) {
  await requireCard(db, ownerId, cardId);
  if (binderId) {
    if (binderId === 'general' || binderId === 'all')
      throw new ApplicationError('binder_not_found', 404);
    await requireBinder(db, ownerId, binderId);
  }
  const scope = binderId ?? 'general';
  if (wanted)
    await db
      .prepare(
        `INSERT INTO wanted_cards(owner_id,scope,card_id,binder_id,created_at)
    SELECT ?1,?2,c.id,?3,?4 FROM catalogue_cards c WHERE c.id=?5 AND (c.owner_id IS NULL OR c.owner_id=?1)
    AND (?3 IS NULL OR EXISTS(SELECT 1 FROM binders b WHERE b.id=?3 AND b.owner_id=?1))
    ON CONFLICT(owner_id,scope,card_id) DO NOTHING`,
      )
      .bind(ownerId, scope, binderId, nowSeconds(), cardId)
      .run();
  else
    await db
      .prepare('DELETE FROM wanted_cards WHERE owner_id=? AND scope=? AND card_id=?')
      .bind(ownerId, scope, cardId)
      .run();
  return wantedScopes(db, ownerId, cardId);
}

const pokemonNames = JSON.stringify(
  NATIONAL_POKEDEX.map((p) => ({ number: p.number, name: p.name })),
);
const listing = `WITH pokemon AS (
 SELECT json_extract(value,'$.number') AS number,json_extract(value,'$.name') AS name FROM json_each(?5)
), raw AS (
 SELECT w.scope,w.binder_id,'exact-card' AS target_kind,w.card_id,NULL AS pokemon_number,
 'card:'||w.card_id AS target_key,NULL AS label,1 AS manual,0 AS unfilled,w.created_at
 FROM wanted_cards w WHERE w.owner_id=?1 AND (?2='all' OR w.scope=?2)
 UNION ALL
 SELECT b.id,b.id,CASE WHEN s.set_id IS NOT NULL THEN 'set' WHEN s.group_kind IS NOT NULL THEN s.group_kind WHEN s.energy_group IS NOT NULL THEN 'energy' ELSE s.entry_kind END,
 s.card_id,s.pokemon_number,
 CASE WHEN s.card_id IS NOT NULL THEN 'card:'||s.card_id WHEN s.pokemon_number IS NOT NULL THEN 'pokemon:'||s.pokemon_number WHEN s.set_id IS NOT NULL THEN 'set:'||s.set_id||':'||s.set_language WHEN s.group_kind IS NOT NULL THEN 'group:'||s.group_kind||':'||s.group_key ELSE 'energy:'||s.energy_group END,
 COALESCE(s.label,s.set_id,s.group_key,s.energy_group),0,1,0
 FROM binder_slots s JOIN binder_pages p ON p.id=s.binder_page_id
 JOIN binder_versions v ON v.id=p.binder_version_id JOIN binders b ON b.active_version_id=v.id
 WHERE ?3=1 AND ?2 NOT IN ('all','general') AND b.owner_id=?1 AND (?2='all' OR b.id=?2) AND s.assigned_card_id IS NULL AND s.ordered_card_id IS NULL
 AND (s.entry_kind IN ('exact-card','pokemon') OR s.set_id IS NOT NULL OR s.group_kind IS NOT NULL OR s.energy_group IS NOT NULL)
), grouped AS (
 SELECT scope,MAX(binder_id) AS binder_id,MAX(target_kind) AS target_kind,MAX(card_id) AS card_id,MAX(pokemon_number) AS pokemon_number,target_key,MAX(label) AS label,MAX(manual) AS manual,SUM(unfilled) AS unfilled,MAX(created_at) AS created_at
 FROM raw GROUP BY scope,target_key
), placements AS MATERIALIZED (
 SELECT COALESCE(s.assigned_card_id,s.ordered_card_id) AS card_id,b.id AS binder_id,SUM(CASE WHEN s.assigned_card_id IS NOT NULL THEN 1 ELSE 0 END) AS n,SUM(CASE WHEN s.ordered_card_id IS NOT NULL THEN 1 ELSE 0 END) AS orders
 FROM binder_slots s JOIN binder_pages p ON p.id=s.binder_page_id
 JOIN binder_versions v ON v.id=p.binder_version_id JOIN binders b ON b.active_version_id=v.id
 WHERE b.owner_id=?1 AND (s.assigned_card_id IS NOT NULL OR s.ordered_card_id IS NOT NULL) GROUP BY COALESCE(s.assigned_card_id,s.ordered_card_id),b.id
), placed_any AS (SELECT card_id,SUM(n) AS n,SUM(orders) AS orders FROM placements GROUP BY card_id), entries AS (
 SELECT g.scope||':'||g.target_key AS key,g.scope,g.binder_id AS binderId,b.name AS binderName,g.card_id AS cardId,
 COALESCE(c.name,pk.name,g.label,'Unavailable card') AS name,c.set_name AS setName,c.number,c.language,
 COALESCE(c.pokedex_number,g.pokemon_number) AS pokedexNumber,g.manual,g.unfilled,g.created_at AS createdAt,g.target_kind AS targetKind,
 COALESCE(cc.quantity,0) AS ownedQuantity,
 COALESCE(CASE WHEN g.binder_id IS NULL THEN pa.n ELSE pb.n END,0) AS placedCount,
 COALESCE(CASE WHEN g.binder_id IS NULL THEN pa.orders ELSE pb.orders END,0) AS orderedCount,
 CASE WHEN art.card_id IS NOT NULL OR EXISTS(SELECT 1 FROM card_sources src WHERE src.card_id=preview.id AND src.provider='tcgdex') THEN preview.id ELSE NULL END AS artCardId
 FROM grouped g LEFT JOIN binders b ON b.id=g.binder_id AND b.owner_id=?1
 LEFT JOIN catalogue_cards c ON c.id=g.card_id AND (c.owner_id IS NULL OR c.owner_id=?1)
 LEFT JOIN placements pb ON pb.card_id=g.card_id AND pb.binder_id=g.binder_id
 LEFT JOIN placed_any pa ON pa.card_id=g.card_id
 LEFT JOIN pokemon pk ON pk.number=g.pokemon_number
 LEFT JOIN collection_cards cc ON cc.owner_id=?1 AND cc.card_id=c.id
 LEFT JOIN species_representatives representative ON representative.owner_id=?1 AND representative.pokedex_number=g.pokemon_number
 LEFT JOIN catalogue_cards preview ON preview.id=COALESCE(c.id,representative.card_id) AND (preview.owner_id IS NULL OR preview.owner_id=?1)
 LEFT JOIN art_manifest art ON art.card_id=preview.id AND art.variant='low'
 WHERE (g.binder_id IS NULL OR b.id IS NOT NULL) AND (g.card_id IS NULL OR c.id IS NOT NULL)
), filtered AS (
 SELECT * FROM entries WHERE instr(lower(name||' '||COALESCE(setName,'')||' '||COALESCE(number,'')||' '||COALESCE(binderName,'')),lower(?4))>0
 AND (?6='all' OR (?6='placed' AND placedCount>0) OR (?6='not-placed' AND placedCount=0) OR (?6='ordered' AND orderedCount>0))
)`;
export async function listWanted(db: D1Database, ownerId: string, query: WantedQuery) {
  await requireBinder(db, ownerId, query.scope);
  const values = [
    ownerId,
    query.scope,
    query.includeUnfilled ? 1 : 0,
    query.q,
    pokemonNames,
    query.placement,
  ];
  const total = await db
    .prepare(`${listing} SELECT COUNT(*) AS total FROM filtered`)
    .bind(...values)
    .first<{ total: number }>();
  const order = {
    name: 'name COLLATE NOCASE,key',
    newest: 'createdAt DESC,name COLLATE NOCASE,key',
    pokedex: 'pokedexNumber IS NULL,pokedexNumber,name COLLATE NOCASE,key',
    set: 'setName IS NULL,setName COLLATE NOCASE,number,name COLLATE NOCASE,key',
  }[query.sort];
  const rows = await db
    .prepare(
      `${listing} SELECT * FROM filtered ORDER BY ${order} LIMIT ${GALLERY_PAGE_SIZE} OFFSET ?7`,
    )
    .bind(...values, query.offset)
    .all<{
      key: string;
      scope: string;
      binderId: string | null;
      binderName: string | null;
      cardId: string | null;
      name: string;
      setName: string | null;
      number: string | null;
      language: string | null;
      pokedexNumber: number | null;
      manual: number;
      unfilled: number;
      createdAt: number;
      targetKind: string;
      ownedQuantity: number;
      placedCount: number;
      orderedCount: number;
      artCardId: string | null;
    }>();
  const cardIds = [...new Set(rows.results.flatMap((row) => (row.cardId ? [row.cardId] : [])))];
  const cards = new Map<string, CatalogueCardView>(
    (await resolveCatalogueCards(db, ownerId, cardIds, true)).map((card) => [card.id, card]),
  );
  const count = total?.total ?? 0;
  return wantedListSchema.parse({
    entries: rows.results.map(({ artCardId, manual, ...row }) => ({
      ...row,
      card: row.cardId ? (cards.get(row.cardId) ?? null) : null,
      manual: manual === 1,
      imageLowUrl: artCardId ? `/api/art/${encodeURIComponent(artCardId)}/low` : null,
    })),
    total: count,
    nextOffset:
      query.offset + rows.results.length < count ? query.offset + rows.results.length : null,
  });
}
