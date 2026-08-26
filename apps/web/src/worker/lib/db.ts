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
