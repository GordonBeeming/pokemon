import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';

const baseUrl = new URL(process.argv[2] ?? 'http://127.0.0.1:7741');
const cardLimit = Number.parseInt(process.env.POKEDEX_LOCAL_ART_LIMIT ?? '12', 10);
const tokenLabel = `Local art seed ${randomUUID()}`;
const variants = ['low', 'high'];
const maximumArtBytes = 15 * 1024 * 1024;
const languageCards = new Map();
let interrupted = false;

process.once('SIGINT', () => {
  interrupted = true;
});

if (!Number.isInteger(cardLimit) || cardLimit < 1 || cardLimit > 5_000) {
  throw new Error('POKEDEX_LOCAL_ART_LIMIT must be between 1 and 5000.');
}
if (!['127.0.0.1', 'localhost', '::1'].includes(baseUrl.hostname)) {
  throw new Error('Local art seeding only accepts a loopback Pokédex URL.');
}

async function responseJson(path, init = {}) {
  const response = await fetch(new URL(path, baseUrl), init);
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`${path} failed (${response.status}): ${JSON.stringify(body)}`);
  }
  return { response, body };
}

async function browserSession() {
  const { response } = await responseJson('/api/auth/dev-login', { method: 'POST' });
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
  if (!cookie) throw new Error('Local development login did not return a session cookie.');
  return cookie;
}

async function desktopToken(cookie) {
  const paired = await responseJson('/api/desktop/pair', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ scopes: ['catalogue:read', 'art:read', 'art:write'] }),
  });
  const redeemed = await responseJson('/api/desktop/pair/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: paired.body.code, label: tokenLabel }),
  });
  if (typeof redeemed.body.token !== 'string') {
    throw new Error('Local desktop pairing did not return a token.');
  }
  return redeemed.body.token;
}

async function revokeSeedToken(cookie) {
  const listed = await responseJson('/api/desktop/tokens', { headers: { cookie } });
  const token = listed.body.tokens?.find((candidate) => candidate.label === tokenLabel);
  if (!token?.id) return;
  await responseJson(`/api/desktop/tokens/${encodeURIComponent(token.id)}`, {
    method: 'DELETE',
    headers: { cookie },
  });
}

async function allPages(path, headers, property) {
  const values = [];
  let cursor = null;
  do {
    const url = new URL(path, baseUrl);
    url.searchParams.set('limit', '5000');
    if (cursor) url.searchParams.set('cursor', cursor);
    const { body } = await responseJson(`${url.pathname}${url.search}`, {
      headers,
    });
    values.push(...(body[property] ?? []));
    cursor = body.cursor ?? null;
  } while (cursor);
  return values;
}

async function missingCatalogueSources(cookie) {
  const manifest = await allPages('/api/art/manifest', { cookie }, 'entries');
  const existing = new Set(manifest.map((entry) => `${entry.cardId}|${entry.variant}`));
  const missing = [];
  let offset = 0;
  while (missing.length < cardLimit) {
    const search = new URL('/api/catalogue/search', baseUrl);
    search.searchParams.set('limit', '100');
    search.searchParams.set('offset', String(offset));
    const { body } = await responseJson(`${search.pathname}${search.search}`, {
      headers: { cookie },
    });
    const cards = body.cards ?? [];
    for (const card of cards) {
      if (variants.every((variant) => existing.has(`${card.id}|${variant}`))) continue;
      const detail = await responseJson(`/api/catalogue/${encodeURIComponent(card.id)}`, {
        headers: { cookie },
      });
      const source = detail.body.card?.source;
      if (source?.provider !== 'tcgdex') continue;
      missing.push({
        cardId: card.id,
        provider: source.provider,
        sourceId: source.sourceId,
        language: card.language,
      });
      if (missing.length >= cardLimit) break;
    }
    offset += cards.length;
    if (cards.length === 0 || offset >= (body.total ?? 0)) break;
  }
  return { existing, missing };
}

function trustedImageBase(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'assets.tcgdex.net') {
    throw new Error(`TCGdex returned an untrusted image origin: ${url.origin}`);
  }
  return url.href.replace(/\/+$/u, '');
}

function isWebp(bytes) {
  return (
    bytes.byteLength >= 20 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  );
}

function normalizedSetId(value) {
  return value
    .toLowerCase()
    .replaceAll('pt', '.')
    .replace(/[^a-z0-9]/gu, '')
    .replace(/^([a-z]+)0+/u, '$1');
}

function normalizedNumber(value) {
  const numeric = Number.parseInt(value, 10);
  return Number.isNaN(numeric) ? value.toLowerCase() : String(numeric);
}

async function tcgdexLanguageCards(language) {
  if (languageCards.has(language)) return languageCards.get(language);
  const response = await fetch(`https://api.tcgdex.net/v2/${encodeURIComponent(language)}/cards`, {
    headers: { 'user-agent': 'pokedex-local-art-seed/1' },
  });
  if (!response.ok) throw new Error(`TCGdex card list failed with status ${response.status}.`);
  const cards = await response.json();
  if (!Array.isArray(cards)) throw new Error('TCGdex card list was not an array.');
  languageCards.set(language, cards);
  return cards;
}

async function fallbackImageBase(source, bearer) {
  const { body } = await responseJson(
    `/api/desktop/catalogue/${encodeURIComponent(source.cardId)}`,
    { headers: { authorization: `Bearer ${bearer}` } },
  );
  const card = body.card;
  const candidates = (await tcgdexLanguageCards(source.language)).filter((candidate) => {
    if (
      typeof candidate?.id !== 'string' ||
      typeof candidate.localId !== 'string' ||
      typeof candidate.name !== 'string' ||
      typeof candidate.image !== 'string'
    ) {
      return false;
    }
    const separator = candidate.id.lastIndexOf('-');
    const setId = separator > 0 ? candidate.id.slice(0, separator) : '';
    return (
      candidate.name === card.name &&
      normalizedNumber(candidate.localId) === normalizedNumber(card.number) &&
      normalizedSetId(setId) === normalizedSetId(card.setId)
    );
  });
  if (candidates.length !== 1) return null;
  process.stdout.write(`//   resolved ${source.sourceId} as ${candidates[0].id}\n`);
  return trustedImageBase(candidates[0].image);
}

async function sourceImageBase(source, bearer) {
  if (source.provider !== 'tcgdex') return null;
  if (!/^[a-z]{2}$/u.test(source.language)) throw new Error('Invalid TCGdex language.');
  const detail = await fetch(
    `https://api.tcgdex.net/v2/${encodeURIComponent(source.language)}/cards/${encodeURIComponent(source.sourceId)}`,
    { headers: { 'user-agent': 'pokedex-local-art-seed/1' } },
  );
  if (detail.status === 404) return fallbackImageBase(source, bearer);
  if (!detail.ok) throw new Error(`TCGdex card lookup failed with status ${detail.status}.`);
  const card = await detail.json();
  return typeof card.image === 'string' ? trustedImageBase(card.image) : null;
}

async function downloadVariant(imageBase, variant) {
  const response = await fetch(`${imageBase}/${variant}.webp`, {
    headers: { 'user-agent': 'pokedex-local-art-seed/1' },
  });
  if (!response.ok) throw new Error(`TCGdex ${variant} art failed with status ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > maximumArtBytes) throw new Error(`TCGdex ${variant} art is too large.`);
  if (!isWebp(bytes)) throw new Error(`TCGdex ${variant} art is not valid WebP data.`);
  return {
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

async function uploadVariants(bearer, source, downloads) {
  const uploads = downloads.map(({ variant, bytes, sha256 }) => ({
    cardId: source.cardId,
    variant,
    sha256,
    maxBytes: bytes.byteLength,
  }));
  const ticketResponse = await responseJson('/api/desktop/art/upload-tokens/bulk', {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({ uploads }),
  });
  for (const ticket of ticketResponse.body.uploads ?? []) {
    const download = downloads.find(({ variant }) => variant === ticket.variant);
    if (!download) throw new Error('Art upload ticket did not match its requested variant.');
    await responseJson(ticket.uploadPath, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${ticket.token}`,
        'content-type': 'image/webp',
        'content-length': String(download.bytes.byteLength),
      },
      body: download.bytes,
    });
  }
}

const cookie = await browserSession();
let seeded = 0;
let skipped = 0;
const catalogue = await missingCatalogueSources(cookie);

if (catalogue.missing.length === 0) {
  process.stdout.write('// local art ready: no missing TCGdex images\n');
} else {
  try {
    const bearer = await desktopToken(cookie);

    for (const source of catalogue.missing) {
      if (interrupted) break;
      try {
        const imageBase = await sourceImageBase(source, bearer);
        if (!imageBase) {
          skipped += 1;
          continue;
        }
        const missingVariants = variants.filter(
          (variant) => !catalogue.existing.has(`${source.cardId}|${variant}`),
        );
        const downloads = [];
        for (const variant of missingVariants) {
          downloads.push({ variant, ...(await downloadVariant(imageBase, variant)) });
        }
        await uploadVariants(bearer, source, downloads);
        seeded += 1;
        process.stdout.write(`//   seeded ${source.cardId} (${missingVariants.join(' + ')})\n`);
      } catch (error) {
        skipped += 1;
        process.stderr.write(`//   skipped ${source.cardId}: ${error.message}\n`);
      }
    }

    if (!interrupted) {
      process.stdout.write(`// local art ready: ${seeded} seeded, ${skipped} skipped\n`);
    }
  } finally {
    await revokeSeedToken(cookie).catch((error) => {
      process.stderr.write(`// could not revoke the temporary art seed token: ${error.message}\n`);
    });
  }
}

if (interrupted) process.exitCode = 130;
