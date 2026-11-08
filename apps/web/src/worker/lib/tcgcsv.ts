import { createHash } from 'node:crypto';
import { pokedexNumberFromCardName } from '@pokedex/shared';
import { z } from 'zod';
import { cardGroupKeys } from './catalogue';
import { nowSeconds } from './db';
import { describeError, logWarn } from './log';

const MAX_JSON_BYTES = 20 * 1024 * 1024;
const groupSchema = z.object({
  groupId: z.number().int().positive(),
  name: z.string().min(1).max(200),
  abbreviation: z.string().nullish(),
});
export const csvProductSchema = z.object({
  productId: z.number().int().positive(),
  groupId: z.number().int().positive(),
  categoryId: z.literal(3),
  name: z.string().min(1).max(200),
  imageUrl: z.string().url(),
  extendedData: z.array(z.object({ name: z.string(), value: z.string() })).max(100),
});
const groupsSchema = z.object({ results: z.array(groupSchema).max(5000) });
const productsSchema = z.object({ results: z.array(csvProductSchema).max(10000) });
export type CsvGroup = z.infer<typeof groupSchema>;
export type CsvProduct = z.infer<typeof csvProductSchema>;
export interface SupplementalSet {
  setId: string;
  setName: string;
  abbreviation: string | null;
}

export const normalizedCardName = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}♀♂]/gu, '');
export const normalizedCardNumber = (value: string): string =>
  value
    .trim()
    .toUpperCase()
    .split('/')[0]
    ?.replace(/(^|\D)0+(?=\d)/gu, '$1') ?? '';

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`tcgcsv_http_${response.status}`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_JSON_BYTES) throw new Error('tcgcsv_response_too_large');
      chunks.push(result.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function csvJson<T>(art: R2Bucket, path: string, schema: z.ZodType<T>): Promise<T> {
  const key = `catalogue/tcgcsv-v1/${path}.json`;
  const cached = await art.get(key);
  let stale: T | undefined;
  if (cached) {
    let stored: unknown;
    try {
      stored = await cached.json();
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      logWarn({ evt: 'catalogue.tcgcsv_cache_invalid', key });
    }
    const envelope = z.object({ fetchedAt: z.number(), data: z.unknown() }).safeParse(stored);
    if (envelope.success) {
      const parsed = schema.safeParse(envelope.data.data);
      if (parsed.success) {
        const age = nowSeconds() - envelope.data.fetchedAt;
        if (age >= 0 && age < 20 * 60 * 60) return parsed.data;
        if (age >= 0 && age < 7 * 24 * 60 * 60) stale = parsed.data;
      }
    }
  }
  try {
    const response = await fetch(`https://tcgcsv.com/tcgplayer/3/${path}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    });
    const data = schema.parse(await readJson(response));
    await art.put(key, JSON.stringify({ fetchedAt: nowSeconds(), data }), {
      httpMetadata: { contentType: 'application/json' },
    });
    return data;
  } catch (error) {
    if (stale === undefined) throw error;
    logWarn({ evt: 'catalogue.tcgcsv_stale_cache', path, err: describeError(error) });
    return stale;
  }
}

export const csvGroups = (art: R2Bucket): Promise<z.infer<typeof groupsSchema>> =>
  csvJson(art, 'groups', groupsSchema);
export const csvProducts = (
  art: R2Bucket,
  groupId: number,
): Promise<z.infer<typeof productsSchema>> => {
  if (!Number.isSafeInteger(groupId) || groupId <= 0) throw new Error('tcgcsv_invalid_group');
  return csvJson(art, `${groupId}/products`, productsSchema);
};

function mcdonaldsYear(group: CsvGroup): string | undefined {
  return group.name.match(/^McDonald's Promos (20\d{2})$/u)?.[1];
}

export function matchingCsvGroups(groups: CsvGroup[], set: SupplementalSet): CsvGroup[] {
  const year = set.setName.match(/^McDonald's Collection (20\d{2})$/u)?.[1];
  return groups.filter((group) => {
    if (year)
      return mcdonaldsYear(group) === year || (year === '2021' && group.abbreviation === 'M21');
    if (set.setId === 'mep')
      return group.abbreviation === 'MEP' && group.name === 'ME: Mega Evolution Promo';
    const name = group.name.replace(/^(?:SV|SWSH|SM|XY|ME): /u, '');
    return normalizedCardName(name) === normalizedCardName(set.setName);
  });
}

function field(product: CsvProduct, name: string): string | undefined {
  return product.extendedData.find((item) => item.name === name)?.value;
}

export function csvCard(
  product: CsvProduct,
  groupId: number,
): { name: string; number: string; type: string } | null {
  if (product.groupId !== groupId) throw new Error('tcgcsv_group_mismatch');
  const printed = field(product, 'Number');
  const type = field(product, 'Card Type');
  if (!printed || !/^[A-Za-z]*\d+(?:\/[A-Za-z]*\d+)?$/u.test(printed) || !type) return null;
  const number = normalizedCardNumber(printed);
  // Product labels include the printed number and sometimes a named stamp.
  // Only known suffixes are removed; other labelled variants are skipped.
  const suffix = product.name.match(/^(.*?)\s+-\s+([A-Za-z0-9]+(?:\/[A-Za-z0-9]+)?)(.*)$/u);
  if (
    suffix &&
    (normalizedCardNumber(suffix[2] ?? '') !== number ||
      !['', ' (30th Celebration)'].includes(suffix[3] ?? ''))
  )
    return null;
  const name = suffix?.[1] ?? product.name;
  if (/[()[\]]/u.test(name)) return null;
  return { name, number, type };
}

export function csvImageUrl(product: CsvProduct): string | null {
  // Bind the image to the verified product, rather than following a URL supplied
  // by a third-party feed to an arbitrary host or a different product.
  return product.imageUrl ===
    `https://tcgplayer-cdn.tcgplayer.com/product/${product.productId}_200w.jpg`
    ? `https://tcgplayer-cdn.tcgplayer.com/product/${product.productId}_in_1000x1000.jpg`
    : null;
}

export function matchingCsvProduct(
  products: CsvProduct[],
  groupId: number,
  card: { name: string; number: string },
): CsvProduct | null {
  const matches = products.filter((product) => {
    const candidate = csvCard(product, groupId);
    return (
      candidate &&
      normalizedCardName(candidate.name) === normalizedCardName(card.name) &&
      candidate.number === normalizedCardNumber(card.number)
    );
  });
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

export async function supplementalArtUrl(
  db: D1Database,
  art: R2Bucket,
  cardId: string,
): Promise<string | null> {
  const card = await db
    .prepare(
      `SELECT c.name,c.number,c.language,c.set_id,c.set_name,c.is_custom,c.owner_id,
    s.abbreviation FROM catalogue_cards c LEFT JOIN catalogue_sets s ON s.set_id=c.set_id AND s.language=c.language
    WHERE c.id=?1 AND c.is_active=1`,
    )
    .bind(cardId)
    .first<{
      name: string;
      number: string;
      language: string;
      set_id: string;
      set_name: string;
      abbreviation: string | null;
      is_custom: number;
      owner_id: string | null;
    }>();
  if (!card || card.language !== 'en' || card.is_custom === 1 || card.owner_id !== null)
    return null;
  const verified = await db
    .prepare(
      `SELECT s.source_id FROM card_sources s JOIN catalogue_cards c ON c.id=s.card_id
    WHERE s.card_id=?1 AND s.provider='tcgcsv' AND s.language='en' AND s.active=1 AND c.is_active=1
    ORDER BY s.source_id LIMIT 2`,
    )
    .bind(cardId)
    .all<{ source_id: string }>();
  if (verified.results.length === 1 && /^[1-9]\d*$/u.test(verified.results[0]?.source_id ?? ''))
    return `https://tcgplayer-cdn.tcgplayer.com/product/${verified.results[0]?.source_id}_in_1000x1000.jpg`;
  const missKey = `catalogue/tcgcsv-misses/${encodeURIComponent(cardId)}.json`;
  const cachedMiss = await art.get(missKey);
  if (cachedMiss) {
    const miss = z.object({ at: z.number() }).safeParse(await cachedMiss.json());
    if (miss.success && nowSeconds() - miss.data.at < 15 * 60) return null;
  }
  async function missing(): Promise<null> {
    await art.put(missKey, JSON.stringify({ at: nowSeconds() }), {
      httpMetadata: { contentType: 'application/json' },
    });
    return null;
  }

  const groups = matchingCsvGroups((await csvGroups(art)).results, {
    setId: card.set_id,
    setName: card.set_name,
    abbreviation: card.abbreviation,
  });
  if (groups.length !== 1 || !groups[0]) return missing();
  const group = groups[0];
  const product = matchingCsvProduct(
    (await csvProducts(art, group.groupId)).results,
    group.groupId,
    card,
  );
  return product ? csvImageUrl(product) : missing();
}

export async function supplementalSets(
  db: D1Database,
  groups: CsvGroup[],
): Promise<Array<{ group: CsvGroup; set: SupplementalSet }>> {
  const stored = await db
    .prepare(
      `SELECT s.set_id,s.set_name,s.abbreviation,EXISTS(
      SELECT 1 FROM catalogue_cards c JOIN card_sources source ON source.card_id=c.id
      WHERE c.set_id=s.set_id AND c.language=s.language AND source.provider='tcgdex' AND source.active=1
    ) AS has_primary FROM catalogue_sets s WHERE s.language='en'`,
    )
    .all<{ set_id: string; set_name: string; abbreviation: string | null; has_primary: number }>();
  const selected: Array<{ group: CsvGroup; set: SupplementalSet }> = [];
  for (const group of groups) {
    const year = mcdonaldsYear(group);
    if (!year && !(group.abbreviation === 'MEP' && group.name === 'ME: Mega Evolution Promo'))
      continue;
    const expectedName = year ? `McDonald's Collection ${year}` : 'MEP Black Star Promos';
    const named = stored.results.filter(
      (s) => normalizedCardName(s.set_name) === normalizedCardName(expectedName),
    );
    const primary = named.filter((s) => s.has_primary === 1);
    const candidates = primary.length ? primary : named;
    if (candidates.length > 1) {
      logWarn({ evt: 'catalogue.tcgcsv_ambiguous_set', groupId: group.groupId });
      continue;
    }
    const existing = candidates[0];
    const set = existing
      ? { setId: existing.set_id, setName: existing.set_name, abbreviation: existing.abbreviation }
      : {
          setId: year ? `mcdonalds-${year}` : 'mep',
          setName: expectedName,
          abbreviation: group.abbreviation ?? null,
        };
    if (matchingCsvGroups(groups, set).length !== 1) {
      logWarn({ evt: 'catalogue.tcgcsv_ambiguous_group', groupId: group.groupId });
      continue;
    }
    selected.push({ group, set });
  }
  return selected;
}

export async function importSupplementalProducts(
  db: D1Database,
  group: CsvGroup,
  set: SupplementalSet,
  products: CsvProduct[],
): Promise<number> {
  const now = nowSeconds();
  const existing = await db
    .prepare(
      `SELECT id,name,number FROM catalogue_cards
    WHERE language='en' AND (set_id=?1 OR lower(set_name)=lower(?2)) AND is_custom=0 AND owner_id IS NULL`,
    )
    .bind(set.setId, set.setName)
    .all<{ id: string; name: string; number: string }>();
  const sources = await db
    .prepare("SELECT source_id,card_id FROM card_sources WHERE provider='tcgcsv' AND language='en'")
    .all<{ source_id: string; card_id: string }>();
  const sourceIds = new Map(sources.results.map((s) => [s.source_id, s.card_id]));
  const rows = [];
  for (const product of products) {
    const card = csvCard(product, group.groupId);
    if (!card || !csvImageUrl(product)) continue;
    if (matchingCsvProduct(products, group.groupId, card)?.productId !== product.productId) {
      logWarn({
        evt: 'catalogue.tcgcsv_ambiguous_product',
        groupId: group.groupId,
        productId: product.productId,
      });
      continue;
    }
    const matches = existing.results.filter(
      (c) =>
        normalizedCardName(c.name) === normalizedCardName(card.name) &&
        normalizedCardNumber(c.number) === card.number,
    );
    if (matches.length > 1) throw new Error('tcgcsv_ambiguous_card');
    const id =
      sourceIds.get(String(product.productId)) ??
      matches[0]?.id ??
      `card_${createHash('sha256').update(`tcgcsv\0en\0${product.productId}`).digest('hex')}`;
    const category = card.type.startsWith('Trainer')
      ? 'trainer'
      : card.type.startsWith('Energy')
        ? 'energy'
        : 'pokemon';
    if (category === 'pokemon' && pokedexNumberFromCardName(card.name) === null) continue;
    rows.push({
      ...card,
      id,
      productId: String(product.productId),
      category,
      supertype: category === 'pokemon' ? 'Pokemon' : category === 'trainer' ? 'Trainer' : 'Energy',
      subtype: category === 'pokemon' ? card.type : (card.type.split(' - ')[1] ?? null),
      rarity: field(product, 'Rarity') ?? null,
      species: category === 'pokemon' ? card.name : null,
      types: category === 'pokemon' ? [card.type] : null,
      pokedexNumber: category === 'pokemon' ? pokedexNumberFromCardName(card.name) : null,
      ...cardGroupKeys({ ...card, category }),
      checksum: createHash('sha256').update(JSON.stringify(product)).digest('hex'),
    });
  }
  if (!rows.length) return 0;
  const json = JSON.stringify(rows);
  await db.batch([
    db
      .prepare(
        `INSERT INTO catalogue_sets(set_id,language,set_name,release_date,updated_at,abbreviation)
      VALUES(?1,'en',?2,NULL,?3,?4) ON CONFLICT(set_id,language) DO NOTHING`,
      )
      .bind(set.setId, set.setName, now, set.abbreviation),
    db
      .prepare(
        `INSERT INTO catalogue_cards(id,name,language,category,set_id,set_name,number,number_sort,species,pokedex_number,types,artist_key,trainer_key,energy_key,supertype,subtype,rarity,created_at,updated_at)
      SELECT json_extract(value,'$.id'),json_extract(value,'$.name'),'en',json_extract(value,'$.category'),?2,?3,
        json_extract(value,'$.number'),CAST(json_extract(value,'$.number') AS INTEGER),json_extract(value,'$.species'),
        json_extract(value,'$.pokedexNumber'),json_extract(value,'$.types'),json_extract(value,'$.artistKey'),
        json_extract(value,'$.trainerKey'),json_extract(value,'$.energyKey'),json_extract(value,'$.supertype'),
        json_extract(value,'$.subtype'),json_extract(value,'$.rarity'),?4,?4 FROM json_each(?1) WHERE true
      ON CONFLICT(id) DO UPDATE SET is_active=1
      WHERE catalogue_cards.is_custom=0 AND catalogue_cards.owner_id IS NULL`,
      )
      .bind(json, set.setId, set.setName, now),
    db
      .prepare(
        `UPDATE catalogue_cards SET set_id=?2,set_name=?3
      WHERE id IN(SELECT json_extract(value,'$.id') FROM json_each(?1))
        AND set_id<>?2 AND is_custom=0 AND owner_id IS NULL
        AND NOT EXISTS(SELECT 1 FROM card_sources source WHERE source.card_id=catalogue_cards.id
          AND source.provider='tcgdex' AND source.active=1)`,
      )
      .bind(json, set.setId, set.setName),
    db
      .prepare(
        `INSERT INTO card_sources(provider,source_id,card_id,language,source_updated_at,checksum,active,imported_at)
      SELECT 'tcgcsv',json_extract(value,'$.productId'),json_extract(value,'$.id'),'en',?2,json_extract(value,'$.checksum'),1,?2
      FROM json_each(?1) WHERE true ON CONFLICT(provider,source_id,language) DO UPDATE SET
        checksum=excluded.checksum,active=1,imported_at=excluded.imported_at`,
      )
      .bind(json, now),
    db
      .prepare(
        `INSERT INTO catalogue_search(card_id,name,set_name,number,species,rarity,artist)
      SELECT c.id,c.name,c.set_name,c.number,COALESCE(c.species,''),COALESCE(c.rarity,''),COALESCE(c.artist,'')
      FROM catalogue_cards c JOIN json_each(?1) j ON c.id=json_extract(j.value,'$.id')
      WHERE NOT EXISTS(SELECT 1 FROM catalogue_search s WHERE s.card_id=c.id)`,
      )
      .bind(json),
  ]);
  return rows.length;
}
