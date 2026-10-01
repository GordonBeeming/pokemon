import { z } from 'zod';

/**
 * TanStack Router decodes the query string into a plain object before `validateSearch`
 * runs, but a stale or hand-edited URL can carry the wrong type for any key. Every
 * route here drops an invalid or unknown value back to its default instead of
 * throwing, so a bad `?page=nope` degrades to page 1 rather than crashing the route.
 */
function dropInvalid<Shape extends z.ZodRawShape>(
  schema: z.ZodObject<Shape>,
  raw: Record<string, unknown>,
): z.infer<z.ZodObject<Shape>> {
  const accepted: Record<string, unknown> = {};
  for (const key of Object.keys(schema.shape)) {
    const fieldSchema = schema.shape[key] as z.ZodTypeAny;
    const result = fieldSchema.safeParse(raw[key]);
    if (result.success) accepted[key] = result.data;
  }
  return schema.parse(accepted);
}

// The router parses query values as JSON, so free text that happens to be all digits
// ("33", a card number or a numeric search) arrives as a number; read it back as text.
function text() {
  return z.preprocess((value) => (typeof value === 'number' ? String(value) : value), z.string());
}

// List params can arrive as a real array (repeated keys) or as one comma-joined
// string (a typed-in or bookmarked URL), so both shapes are accepted on the way in.
function csv<Item extends z.ZodTypeAny>(item: Item) {
  return z
    .union([z.array(z.unknown()), z.string()])
    .transform((value): unknown[] => (Array.isArray(value) ? value : value.split(',')))
    .transform((list) =>
      list
        .map((entry) => (typeof entry === 'string' ? entry.trim() : entry))
        .filter((entry) => entry !== ''),
    )
    .pipe(z.array(item));
}

function defineSearchParams<Shape extends z.ZodRawShape>(schema: z.ZodObject<Shape>) {
  type Search = z.infer<typeof schema>;
  return {
    schema,
    parse: (raw: Record<string, unknown>): Search => dropInvalid(schema, raw),
    // The inverse of parse: a typed search object back to the raw string map the
    // router serialises into the query string. Arrays join on commas to match csv().
    serialize: (search: Search): Record<string, string> => {
      const raw: Record<string, string> = {};
      for (const [key, value] of Object.entries(search)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
          const items = value as unknown[];
          if (items.length > 0) raw[key] = items.map(String).join(',');
          continue;
        }
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
          raw[key] = String(value);
      }
      return raw;
    },
  };
}

export const catalogueOwnedFilters = ['all', 'owned', 'missing'] as const;
export const catalogueSortOrders = [
  'relevance',
  'set-number',
  'release-date',
  'pokedex-number',
  'name',
] as const;

const catalogueSearchSchema = z.object({
  q: text().default(''),
  // The printed card number, on top of the search text: "Squirtle" then "33".
  number: text().pipe(z.string().trim().max(32)).default(''),
  type: csv(z.string()).default([]),
  region: z.string().min(1).optional(),
  rarity: csv(z.string()).default([]),
  set: csv(z.string()).default([]),
  artist: z.string().trim().min(1).max(200).optional(),
  // Preserved from Sets & codes: a Japanese-language set stays scoped to Japanese
  // printings after the jump into Catalogue (worker's catalogueFilters already
  // accepts this as `language`).
  language: z.string().min(1).optional(),
  owned: z.enum(catalogueOwnedFilters).default('all'),
  sort: z.enum(catalogueSortOrders).default('relevance'),
  page: z.coerce.number().int().min(1).default(1),
  card: z.string().min(1).optional(),
  // A species opened from the National Pokédex: scopes the gallery to that
  // Pokédex number and drives the "Species card gallery" contextual header.
  dex: z.coerce.number().int().min(1).max(1025).optional(),
});
export const catalogueSearch = defineSearchParams(catalogueSearchSchema);
export type CatalogueSearch = z.infer<typeof catalogueSearchSchema>;
export type CatalogueOwnedFilter = (typeof catalogueOwnedFilters)[number];

export const pokedexFilters = ['all', 'owned', 'missing'] as const;

const pokedexSearchSchema = z.object({
  q: text().default(''),
  region: z.string().min(1).optional(),
  filter: z.enum(pokedexFilters).default('all'),
  page: z.coerce.number().int().min(1).default(1),
  // The focused tile — restored on return from a species gallery, per FEATURES.md's
  // "focused tile survives leaving and returning".
  dex: z.coerce.number().int().min(1).max(1025).optional(),
});
export const pokedexSearch = defineSearchParams(pokedexSearchSchema);
export type PokedexSearch = z.infer<typeof pokedexSearchSchema>;
export type PokedexOwnedFilter = (typeof pokedexFilters)[number];

const setsSearchSchema = z.object({
  set: z.string().min(1).optional(),
});
export const setsSearch = defineSearchParams(setsSearchSchema);
export type SetsSearch = z.infer<typeof setsSearchSchema>;

export const illustratorSortOrders = ['name', 'card-count'] as const;

const illustratorsSearchSchema = z.object({
  q: text().default(''),
  sort: z.enum(illustratorSortOrders).default('name'),
});
export const illustratorsSearch = defineSearchParams(illustratorsSearchSchema);
export type IllustratorsSearch = z.infer<typeof illustratorsSearchSchema>;
export type IllustratorSortOrder = (typeof illustratorSortOrders)[number];

export const binderModes = ['move', 'paste', 'insert'] as const;

// `page` is 1-based so the URL matches the "Page n of total" the screen shows. `v` opens
// a specific binder version (a draft being edited); without it the active version shows.
const binderSearchSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  v: z.string().min(1).max(128).optional(),
  sel: z.string().min(1).max(200).optional(),
  mode: z.enum(binderModes).optional(),
  q: text().default(''),
});
export const binderSearch = defineSearchParams(binderSearchSchema);
export type BinderSearch = z.infer<typeof binderSearchSchema>;

export const settingsTabs = [
  'passkeys',
  'frame-colours',
  'api-tokens',
  'custom-cards',
  'catalogue-sync',
  'people',
] as const;

const settingsSearchSchema = z.object({
  tab: z.enum(settingsTabs).default('passkeys'),
});
export const settingsSearch = defineSearchParams(settingsSearchSchema);
export type SettingsSearch = z.infer<typeof settingsSearchSchema>;
