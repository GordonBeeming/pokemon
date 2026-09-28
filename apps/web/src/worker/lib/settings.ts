import { DEFAULT_FRAME_PALETTE, framePaletteSchema, type FramePalette } from '@pokedex/shared';
import { nowSeconds } from './db';

const FRAME_PALETTE_KEY = 'frame-palette';

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
