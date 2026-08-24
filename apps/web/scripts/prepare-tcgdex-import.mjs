import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

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

const numericCardNumber = (value) => {
  const matched = value.match(/\d+/u)?.at(0);
  if (!matched) return null;
  const parsed = Number.parseInt(matched, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

export const transformCard = (card, language) => {
  if (typeof card !== 'object' || card === null) throw new Error('invalid TCGdex card');
  const sourceId = typeof card.id === 'string' ? card.id : null;
  const name = typeof card.name === 'string' ? card.name : null;
  const set = typeof card.set === 'object' && card.set !== null ? card.set : null;
  const setId = set && typeof set.id === 'string' ? set.id : null;
  const setName = set && typeof set.name === 'string' ? set.name : null;
  const number =
    typeof card.localId === 'string' || typeof card.localId === 'number'
      ? String(card.localId)
      : null;
  if (!sourceId || !name || !setId || !setName || !number)
    throw new Error('TCGdex card is missing a stable field');
  if (
    (typeof set.logo === 'string' && set.logo.includes('/tcgp/')) ||
    (typeof set.symbol === 'string' && set.symbol.includes('/tcgp/'))
  )
    return null;
  const category =
    card.category === 'Pokemon'
      ? 'pokemon'
      : card.category === 'Trainer'
        ? 'trainer'
        : card.category === 'Energy'
          ? 'energy'
          : 'special';
  const serialized = JSON.stringify(card);
  const dexIds = Array.isArray(card.dexId)
    ? card.dexId.filter((value) => Number.isInteger(value) && value > 0)
    : typeof card.dexId === 'number' && Number.isInteger(card.dexId) && card.dexId > 0
      ? [card.dexId]
      : [];
  const releaseDate =
    typeof set.releaseDate === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(set.releaseDate)
      ? set.releaseDate
      : null;
  return {
    sourceId,
    checksum: createHash('sha256').update(serialized).digest('hex'),
    sourceUpdatedAt:
      typeof (card.updated ?? card.updatedAt) === 'string' &&
      Number.isFinite(Date.parse(card.updated ?? card.updatedAt))
        ? Math.floor(Date.parse(card.updated ?? card.updatedAt) / 1000)
        : 0,
    name,
    language,
    category,
    setId,
    setName,
    number,
    numberSort: numericCardNumber(number),
    supertype: typeof card.category === 'string' ? card.category : null,
    subtype: Array.isArray(card.types)
      ? card.types.filter((item) => typeof item === 'string').join(', ') || null
      : null,
    species: category === 'pokemon' ? name : null,
    rarity: typeof card.rarity === 'string' ? card.rarity : null,
    artist: typeof card.illustrator === 'string' ? card.illustrator : null,
    releaseDate,
    pokedexNumber: dexIds.length > 0 ? Math.min(...dexIds) : null,
  };
};

export const prepareImport = (raw, language) => {
  if (!physicalLanguages.has(language)) throw new Error('invalid physical language');
  if (!Array.isArray(raw)) throw new Error('TCGdex source must be an array');
  return {
    provider: 'tcgdex',
    language,
    cards: raw.map((card) => transformCard(card, language)).filter((card) => card !== null),
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [filePath, language] = process.argv.slice(2);
  if (!filePath || !language || !physicalLanguages.has(language) || filePath.includes('/tcgp/'))
    throw new Error('usage: node prepare-tcgdex-import.mjs <physical-language-json> <language>');
  const raw = JSON.parse(await readFile(filePath, 'utf8'));
  process.stdout.write(`${JSON.stringify(prepareImport(raw, language))}\n`);
}
