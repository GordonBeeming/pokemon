import {
  TRAINER_CHARACTERS,
  normalizedTrainerName,
  trainerDexResponseSchema,
} from '@pokedex/shared';
import { z } from 'zod';
import { ApplicationError } from './log';

const names = new Map<string, readonly string[]>();
const identities = new Map<string, readonly string[]>();
for (const character of TRAINER_CHARACTERS) {
  for (const alias of character.aliases)
    names.set(alias, [...(names.get(alias) ?? []), character.key]);
  for (const id of character.cardIds)
    identities.set(id, [...(identities.get(id) ?? []), character.key]);
}

/** Resolve names once per card rather than cross-joining every alias in D1. */
export function trainerCharactersForCard(name: string, sourceIds: readonly string[]): string[] {
  const normalized = normalizedTrainerName(name);
  const candidates = new Set([normalized, ...normalized.split(' & ')]);
  const possessive = normalized.indexOf("'s ");
  if (possessive >= 0) candidates.add(normalized.slice(0, possessive));
  for (const part of normalized.split(' & ')) {
    const owner = part.indexOf("'s ");
    if (owner >= 0) candidates.add(part.slice(0, owner));
  }
  for (const match of normalized.matchAll(/\(([^()]*)\)/g)) {
    const inner = match[1];
    if (inner) candidates.add(inner.trim());
  }
  const result = new Set<string>();
  for (const candidate of candidates) for (const key of names.get(candidate) ?? []) result.add(key);
  for (const id of sourceIds) for (const key of identities.get(id) ?? []) result.add(key);
  return [...result];
}
interface TrainerCard {
  id: string;
  name: string;
  number: string;
  set_name: string;
  rarity: string | null;
  quantity: number;
  low_key: string | null;
  source_ids: string;
}
const sourceIdsSchema = z.array(z.string().nullable());
function sources(card: TrainerCard): string[] {
  const parsed: unknown = JSON.parse(card.source_ids);
  return sourceIdsSchema.parse(parsed).filter((id): id is string => id !== null);
}

async function* visibleTrainerCards(db: D1Database, ownerId: string, characterKey?: string) {
  const character = characterKey
    ? TRAINER_CHARACTERS.find((t) => t.key === characterKey)
    : undefined;
  if (characterKey && !character) throw new ApplicationError('invalid_filter', 400);
  const values: (string | number)[] = [ownerId];
  let candidateFilter = '';
  if (character) {
    // Names in a TAG TEAM or parenthetical title need not lead the card name.
    const initials = [...new Set(character.aliases.map((alias) => alias.charAt(0)))];
    values.push(JSON.stringify(initials), JSON.stringify(character.cardIds));
    candidateFilter = `AND (substr(lower(replace(replace(trim(c.name),'’',char(39)),'.','')),1,1) IN(SELECT value FROM json_each(?2))
      OR instr(c.name,' & ')>0 OR instr(c.name,'(')>0 OR c.name GLOB '[^A-Za-z]*'
      OR c.id IN(SELECT s.card_id FROM card_sources s WHERE s.provider='tcgdex' AND s.source_id IN(SELECT value FROM json_each(?3))))`;
  }
  const cursorParameter = values.length + 1;
  let cursor = '';
  while (true) {
    // Migration 002 supplies the card index. Production otherwise chooses a
    // provider-only index and scans every TCGdex source once per trainer.
    const rows = await db
      .prepare(
        `SELECT c.id,c.name,c.number,c.set_name,c.rarity,
    COALESCE(cc.quantity,0) AS quantity,art.object_key AS low_key,
    json_group_array(DISTINCT source.source_id) AS source_ids
    FROM catalogue_cards c
    LEFT JOIN collection_cards cc ON cc.card_id=c.id AND cc.owner_id=?1
    LEFT JOIN art_manifest art ON art.card_id=c.id AND art.variant='low'
    LEFT JOIN card_sources source INDEXED BY idx_card_sources_card ON source.card_id=c.id AND source.provider='tcgdex'
    WHERE c.is_active=1 AND c.category='trainer' AND c.language='en'
      AND (c.owner_id IS NULL OR c.owner_id=?1) ${candidateFilter}
    AND c.id>?${cursorParameter}
    GROUP BY c.id ORDER BY c.id LIMIT 1000`,
      )
      .bind(...values, cursor)
      .all<TrainerCard>();
    for (const card of rows.results) yield card;
    const last = rows.results.at(-1);
    if (rows.results.length < 1000 || !last) return;
    cursor = last.id;
  }
}

export async function trainerCharacterCardIds(
  db: D1Database,
  ownerId: string,
  key: string,
): Promise<string[]> {
  const ids: string[] = [];
  for await (const card of visibleTrainerCards(db, ownerId, key)) {
    if (trainerCharactersForCard(card.name, sources(card)).includes(key)) ids.push(card.id);
  }
  return ids;
}
function fullArt(card: TrainerCard): boolean {
  return /illustration|ultra|full art/i.test(card.rarity ?? '');
}
function preferred(candidate: TrainerCard, current: TrainerCard): boolean {
  if (candidate.quantity > 0 !== current.quantity > 0) return candidate.quantity > 0;
  if (fullArt(candidate) !== fullArt(current)) return fullArt(candidate);
  const byName = candidate.name.localeCompare(current.name, 'en-AU');
  if (byName !== 0) return byName < 0;
  return candidate.id < current.id;
}
export async function listTrainerDex(db: D1Database, ownerId: string) {
  const counts = new Map<
    string,
    { total: number; owned: number; representative: TrainerCard; hasArt: boolean }
  >();
  for await (const card of visibleTrainerCards(db, ownerId)) {
    const sourceIds = sources(card);
    for (const key of trainerCharactersForCard(card.name, sourceIds)) {
      const current = counts.get(key);
      if (!current)
        counts.set(key, {
          total: 1,
          owned: card.quantity > 0 ? 1 : 0,
          representative: card,
          hasArt: card.low_key !== null || sourceIds.length > 0,
        });
      else {
        current.total++;
        if (card.quantity > 0) current.owned++;
        if (preferred(card, current.representative)) {
          current.representative = card;
          current.hasArt = card.low_key !== null || sourceIds.length > 0;
        }
      }
    }
  }
  return trainerDexResponseSchema.parse({
    trainers: TRAINER_CHARACTERS.map((character) => {
      const found = counts.get(character.key);
      const card = found?.representative;
      return {
        key: character.key,
        name: character.name,
        regions: character.regions,
        cardCount: found?.total ?? 0,
        ownedCount: found?.owned ?? 0,
        representative: card
          ? {
              id: card.id,
              name: card.name,
              number: card.number,
              setName: card.set_name,
              imageLowUrl: found?.hasArt ? `/api/art/${encodeURIComponent(card.id)}/low` : null,
              owned: card.quantity > 0,
            }
          : null,
      };
    }),
  });
}
