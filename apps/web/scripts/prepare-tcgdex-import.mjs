import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const physicalLanguages = new Set([
  'en',
  'fr',
  'es',
  'es-mx',
  'it',
  'pt',
  'pt-br',
  'pt-pt',
  'de',
  'nl',
  'pl',
  'ru',
  'ja',
  'ko',
  'zh-tw',
  'id',
  'th',
  'zh-cn',
]);

const [filePath, language] = process.argv.slice(2);
if (!filePath || !language || !physicalLanguages.has(language) || filePath.includes('/tcgp/')) {
  throw new Error('usage: node prepare-tcgdex-import.mjs <physical-language-json> <language>');
}

const raw = JSON.parse(await readFile(filePath, 'utf8'));
if (!Array.isArray(raw)) throw new Error('TCGdex source must be an array');

const cards = raw.map((card) => {
  if (typeof card !== 'object' || card === null) throw new Error('invalid TCGdex card');
  const sourceId = typeof card.id === 'string' ? card.id : null;
  const name = typeof card.name === 'string' ? card.name : null;
  const set = typeof card.set === 'object' && card.set !== null ? card.set : null;
  const setId = set && typeof set.id === 'string' ? set.id : null;
  const setName = set && typeof set.name === 'string' ? set.name : null;
  const number = typeof card.localId === 'string' ? card.localId : null;
  if (!sourceId || !name || !setId || !setName || !number)
    throw new Error('TCGdex card is missing a stable field');
  const category =
    card.category === 'Pokemon'
      ? 'pokemon'
      : card.category === 'Trainer'
        ? 'trainer'
        : card.category === 'Energy'
          ? 'energy'
          : 'special';
  const serialized = JSON.stringify(card);
  return {
    sourceId,
    checksum: createHash('sha256').update(serialized).digest('hex'),
    sourceUpdatedAt:
      typeof card.updatedAt === 'string' && Number.isFinite(Date.parse(card.updatedAt))
        ? Math.floor(Date.parse(card.updatedAt) / 1000)
        : 0,
    name,
    language,
    category,
    setId,
    setName,
    number,
    supertype: typeof card.category === 'string' ? card.category : null,
    subtype: Array.isArray(card.types)
      ? card.types.filter((item) => typeof item === 'string').join(', ') || null
      : null,
    species: Array.isArray(card.dexId)
      ? card.dexId
          .filter((value) => typeof value === 'number')
          .map(String)
          .join(', ') || null
      : typeof card.dexId === 'number'
        ? String(card.dexId)
        : null,
    rarity: typeof card.rarity === 'string' ? card.rarity : null,
    artist: typeof card.illustrator === 'string' ? card.illustrator : null,
  };
});

process.stdout.write(`${JSON.stringify({ provider: 'tcgdex', language, cards })}\n`);
