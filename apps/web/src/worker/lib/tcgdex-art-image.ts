import { z } from 'zod';

const imageCardSchema = z
  .object({
    id: z.string().optional(),
    localId: z.string().optional(),
    image: z.string().nullable().optional(),
    set: z.object({ id: z.string() }).passthrough().optional(),
  })
  .passthrough();

const gallerySets = new Map<string, { parent: string; number: RegExp }>([
  ['swsh4.5sv', { parent: 'swsh4.5', number: /^SV\d{3}$/u }],
  ['swsh12.5gg', { parent: 'swsh12.5', number: /^GG\d{2}$/u }],
  ...['9', '10', '11', '12'].flatMap((set) => [
    [`swsh${set}tg`, { parent: `swsh${set}`, number: /^TG\d{2}$/u }] as const,
    [`swsh${set}.5tg`, { parent: `swsh${set}`, number: /^TG\d{2}$/u }] as const,
  ]),
]);

export function tcgdexArtImageBase(
  payload: unknown,
  sourceId: string,
  language: string,
): string | null {
  if (!/^[a-z]{2}(?:-[a-z]{2})?$/u.test(language)) return null;
  const parsed = imageCardSchema.safeParse(payload);
  if (!parsed.success) return null;
  const card = parsed.data;
  let image = card.image;
  if (!image) {
    const setId = card.set?.id;
    const gallery = setId ? gallerySets.get(setId) : undefined;
    if (
      !gallery ||
      !card.localId ||
      card.id !== sourceId ||
      `${setId}-${card.localId}` !== sourceId ||
      !gallery.number.test(card.localId)
    )
      return null;
    // Gallery prints share their parent set's asset directory, with distinct prefixed numbers.
    image = `https://assets.tcgdex.net/${language}/swsh/${gallery.parent}/${card.localId}`;
  }
  const valid = z.string().url().safeParse(image);
  if (!valid.success) return null;
  const url = new URL(valid.data);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'assets.tcgdex.net' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  )
    return null;
  return url.href.replace(/\/+$/u, '');
}
