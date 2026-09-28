import {
  NATIONAL_POKEDEX,
  type BinderPokemonShortage,
  type BinderShortage,
  type CardId,
  type DashboardBinderProgress,
  type DashboardStillToFindItem,
} from '@pokedex/shared';
import { getBinderPlannerSummary, listBinders } from './binders';
import { resolveCatalogueCards } from './catalogue';

/**
 * Per-binder progress for Home's binder-progress list, using the exact same
 * "placed = a copy assigned" rule the binder page itself reports
 * (getBinderPlannerSummary). A binder with no active version yet (never
 * activated past its first draft) has nothing placed, so it reports as an
 * empty 0/0 row rather than being dropped from the list.
 */
export async function dashboardBinderProgress(
  db: D1Database,
  ownerId: string,
): Promise<DashboardBinderProgress[]> {
  const binders = await listBinders(db, ownerId);
  const rows: DashboardBinderProgress[] = [];
  for (const binder of binders) {
    if (!binder.activeVersionId) {
      rows.push({ id: binder.id, name: binder.name, targets: 0, placed: 0, percent: 0 });
      continue;
    }
    const summary = await getBinderPlannerSummary(db, ownerId, binder.activeVersionId);
    rows.push({
      id: binder.id,
      name: binder.name,
      targets: summary.targets,
      placed: summary.placed,
      percent: summary.targets > 0 ? Math.round((summary.placed / summary.targets) * 100) : 0,
    });
  }
  return rows;
}

const STILL_TO_FIND_LIMIT = 8;

interface ShortageBinder {
  binderId: string;
  binderName: string;
}

/**
 * The first (by binder name) active binder with an unassigned exact-card pocket for
 * each of the given cards. A target can be short across several binders at once —
 * activeBinderShortages already shares one owned pool across all of them for the
 * missing-count math — so this only answers "which binder" for display, it never
 * changes what counts as missing.
 */
async function exactCardShortageBinders(
  db: D1Database,
  ownerId: string,
  cardIds: string[],
): Promise<Map<string, ShortageBinder>> {
  if (cardIds.length === 0) return new Map();
  const placeholders = cardIds.map((_, index) => `?${index + 2}`).join(',');
  const result = await db
    .prepare(
      `SELECT slot.card_id AS target, binder.id AS binder_id, binder.name AS binder_name
       FROM binder_slots slot
       JOIN binder_pages page ON page.id = slot.binder_page_id
       JOIN binder_versions version ON version.id = page.binder_version_id
       JOIN binders binder ON binder.id = version.binder_id
       WHERE binder.owner_id = ?1 AND version.status = 'active' AND slot.entry_kind = 'exact-card'
         AND slot.assigned_card_id IS NULL AND slot.card_id IN (${placeholders})
       ORDER BY binder.name COLLATE NOCASE, page.position, slot.row_index, slot.column_index`,
    )
    .bind(ownerId, ...cardIds)
    .all<{ target: string; binder_id: string; binder_name: string }>();
  const map = new Map<string, ShortageBinder>();
  for (const row of result.results)
    if (!map.has(row.target))
      map.set(row.target, { binderId: row.binder_id, binderName: row.binder_name });
  return map;
}

/** Same lookup as exactCardShortageBinders, for any-printing Pokémon targets. */
async function pokemonShortageBinders(
  db: D1Database,
  ownerId: string,
  pokemonNumbers: number[],
): Promise<Map<number, ShortageBinder>> {
  if (pokemonNumbers.length === 0) return new Map();
  const placeholders = pokemonNumbers.map((_, index) => `?${index + 2}`).join(',');
  const result = await db
    .prepare(
      `SELECT slot.pokemon_number AS target, binder.id AS binder_id, binder.name AS binder_name
       FROM binder_slots slot
       JOIN binder_pages page ON page.id = slot.binder_page_id
       JOIN binder_versions version ON version.id = page.binder_version_id
       JOIN binders binder ON binder.id = version.binder_id
       WHERE binder.owner_id = ?1 AND version.status = 'active' AND slot.entry_kind = 'pokemon'
         AND slot.assigned_card_id IS NULL AND slot.pokemon_number IN (${placeholders})
       ORDER BY binder.name COLLATE NOCASE, page.position, slot.row_index, slot.column_index`,
    )
    .bind(ownerId, ...pokemonNumbers)
    .all<{ target: number; binder_id: string; binder_name: string }>();
  const map = new Map<number, ShortageBinder>();
  for (const row of result.results)
    if (!map.has(row.target))
      map.set(row.target, { binderId: row.binder_id, binderName: row.binder_name });
  return map;
}

/**
 * Home's "Still to find": the most useful next cards to hunt, picked from the same
 * active-binder shortages `GET /api/dashboard` already computes (activeShortages /
 * activePokemonShortages), ranked by how many copies are missing and capped to a
 * short list rather than the full report (that's `/api/dashboard/shortages`, still
 * reachable from the "All N" link).
 */
export async function dashboardStillToFind(
  db: D1Database,
  ownerId: string,
  shortages: BinderShortage[],
  pokemonShortages: BinderPokemonShortage[],
): Promise<DashboardStillToFindItem[]> {
  const combined: Array<
    | { kind: 'exact-card'; missing: number; cardId: CardId }
    | { kind: 'pokemon'; missing: number; pokemonNumber: number }
  > = [
    ...shortages.map((item) => ({
      kind: 'exact-card' as const,
      missing: item.missing,
      cardId: item.cardId,
    })),
    ...pokemonShortages.map((item) => ({
      kind: 'pokemon' as const,
      missing: item.missing,
      pokemonNumber: item.pokemonNumber,
    })),
  ];
  combined.sort((a, b) => b.missing - a.missing);
  const top = combined.slice(0, STILL_TO_FIND_LIMIT);

  const cardIds = top.flatMap((item) => (item.kind === 'exact-card' ? [item.cardId] : []));
  const pokemonNumbers = top.flatMap((item) =>
    item.kind === 'pokemon' ? [item.pokemonNumber] : [],
  );
  const [cards, cardBinders, pokemonBinders] = await Promise.all([
    resolveCatalogueCards(db, ownerId, cardIds),
    exactCardShortageBinders(db, ownerId, cardIds),
    pokemonShortageBinders(db, ownerId, pokemonNumbers),
  ]);
  const cardsById = new Map(cards.map((card) => [card.id, card]));

  return top.map((item) => {
    if (item.kind === 'exact-card') {
      const card = cardsById.get(item.cardId);
      const binder = cardBinders.get(item.cardId);
      return {
        kind: 'exact-card',
        label: card
          ? `${card.name} · ${card.setCode ?? card.setName} · ${card.number}`
          : item.cardId,
        cardId: item.cardId,
        pokemonNumber: null,
        missing: item.missing,
        binderId: binder?.binderId ?? null,
        binderName: binder?.binderName ?? null,
      };
    }
    const pokemon = NATIONAL_POKEDEX[item.pokemonNumber - 1];
    const binder = pokemonBinders.get(item.pokemonNumber);
    return {
      kind: 'pokemon',
      label: `#${String(item.pokemonNumber).padStart(4, '0')} ${pokemon?.name ?? 'Pokémon'}`,
      cardId: null,
      pokemonNumber: item.pokemonNumber,
      missing: item.missing,
      binderId: binder?.binderId ?? null,
      binderName: binder?.binderName ?? null,
    };
  });
}
