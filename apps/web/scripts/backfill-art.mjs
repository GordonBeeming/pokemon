import { execFile } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile, rename } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';

const exec = promisify(execFile);
const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const maxBytes = 15 * 1024 * 1024;
const userAgent = 'PokedexCatalogueBackfill/1.0 (+https://github.com/GordonBeeming/pokemon)';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const isManifestConflict = (status, body) =>
  status === 409 && body?.error === 'art_upload_version_conflict';
async function writeCache(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value));
  await rename(temporary, path);
}
export const isCacheMiss = (error) =>
  error instanceof SyntaxError || error instanceof z.ZodError || error.code === 'ENOENT';
const cardSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string(),
  set_id: z.string(),
  set_name: z.string(),
  number: z.string(),
  language: z.literal('en'),
  source_id: z.string(),
  has_low: z.number(),
  has_high: z.number(),
});
const providerCard = z.object({
  id: z.string(),
  name: z.string(),
  number: z.string(),
  set: z.object({ id: z.string(), name: z.string() }),
  images: z.object({ small: z.string().url(), large: z.string().url() }),
});
const sourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  localId: z.string(),
  set: z.object({ id: z.string(), name: z.string() }),
  image: z.string().url().nullish(),
  pricing: z
    .object({
      tcgplayer: z.object({ idProduct: z.number().int().positive().optional() }).nullish(),
    })
    .nullish(),
  variants_detailed: z
    .array(
      z.object({
        type: z.string(),
        subtype: z.string().optional(),
        thirdParty: z.object({ tcgplayer: z.number().int().positive().optional() }).optional(),
      }),
    )
    .optional(),
});
export const normalizedName = (value) =>
  value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}♀♂]/gu, '');
export const normalizedNumber = (value) =>
  value
    .trim()
    .toUpperCase()
    .split('/')[0]
    .replace(/(^|\D)0+(?=\d)/gu, '$1');
export function imageUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !['assets.tcgdex.net', 'tcgplayer-cdn.tcgplayer.com', 'images.pokemontcg.io'].includes(
      url.hostname,
    )
  )
    throw new Error('Untrusted image URL');
  return url.href;
}
export function productImageCandidates(raw, card) {
  const source = sourceSchema.parse(raw);
  if (
    source.id !== card.source_id ||
    source.set.id !== card.set_id ||
    normalizedName(source.name) !== normalizedName(card.name) ||
    normalizedNumber(source.localId) !== normalizedNumber(card.number)
  )
    throw new Error('TCGdex identity differs from the catalogue');
  const candidates = [];
  if (source.image)
    candidates.push({
      provider: 'tcgdex',
      url: imageUrl(source.image.replace(/\/+$/u, '') + '/high.webp'),
      sourceId: source.id,
    });
  const ids = [];
  if (source.pricing?.tcgplayer?.idProduct) ids.push(source.pricing.tcgplayer.idProduct);
  for (const type of ['normal', 'holo', 'reverse-holo']) {
    for (const variant of source.variants_detailed ?? []) {
      if (variant.type === type && !variant.subtype && variant.thirdParty?.tcgplayer)
        ids.push(variant.thirdParty.tcgplayer);
    }
  }
  for (const id of [...new Set(ids)].slice(0, 3))
    candidates.push({
      provider: 'tcgplayer',
      sourceId: String(id),
      url: `https://tcgplayer-cdn.tcgplayer.com/product/${id}_in_1000x1000.jpg`,
    });
  return candidates;
}
export function matchProviderCard(records, card, setId) {
  const matches = records.filter(
    (item) =>
      item.set.id === setId &&
      normalizedName(item.name) === normalizedName(card.name) &&
      normalizedNumber(item.number) === normalizedNumber(card.number),
  );
  if (matches.length !== 1) return null;
  const match = matches[0];
  return { provider: 'pokemontcg', sourceId: match.id, url: imageUrl(match.images.large) };
}
const csvProductSchema = z.object({
  productId: z.number().int().positive(),
  name: z.string(),
  imageUrl: z.string().url(),
  extendedData: z.array(z.object({ name: z.string(), value: z.string() })),
});
export function matchCsvProduct(records, card) {
  const matches = records.filter((product) => {
    const number = product.extendedData.find((field) => field.name === 'Number')?.value;
    if (
      card.set_id !== 'mfb' &&
      (!number || normalizedNumber(number) !== normalizedNumber(card.number))
    )
      return false;
    if (
      !product.extendedData.some((field) => ['Rarity', 'Number', 'Card Type'].includes(field.name))
    )
      return false;
    let name = product.name;
    if (number) {
      const suffix = name.match(/ - ([A-Za-z0-9]+(?:\/[A-Za-z0-9]+)?)$/u);
      if (suffix && normalizedNumber(suffix[1]) === normalizedNumber(number))
        name = name.slice(0, -suffix[0].length);
      const kit = card.set_name.match(/^(?:BW|DP|HS|XY|SM) trainer Kit \(([^)]+)\)$/u);
      const kitSuffix = name.match(/ \(#?([0-9]+)(?: - ([^)]+))?\)$/u);
      if (
        kit &&
        kitSuffix &&
        normalizedNumber(kitSuffix[1]) === normalizedNumber(number) &&
        (!kitSuffix[2] || normalizedName(kitSuffix[2]) === normalizedName(kit[1]))
      )
        name = name.slice(0, -kitSuffix[0].length);
    }
    return normalizedName(name) === normalizedName(card.name);
  });
  if (matches.length !== 1) return null;
  const product = matches[0];
  return {
    provider: 'tcgplayer-csv',
    sourceId: String(product.productId),
    url: imageUrl(product.imageUrl.replace(/_200w\.jpg$/u, '_in_1000x1000.jpg')),
  };
}
export function matchingCsvGroups(groups, card) {
  const mcd = card.set_name.match(/^McDonald's Collection (\d{4})$/u);
  const kit = card.set_name.match(/^(BW|DP|HS|XY|SM) trainer Kit \(([^)]+)\)$/u);
  return groups.filter((group) => {
    if (
      normalizedName(group.name.replace(/^[A-Za-z]+\d+[A-Za-z0-9.]*:\s*/u, '')) ===
        normalizedName(card.set_name) ||
      (group.abbreviation && group.abbreviation.toLowerCase() === card.set_id.toLowerCase())
    )
      return true;
    if (mcd && group.name === `McDonald's Promos ${mcd[1]}`) return true;
    if (kit) {
      const groupKit = group.name.match(/^(BW|DP|HGSS|XY|SM) Trainer Kit: (.+)$/u);
      return Boolean(
        groupKit &&
        groupKit[1] === (kit[1] === 'HS' ? 'HGSS' : kit[1]) &&
        groupKit[2]
          .split(' & ')
          .some((member) => normalizedName(member) === normalizedName(kit[2])),
      );
    }
    return false;
  });
}
async function bytesFrom(url, maximum = maxBytes) {
  const response = await fetch(url, {
    headers: { 'user-agent': userAgent },
    redirect: 'error',
    signal: globalThis.AbortSignal.timeout(25000),
  });
  return responseBytes(response, maximum);
}
async function responseBytes(response, maximum = maxBytes) {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (Number(response.headers.get('content-length') ?? 0) > maximum)
    throw new Error('Source exceeds size limit');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty response');
  const chunks = [];
  let length = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    length += item.value.byteLength;
    if (length > maximum) {
      await reader.cancel();
      throw new Error('Source exceeds size limit');
    }
    chunks.push(item.value);
  }
  return Buffer.concat(chunks, length);
}
async function jsonFrom(url, maximum = 8 * 1024 * 1024) {
  return JSON.parse((await bytesFrom(url, maximum)).toString('utf8'));
}
const wrangler = join(app, 'node_modules/.bin/wrangler');
async function cloud(args, binary = false) {
  const result = await exec(
    wrangler,
    [...args, '--config', 'wrangler.jsonc', '--env-file', '/dev/null'],
    {
      cwd: app,
      encoding: binary ? 'buffer' : 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 180000,
    },
  );
  return result.stdout;
}
async function database(sql) {
  const result = z
    .array(z.object({ success: z.literal(true), results: z.array(z.unknown()) }))
    .parse(
      JSON.parse(await cloud(['d1', 'execute', 'DB', '--remote', '--json', '--command', sql])),
    );
  return result.flatMap((item) => item.results);
}
async function prepareImage(bytes, directory, cardId) {
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp =
    bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!png && !jpeg && !webp) throw new Error('Source is not PNG, JPEG or WebP');
  const input = join(directory, `${sha(cardId)}-source.${png ? 'png' : jpeg ? 'jpg' : 'webp'}`);
  await writeFile(input, bytes);
  const probe = await exec(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'json',
      input,
    ],
    { timeout: 30000 },
  );
  const dimensions = z
    .object({
      streams: z
        .array(
          z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
        )
        .min(1),
    })
    .parse(JSON.parse(probe.stdout)).streams[0];
  if (dimensions.width * dimensions.height > 16_000_000)
    throw new Error('Source dimensions exceed limit');
  // Product images must be individual portrait cards, not boxes or multi-card bundles.
  const ratio = dimensions.width / dimensions.height;
  if (ratio < 0.55 || ratio > 0.9) throw new Error('Source is not a portrait card image');
  return { path: input, ...dimensions };
}
async function webpVariant(input, directory, id, variant) {
  const path = join(directory, `${sha(id)}-${variant}.webp`);
  const width = variant === 'high' ? 1200 : 240,
    height = variant === 'high' ? 1700 : 340;
  const scale = Math.min(1, width / input.width, height / input.height);
  await exec(
    'cwebp',
    [
      '-quiet',
      '-lossless',
      '-resize',
      String(Math.max(1, Math.round(input.width * scale))),
      String(Math.max(1, Math.round(input.height * scale))),
      input.path,
      '-o',
      path,
    ],
    { timeout: 60000, maxBuffer: 1024 * 1024 },
  );
  const bytes = await readFile(path);
  if (
    bytes.length > maxBytes ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WEBP'
  )
    throw new Error('Conversion did not produce a bounded WebP image');
  return { path, bytes: bytes.length, sha256: sha(bytes) };
}
export async function main(args) {
  const apply = args.includes('--apply');
  const token = process.env.POKEDEX_ART_TOKEN;
  if (apply && (!token || token.startsWith('op://')))
    throw new Error(
      '--apply needs POKEDEX_ART_TOKEN injected with op run (art:read and art:write)',
    );
  const origin = 'https://pokedex.gordonbeeming.com';
  const appFetch = (path, init = {}, bearer = token) =>
    fetch(origin + path, {
      ...init,
      headers: { authorization: `Bearer ${bearer}`, ...init.headers },
      redirect: 'error',
      signal: globalThis.AbortSignal.timeout(30000),
    });
  const values = args.filter((arg) => arg !== '--apply');
  const options = {};
  for (let i = 0; i < values.length; i += 2) {
    if (!['--out', '--limit', '--source'].includes(values[i]) || !values[i + 1])
      throw new Error('Use --out DIR [--source ID,ID] [--limit N] [--apply]');
    options[values[i].slice(2)] = values[i + 1];
  }
  if (!options.out) throw new Error('--out is required; use a directory outside source control');
  const directory = resolve(options.out);
  await mkdir(directory, { recursive: true });
  const sourceCache = join(homedir(), '.cache', 'pokedex-art-sources');
  await mkdir(sourceCache, { recursive: true, mode: 0o700 });
  let csvStampPromise;
  let csvQueue = Promise.resolve();
  async function csvStamp() {
    const path = join(sourceCache, 'last-updated.json');
    try {
      const saved = z
        .object({ checkedAt: z.number(), stamp: z.string() })
        .parse(JSON.parse(await readFile(path, 'utf8')));
      if (Date.now() - saved.checkedAt < 86400000) return saved.stamp;
    } catch (error) {
      if (!isCacheMiss(error)) throw error;
    }
    const stamp = (await bytesFrom('https://tcgcsv.com/last-updated.txt', 1024))
      .toString('utf8')
      .trim();
    await writeCache(path, { checkedAt: Date.now(), stamp });
    return stamp;
  }
  async function csvJson(path) {
    csvStampPromise ??= csvStamp();
    const stamp = await csvStampPromise,
      url = 'https://tcgcsv.com' + path;
    const cachePath = join(sourceCache, sha(stamp + url) + '.json');
    try {
      return JSON.parse(await readFile(cachePath, 'utf8'));
    } catch (error) {
      if (!isCacheMiss(error)) throw error;
    }
    const job = csvQueue.then(async () => {
      await new Promise((done) => setTimeout(done, 150));
      const result = await jsonFrom(url, 16 * 1024 * 1024);
      await writeCache(cachePath, result);
      return result;
    });
    csvQueue = job.then(
      () => undefined,
      (error) => {
        process.stderr.write(`TCGCSV request failed: ${error.message}\n`);
      },
    );
    return job;
  }
  const config = await readFile(join(app, 'wrangler.jsonc'), 'utf8');
  if (
    !config.includes('"pokedex-web"') ||
    !config.includes('5e955d9c-188b-476a-80e9-8b1908f20f54') ||
    !config.includes('"pokedex-art"')
  )
    throw new Error('Unexpected production configuration');
  const limit = options.limit === undefined ? Number.MAX_SAFE_INTEGER : Number(options.limit);
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error('--limit must be a positive integer');
  const inventory = [];
  let afterId = '';
  while (true) {
    const batch = z.array(cardSchema).parse(
      await database(`
    SELECT c.id,c.name,c.set_id,c.set_name,c.number,c.language,
      (SELECT source_id FROM card_sources s WHERE s.card_id=c.id AND s.provider='tcgdex' AND s.active=1 ORDER BY s.imported_at DESC LIMIT 1) AS source_id,
      low.card_id IS NOT NULL AS has_low,high.card_id IS NOT NULL AS has_high
    FROM catalogue_cards c
    LEFT JOIN art_manifest low ON low.card_id=c.id AND low.variant='low'
    LEFT JOIN art_manifest high ON high.card_id=c.id AND high.variant='high'
    WHERE c.language='en' AND c.is_active=1 AND (low.card_id IS NULL OR high.card_id IS NULL)
      AND c.id > '${afterId.replaceAll("'", "''")}'
      AND EXISTS(SELECT 1 FROM card_sources s WHERE s.card_id=c.id AND s.provider='tcgdex' AND s.active=1)
    ORDER BY c.id LIMIT 500`),
    );
    inventory.push(...batch);
    if (batch.length < 500) break;
    afterId = batch.at(-1).id;
  }
  const wanted = options.source?.split(',');
  const cards = inventory
    .filter((card) => !wanted || wanted.includes(card.source_id))
    .slice(0, limit);
  const setCache = new Map(),
    cardCache = new Map();
  let setsPromise;
  async function secondary(card) {
    setsPromise ??= jsonFrom(
      'https://raw.githubusercontent.com/PokemonTCG/pokemon-tcg-data/master/sets/en.json',
    ).then((body) =>
      z
        .array(
          z.object({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.]{0,40}$/u), name: z.string() }),
        )
        .parse(body),
    );
    const sets = await setsPromise;
    if (!setCache.has(card.set_id))
      setCache.set(
        card.set_id,
        sets.filter(
          (set) =>
            set.id === card.set_id || normalizedName(set.name) === normalizedName(card.set_name),
        ),
      );
    const matches = setCache.get(card.set_id);
    if (matches.length !== 1) return null;
    const set = matches[0];
    if (!cardCache.has(set.id)) {
      cardCache.set(
        set.id,
        (async () => {
          const records = z
            .array(providerCard.omit({ set: true }))
            .parse(
              await jsonFrom(
                `https://raw.githubusercontent.com/PokemonTCG/pokemon-tcg-data/master/cards/en/${encodeURIComponent(set.id)}.json`,
                16 * 1024 * 1024,
              ),
            );
          return records.map((record) => ({ ...record, set }));
        })(),
      );
    }
    return matchProviderCard(await cardCache.get(set.id), card, set.id);
  }
  let groupsPromise;
  const productsCache = new Map();
  async function csvCandidate(card) {
    groupsPromise ??= csvJson('/tcgplayer/3/groups').then(
      (body) =>
        z
          .object({
            results: z.array(
              z.object({
                groupId: z.number().int().positive(),
                name: z.string(),
                abbreviation: z.string().nullish(),
              }),
            ),
          })
          .parse(body).results,
    );
    const groups = await groupsPromise;
    const matches = matchingCsvGroups(groups, card);
    if (matches.length !== 1) return null;
    const group = matches[0];
    if (!productsCache.has(group.groupId))
      productsCache.set(
        group.groupId,
        csvJson(`/tcgplayer/3/${group.groupId}/products`).then(
          (body) => z.object({ results: z.array(csvProductSchema) }).parse(body).results,
        ),
      );
    return matchCsvProduct(await productsCache.get(group.groupId), card);
  }
  let primaryAvailable = true;
  try {
    await jsonFrom('https://api.tcgdex.net/v2/en/sets');
  } catch (error) {
    primaryAvailable = false;
    process.stderr.write(`TCGdex unavailable; using fallback datasets: ${error.message}\n`);
  }
  const results = [];
  let cursor = 0;
  let completed = 0;
  const startedAt = new Date().toISOString();
  async function processCard(card) {
    const attempts = [];
    let source = null,
      input = null;
    try {
      let candidates = [];
      try {
        if (!primaryAvailable) throw new Error('Source API unavailable on this run');
        const detail = await jsonFrom(
          `https://api.tcgdex.net/v2/en/cards/${encodeURIComponent(card.source_id)}`,
        );
        candidates = productImageCandidates(detail, card);
      } catch (error) {
        attempts.push({ provider: 'tcgdex', error: error.message });
      }
      for (const candidate of candidates) {
        try {
          input = await prepareImage(await bytesFrom(imageUrl(candidate.url)), directory, card.id);
          source = candidate;
          break;
        } catch (error) {
          attempts.push({ provider: candidate.provider, error: error.message });
        }
      }
      if (!source) {
        for (const resolveSource of [secondary, csvCandidate]) {
          try {
            const candidate = await resolveSource(card);
            if (candidate) {
              input = await prepareImage(await bytesFrom(candidate.url), directory, card.id);
              source = candidate;
              break;
            }
          } catch (error) {
            attempts.push({
              provider: resolveSource === secondary ? 'pokemontcg' : 'tcgcsv',
              error: error.message,
            });
          }
        }
      }
      if (!source || !input)
        return {
          id: card.id,
          sourceId: card.source_id,
          name: card.name,
          set: card.set_name,
          status: 'unmatched',
          attempts,
        };
      const variants = [];
      for (const variant of ['low', 'high']) {
        if (card[variant === 'low' ? 'has_low' : 'has_high']) continue;
        const image = await webpVariant(input, directory, card.id, variant);
        const key = `cards/${encodeURIComponent(card.id)}/${variant}/${image.sha256}.webp`;
        if (apply) {
          const ticketResponse = await appFetch('/api/desktop/art/upload-tokens', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              cardId: card.id,
              variant,
              sha256: image.sha256,
              maxBytes: image.bytes,
              onlyIfMissing: true,
            }),
          });
          const ticketBody = await ticketResponse.json();
          if (ticketResponse.status === 409 && ticketBody.error === 'art_already_exists') {
            variants.push({ variant, status: 'existing-preserved' });
            continue;
          }
          if (!ticketResponse.ok)
            throw new Error(
              `Upload ticket failed (${ticketResponse.status}): ${ticketBody.error ?? 'unknown'}`,
            );
          const ticket = z
            .object({
              token: z.string().regex(/^[a-f0-9]{64}$/u),
              uploadPath: z.string().regex(/^\/api\/desktop\/art\/uploads\/[a-f0-9]{24}$/u),
            })
            .parse(ticketBody);
          const upload = await appFetch(
            ticket.uploadPath,
            {
              method: 'PUT',
              headers: { 'content-type': 'image/webp' },
              body: await readFile(image.path),
            },
            ticket.token,
          );
          if (!upload.ok) {
            const failure = await upload.json();
            if (!isManifestConflict(upload.status, failure))
              throw new Error(
                `Image upload failed (${upload.status}): ${failure.error ?? 'unknown'}`,
              );
          }
          const stored = await responseBytes(
            await appFetch(`/api/desktop/art/${encodeURIComponent(card.id)}/${variant}`),
          );
          if (upload.ok && sha(stored) !== image.sha256)
            throw new Error('Stored image checksum does not match');
          variants.push({
            variant,
            key,
            sha256: image.sha256,
            status: upload.ok ? 'saved' : 'existing-preserved',
          });
        } else
          variants.push({ variant, path: image.path, sha256: image.sha256, status: 'prepared' });
      }
      return {
        id: card.id,
        sourceId: card.source_id,
        name: card.name,
        set: card.set_name,
        status: apply ? 'processed' : 'prepared',
        source,
        variants,
        attempts,
      };
    } catch (error) {
      return {
        id: card.id,
        sourceId: card.source_id,
        name: card.name,
        set: card.set_name,
        status: 'failed',
        error: error.message,
        attempts,
      };
    }
  }
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (cursor < cards.length) {
        const card = cards[cursor++];
        const result = await processCard(card);
        results.push(result);
        completed++;
        await appendFile(join(directory, 'progress.jsonl'), JSON.stringify(result) + '\n');
        if (completed % 10 === 0 || completed === cards.length)
          process.stdout.write(
            JSON.stringify({
              completed,
              total: cards.length,
              saved: results.reduce(
                (n, item) => n + (item.variants ?? []).filter((v) => v.status === 'saved').length,
                0,
              ),
            }) + '\n',
          );
      }
    }),
  );
  const report = {
    startedAt,
    completedAt: new Date().toISOString(),
    applied: apply,
    inventoryCards: inventory.length,
    processedCards: cards.length,
    savedImages: results.reduce(
      (n, item) => n + (item.variants ?? []).filter((v) => v.status === 'saved').length,
      0,
    ),
    unmatchedCards: results.filter((item) => item.status === 'unmatched').length,
    unresolvedWithSourceErrors: results.filter(
      (item) => item.status === 'unmatched' && item.attempts.length > 0,
    ).length,
    failedCards: results.filter((item) => item.status === 'failed').length,
    results,
  };
  const reportPath = join(directory, 'report.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  if (apply)
    await cloud([
      'r2',
      'object',
      'put',
      `pokedex-art/maintenance/art-fallback/${startedAt.replace(/[:.]/gu, '-')}/report.json`,
      '--remote',
      '--file',
      reportPath,
      '--content-type',
      'application/json',
    ]);
  const { results: ignored, ...summary } = report;
  void ignored;
  return { ...summary, reportPath };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2))
    .then((result) => process.stdout.write(JSON.stringify(result, null, 2) + '\n'))
    .catch((error) => {
      process.stderr.write(error.message + '\n');
      process.exitCode = 1;
    });
