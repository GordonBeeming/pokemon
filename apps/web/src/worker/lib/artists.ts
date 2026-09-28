/**
 * TCGdex spells some illustrators several ways: stray or doubled quotes, different
 * case, a missing space, a name printed twice, or a romanised name followed by the
 * same name in Japanese. These helpers treat every spelling of one person as one
 * illustrator.
 */

/** Letters and digits only, accents folded, lower case; a name printed twice counts once. */
export function artistKey(name: string): string {
  const folded = name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  // Latin letters and digits identify a romanised name even when the same name also
  // follows in another script; a name written only in another script keeps its letters.
  const latin = folded.replace(/[^a-z0-9]/gu, '');
  const key = latin || folded.replace(/[^\p{L}\p{N}]/gu, '');
  const half = key.length / 2;
  return key.length > 0 && key.length % 2 === 0 && key.slice(0, half) === key.slice(half)
    ? key.slice(0, half)
    : key;
}

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
