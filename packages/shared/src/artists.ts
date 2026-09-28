/**
 * TCGdex spells some illustrators several ways: stray or doubled quotes, different
 * case, a missing space, a name printed twice, or a romanised name followed by the
 * same name in Japanese. Every spelling of one person shares this key: letters and
 * digits only, accents folded, lower case, and a name printed twice counts once.
 */
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
