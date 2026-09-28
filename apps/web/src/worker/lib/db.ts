export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export function isoFromSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function asPositiveInt(
  value: string | undefined,
  fallback: number,
  maximum: number,
): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

export function escapedFtsQuery(query: string): string | null {
  const tokens = query
    .trim()
    .split(/\s+/u)
    .map((token) => token.replaceAll('"', ''))
    .filter((token) => token.length > 0)
    .slice(0, 8);
  return tokens.length === 0 ? null : tokens.map((token) => `"${token}"*`).join(' AND ');
}

export async function requireCard(db: D1Database, cardId: string): Promise<void> {
  const found = await db
    .prepare('SELECT id FROM catalogue_cards WHERE id = ?1')
    .bind(cardId)
    .first();
  if (!found) throw new Error('card_not_found');
}

// A binder slot's public address: the (already-exposed) page id plus its grid
// coordinates. Stable for the life of the page, unlike an array index. Lives
// here rather than in binders.ts/collection.ts so both can use it without a
// circular import.
export function encodeSlotId(pageId: string, row: number, column: number): string {
  return `${pageId}:${row}:${column}`;
}

export function decodeSlotId(
  slotId: string,
): { pageId: string; row: number; column: number } | null {
  const lastColon = slotId.lastIndexOf(':');
  if (lastColon < 0) return null;
  const secondLastColon = slotId.lastIndexOf(':', lastColon - 1);
  if (secondLastColon < 0) return null;
  const pageId = slotId.slice(0, secondLastColon);
  const row = Number.parseInt(slotId.slice(secondLastColon + 1, lastColon), 10);
  const column = Number.parseInt(slotId.slice(lastColon + 1), 10);
  if (!pageId || !Number.isInteger(row) || row < 0 || !Number.isInteger(column) || column < 0)
    return null;
  return { pageId, row, column };
}

export async function scalarCount(
  db: D1Database,
  sql: string,
  ...values: unknown[]
): Promise<number> {
  const row = await db
    .prepare(sql)
    .bind(...values)
    .first<{ count: number }>();
  return row?.count ?? 0;
}
