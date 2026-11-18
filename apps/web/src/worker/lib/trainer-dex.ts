import {
  TRAINER_CHARACTERS,
  trainerDexResponseSchema,
  type TrainerCharacter,
} from '@pokedex/shared';
import { ApplicationError } from './log';

const normalizedName = "lower(replace(replace(c.name,'’',char(39)),'.',''))";
function nameMatch(name: string) {
  return `(${name}=a.value
 OR ${name} LIKE a.value||char(39)||'s %'
 OR ${name} LIKE a.value||' & %'
 OR ${name} LIKE '% & '||a.value
 OR ${name} LIKE '% & '||a.value||' & %'
 OR instr(${name},'('||a.value||')')>0)`;
}
export function trainerCharacterPredicate(key: string, values: unknown[]): string {
  const character = TRAINER_CHARACTERS.find((t) => t.key === key);
  if (!character) throw new ApplicationError('invalid_filter', 400);
  const aliases = values.length + 1;
  values.push(JSON.stringify(character.aliases));
  const ids = values.length + 1;
  values.push(JSON.stringify(character.cardIds));
  return `(c.category='trainer' AND c.language='en' AND (EXISTS(SELECT 1 FROM json_each(?${aliases}) a WHERE ${nameMatch(normalizedName)}) OR EXISTS(SELECT 1 FROM card_sources identity WHERE identity.card_id=c.id AND identity.provider='tcgdex' AND identity.source_id IN(SELECT value FROM json_each(?${ids})))) )`;
}
const registry = JSON.stringify(
  TRAINER_CHARACTERS.map(({ key, aliases, cardIds }) => ({ key, aliases, cardIds })),
);
export async function listTrainerDex(db: D1Database, ownerId: string) {
  const rows = await db
    .prepare(
      `WITH registry AS MATERIALIZED (
 SELECT json_extract(value,'$.key') AS key,json_extract(value,'$.aliases') AS aliases,json_extract(value,'$.cardIds') AS card_ids FROM json_each(?2)
 ), cards AS MATERIALIZED (
 SELECT c.id,c.name,c.number,c.set_name,c.rarity,${normalizedName} AS normalized_name FROM catalogue_cards c WHERE c.is_active=1 AND c.category='trainer' AND c.language='en' AND (c.owner_id IS NULL OR c.owner_id=?1)
 ), aliases AS MATERIALIZED (
 SELECT r.key,a.value FROM registry r,json_each(r.aliases) a
 ), matches AS MATERIALIZED (
 SELECT a.key,c.id FROM aliases a JOIN cards c WHERE ${nameMatch('c.normalized_name')}
 UNION
 SELECT r.key,c.id FROM registry r JOIN json_each(r.card_ids) ids
 JOIN card_sources identity ON identity.provider='tcgdex' AND identity.source_id=ids.value
 JOIN cards c ON c.id=identity.card_id
 ), ranked AS (
 SELECT m.key,c.id,c.name,c.number,c.set_name,COALESCE(cc.quantity,0) AS quantity,
 CASE WHEN art.card_id IS NOT NULL OR EXISTS(SELECT 1 FROM card_sources source WHERE source.card_id=c.id AND source.provider='tcgdex') THEN 1 ELSE 0 END AS has_art,
 COUNT(*) OVER(PARTITION BY m.key) AS card_count,
 SUM(CASE WHEN COALESCE(cc.quantity,0)>0 THEN 1 ELSE 0 END) OVER(PARTITION BY m.key) AS owned_count,
 ROW_NUMBER() OVER(PARTITION BY m.key ORDER BY CASE WHEN COALESCE(cc.quantity,0)>0 THEN 0 ELSE 1 END,
 CASE WHEN lower(COALESCE(c.rarity,'')) LIKE '%illustration%' OR lower(COALESCE(c.rarity,'')) LIKE '%ultra%' OR lower(COALESCE(c.rarity,'')) LIKE '%full art%' THEN 0 ELSE 1 END,c.name,c.id) AS rank
 FROM matches m JOIN cards c ON c.id=m.id LEFT JOIN collection_cards cc ON cc.card_id=c.id AND cc.owner_id=?1 LEFT JOIN art_manifest art ON art.card_id=c.id AND art.variant='low'
 ) SELECT * FROM ranked WHERE rank=1`,
    )
    .bind(ownerId, registry)
    .all<{
      key: string;
      id: string;
      name: string;
      number: string;
      set_name: string;
      quantity: number;
      has_art: number;
      card_count: number;
      owned_count: number;
    }>();
  const byKey = new Map(rows.results.map((r) => [r.key, r]));
  return trainerDexResponseSchema.parse({
    trainers: TRAINER_CHARACTERS.map((character: TrainerCharacter) => {
      const r = byKey.get(character.key);
      return {
        key: character.key,
        name: character.name,
        regions: character.regions,
        cardCount: r?.card_count ?? 0,
        ownedCount: r?.owned_count ?? 0,
        representative: r
          ? {
              id: r.id,
              name: r.name,
              number: r.number,
              setName: r.set_name,
              imageLowUrl: r.has_art ? `/api/art/${encodeURIComponent(r.id)}/low` : null,
              owned: r.quantity > 0,
            }
          : null,
      };
    }),
  });
}
