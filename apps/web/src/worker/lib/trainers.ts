import { trainerOf, type Trainer } from '@pokedex/shared';
import { groupRepresentative, rankedGroups } from './groups';
import { getFavorites } from './settings';

/** Every trainer with Pokémon in the catalogue, with this owner's counts and favourites. */
export async function listTrainers(db: D1Database, ownerId: string): Promise<Trainer[]> {
  const [rows, favorites] = await Promise.all([
    rankedGroups(db, ownerId, 'trainer'),
    getFavorites(db, ownerId, 'trainers'),
  ]);
  return rows
    .map((row) => ({
      key: row.group_key,
      name: trainerOf(row.sample_name)?.name ?? row.group_key,
      cardCount: row.total_cards,
      ownedCount: row.owned_cards,
      favorite: favorites.has(row.group_key),
      representative: groupRepresentative(row),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en-AU', { sensitivity: 'base' }));
}
