import { DEFAULT_FRAME_PALETTE, framePaletteSchema, type FramePalette } from '@pokedex/shared';
import { nowSeconds } from './db';

const FRAME_PALETTE_KEY = 'frame-palette';
const FAVORITE_ILLUSTRATORS_KEY = 'favorite-illustrators';

interface SettingRow {
  value_json: string;
}

function parsePalette(json: string): FramePalette {
  try {
    const parsed = framePaletteSchema.safeParse(JSON.parse(json));
    // A corrupt or outdated stored value is treated as "nothing overridden"
    // rather than a failure; the caller always has DEFAULT_FRAME_PALETTE to
    // fall back on.
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export async function getFramePalette(db: D1Database, ownerId: string): Promise<FramePalette> {
  const row = await db
    .prepare('SELECT value_json FROM user_settings WHERE owner_id = ?1 AND key = ?2')
    .bind(ownerId, FRAME_PALETTE_KEY)
    .first<SettingRow>();
  return row ? parsePalette(row.value_json) : {};
}

export async function setFramePalette(
  db: D1Database,
  ownerId: string,
  palette: FramePalette,
): Promise<FramePalette> {
  await db
    .prepare(
      `INSERT INTO user_settings (owner_id, key, value_json, updated_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(owner_id, key) DO UPDATE SET
         value_json = excluded.value_json, updated_at = excluded.updated_at`,
    )
    .bind(ownerId, FRAME_PALETTE_KEY, JSON.stringify(palette), nowSeconds())
    .run();
  return palette;
}

export async function resetFramePalette(db: D1Database, ownerId: string): Promise<void> {
  await db
    .prepare('DELETE FROM user_settings WHERE owner_id = ?1 AND key = ?2')
    .bind(ownerId, FRAME_PALETTE_KEY)
    .run();
}

export function frameColour(
  palette: FramePalette,
  type: keyof typeof DEFAULT_FRAME_PALETTE,
): string {
  return palette[type] ?? DEFAULT_FRAME_PALETTE[type];
}

/** The illustrator names this owner starred, as stored; an unreadable value counts as none. */
export async function getFavoriteIllustrators(
  db: D1Database,
  ownerId: string,
): Promise<Set<string>> {
  const row = await db
    .prepare('SELECT value_json FROM user_settings WHERE owner_id = ?1 AND key = ?2')
    .bind(ownerId, FAVORITE_ILLUSTRATORS_KEY)
    .first<SettingRow>();
  if (!row) return new Set();
  try {
    const parsed: unknown = JSON.parse(row.value_json);
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === 'string')
        : [],
    );
  } catch {
    return new Set();
  }
}

/**
 * Stars or unstars one illustrator. Each change is a single statement that edits the
 * stored list in place, so two quick taps on different tiles can't overwrite each
 * other the way a read-then-write of the whole list could.
 */
export async function setIllustratorFavorite(
  db: D1Database,
  ownerId: string,
  name: string,
  favorite: boolean,
): Promise<void> {
  if (favorite) {
    await db
      .prepare(
        `INSERT INTO user_settings (owner_id, key, value_json, updated_at)
         VALUES (?1, ?2, json_array(?3), ?4)
         ON CONFLICT(owner_id, key) DO UPDATE SET
           value_json = CASE
             WHEN EXISTS (SELECT 1 FROM json_each(user_settings.value_json) WHERE value = ?3)
               THEN user_settings.value_json
             ELSE json_insert(user_settings.value_json, '$[#]', ?3)
           END,
           updated_at = ?4`,
      )
      .bind(ownerId, FAVORITE_ILLUSTRATORS_KEY, name, nowSeconds())
      .run();
    return;
  }
  await db
    .prepare(
      `UPDATE user_settings SET
         value_json = (SELECT json_group_array(value) FROM json_each(user_settings.value_json)
                       WHERE value <> ?3),
         updated_at = ?4
       WHERE owner_id = ?1 AND key = ?2`,
    )
    .bind(ownerId, FAVORITE_ILLUSTRATORS_KEY, name, nowSeconds())
    .run();
}
