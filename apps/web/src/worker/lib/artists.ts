import { artistKey } from '@pokedex/shared';

export interface ArtistSpelling {
  name: string;
  cards: number;
}

/** The spelling to show: a capitalised one over an all-lower-case one, then the one on
 * the most cards, then the shortest (a doubled or suffixed spelling is always longer). */
export function preferredArtistName(spellings: readonly ArtistSpelling[]): string {
  const ranked = spellings.slice().sort((a, b) => {
    const capitalised =
      Number(b.name !== b.name.toLowerCase()) - Number(a.name !== a.name.toLowerCase());
    return (
      capitalised ||
      b.cards - a.cards ||
      a.name.length - b.name.length ||
      a.name.localeCompare(b.name)
    );
  });
  const first = ranked[0];
  if (!first) throw new Error('preferredArtistName needs at least one spelling');
  return first.name;
}

/** Every stored spelling of the illustrator `name` belongs to, for an exact-match filter. */
export async function artistSpellings(db: D1Database, name: string): Promise<string[]> {
  const key = artistKey(name);
  const result = await db
    .prepare(
      `SELECT DISTINCT artist FROM catalogue_cards
       WHERE artist IS NOT NULL AND trim(artist) <> ''`,
    )
    .all<{ artist: string }>();
  const matches = result.results
    .map((row) => row.artist)
    .filter((artist) => artistKey(artist) === key);
  return matches.length > 0 ? matches : [name];
}
