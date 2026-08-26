import { z } from 'zod';
import { importCatalogueLanguage, transformTcgdexCard, type ImportedCard } from './catalogue';

const MAX_LIST_BYTES = 5 * 1024 * 1024;
const MAX_DETAIL_BYTES = 2 * 1024 * 1024;
const MAX_VARIANTS = 1000;
const CONCURRENCY = 5;
const PREVIEW_CACHE_SECONDS = 24 * 60 * 60;
const PREVIEW_CACHE_KEY = 'catalogue/national-previews-en-v2.json';
const SPECIES_DISCOVERY_CACHE_SECONDS = 6 * 60 * 60;

const briefSchema = z
  .object({
    id: z.string().trim().min(1).max(256),
    localId: z.string().trim().min(1).max(64).optional(),
    name: z.string().trim().min(1).max(200),
    image: z.string().url().optional(),
  })
  .passthrough();
const briefsSchema = z.array(briefSchema).max(MAX_VARIANTS);
const fullBriefsSchema = z.array(briefSchema).max(30_000);

async function boundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) > maximumBytes) throw new Error('tcgdex_response_too_large');
  if (!response.body) throw new Error('tcgdex_response_empty');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    length += result.value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel();
      throw new Error('tcgdex_response_too_large');
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function tcgdex(path: string, maximumBytes: number): Promise<unknown> {
  const response = await fetch(`https://api.tcgdex.net/v2/${path}`, {
    headers: { accept: 'application/json', 'user-agent': 'pokedex-species-discovery/1' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`tcgdex_fetch_failed_${response.status}`);
  return boundedJson(response, maximumBytes);
}

function speciesKey(value: string): string {
  return value
    .replaceAll('♀', ' female ')
    .replaceAll('♂', ' male ')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '');
}

async function mapDetails(ids: string[], speciesName: string, pokedexNumber: number) {
  const cards: ImportedCard[] = [];
  for (let offset = 0; offset < ids.length; offset += CONCURRENCY) {
    const values = await Promise.all(
      ids
        .slice(offset, offset + CONCURRENCY)
        .map((id) => tcgdex(`en/cards/${encodeURIComponent(id)}`, MAX_DETAIL_BYTES)),
    );
    const transformed = await Promise.all(values.map((value) => transformTcgdexCard(value, 'en')));
    cards.push(
      ...transformed.filter(
        (card): card is ImportedCard =>
          card !== null &&
          card.category === 'pokemon' &&
          (card.pokedexNumber === pokedexNumber ||
            speciesKey(card.species ?? card.name) === speciesKey(speciesName)),
      ),
    );
  }
  return cards;
}

export async function discoverTcgdexSpecies(
  db: D1Database,
  speciesName: string,
  pokedexNumber: number,
): Promise<{ imported: number; inactive: number; cached: boolean }> {
  const now = Math.floor(Date.now() / 1000);
  const cached = await db
    .prepare(
      `SELECT printing_count, last_checked_at FROM species_discovery_cache
       WHERE pokedex_number = ?1`,
    )
    .bind(pokedexNumber)
    .first<{ printing_count: number; last_checked_at: number }>();
  if (cached && cached.last_checked_at > now - SPECIES_DISCOVERY_CACHE_SECONDS) {
    return { imported: cached.printing_count, inactive: 0, cached: true };
  }
  const query = new URLSearchParams({ name: speciesName });
  const briefs = briefsSchema.parse(await tcgdex(`en/cards?${query}`, MAX_LIST_BYTES));
  const cards = await mapDetails(
    briefs.map((brief) => brief.id),
    speciesName,
    pokedexNumber,
  );
  const result =
    cards.length === 0
      ? { imported: 0, inactive: 0 }
      : await importCatalogueLanguage(db, {
          provider: 'tcgdex',
          language: 'en',
          cards,
          complete: false,
        });
  await db
    .prepare(
      `INSERT INTO species_discovery_cache
         (pokedex_number, species_name, printing_count, last_checked_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(pokedex_number) DO UPDATE SET
         species_name = excluded.species_name,
         printing_count = excluded.printing_count,
         last_checked_at = excluded.last_checked_at`,
    )
    .bind(pokedexNumber, speciesName, result.imported, now)
    .run();
  return { ...result, cached: false };
}

export interface TcgdexSpeciesPreview {
  name: string;
  imageBase: string;
  sourceId: string;
}

const speciesPreviewsSchema = z.array(
  z
    .object({
      name: z.string().min(1).max(120),
      imageBase: z.string().url(),
      sourceId: z.string().min(1).max(256),
    })
    .strict(),
);

export async function discoverTcgdexSpeciesPreviews(
  speciesNames: string[],
): Promise<TcgdexSpeciesPreview[]> {
  const requested = new Map(speciesNames.map((name) => [speciesKey(name), name]));
  const previews = new Map<string, TcgdexSpeciesPreview>();
  const briefs = fullBriefsSchema.parse(await tcgdex('en/cards', MAX_LIST_BYTES));
  const useBrief = (brief: z.infer<typeof briefSchema>, requestedKey: string): void => {
    if (!brief.image) return;
    const requestedName = requested.get(requestedKey);
    if (!requestedName || previews.has(requestedKey)) return;
    const image = new URL(brief.image);
    if (
      image.protocol !== 'https:' ||
      image.hostname !== 'assets.tcgdex.net' ||
      image.pathname.includes('/tcgp/')
    )
      return;
    previews.set(requestedKey, {
      name: requestedName,
      imageBase: image.href.replace(/\/+$/u, ''),
      sourceId: brief.id,
    });
  };
  for (const brief of briefs) {
    const key = speciesKey(brief.name);
    if (requested.has(key)) useBrief(brief, key);
  }
  for (const [requestedKey] of requested) {
    if (previews.has(requestedKey)) continue;
    for (const brief of briefs) {
      if (!speciesKey(brief.name).includes(requestedKey)) continue;
      useBrief(brief, requestedKey);
      if (previews.has(requestedKey)) break;
    }
  }
  return speciesNames.flatMap((name) => {
    const preview = previews.get(speciesKey(name));
    return preview ? [preview] : [];
  });
}

export async function cachedTcgdexSpeciesPreviews(
  art: R2Bucket,
  speciesNames: string[],
): Promise<TcgdexSpeciesPreview[]> {
  if (speciesNames.length !== 1025) return discoverTcgdexSpeciesPreviews(speciesNames);
  const cached = await art.get(PREVIEW_CACHE_KEY);
  const generatedAt = Number(cached?.customMetadata?.generatedAt ?? 0);
  if (cached && generatedAt > Math.floor(Date.now() / 1000) - PREVIEW_CACHE_SECONDS) {
    const parsed = speciesPreviewsSchema.safeParse(await cached.json());
    if (parsed.success) return parsed.data;
  }
  const previews = await discoverTcgdexSpeciesPreviews(speciesNames);
  await art.put(PREVIEW_CACHE_KEY, JSON.stringify(previews), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { generatedAt: String(Math.floor(Date.now() / 1000)) },
  });
  return previews;
}

export const normalizedSpeciesKey = speciesKey;
