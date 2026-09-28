import { DESKTOP_SCOPES, type DesktopScope } from '@pokedex/shared';
import { nowSeconds } from './db';
import { ApplicationError } from './log';

const DESKTOP_TOKEN_MAX_AGE = 60 * 60 * 24 * 90;
const DESKTOP_ACTIVITY_INTERVAL = 60 * 60;

async function hashText(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function validScopes(value: unknown): value is DesktopScope[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (scope) => typeof scope === 'string' && DESKTOP_SCOPES.some((known) => known === scope),
    )
  );
}

export async function createPairCode(
  db: D1Database,
  ownerId: string,
  scopes: DesktopScope[],
): Promise<string> {
  if (!validScopes(scopes)) throw new ApplicationError('invalid_desktop_scopes', 400);
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const code = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
  const now = nowSeconds();
  await db.batch([
    db
      .prepare('DELETE FROM desktop_pair_codes WHERE expires_at <= ?1 OR consumed_at IS NOT NULL')
      .bind(now),
    db
      .prepare('DELETE FROM desktop_tokens WHERE expires_at IS NOT NULL AND expires_at <= ?1')
      .bind(now),
    db
      .prepare(
        'INSERT INTO desktop_pair_codes (code_hash, owner_id, scopes, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5)',
      )
      .bind(await hashText(code), ownerId, JSON.stringify(scopes), now + 600, now),
  ]);
  return code;
}

export async function redeemPairCode(
  db: D1Database,
  code: string,
  label: string,
): Promise<{ token: string; scopes: DesktopScope[] }> {
  const codeHash = await hashText(code.trim().toUpperCase());
  const row = await db
    .prepare('SELECT scopes FROM desktop_pair_codes WHERE code_hash = ?1')
    .bind(codeHash)
    .first<{ scopes: string }>();
  const parsedScopes: unknown = row ? JSON.parse(row.scopes) : null;
  if (!validScopes(parsedScopes)) throw new ApplicationError('pair_code_invalid', 400);
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll('-', '');
  const tokenHash = await hashText(token);
  const now = nowSeconds();
  try {
    // Joins to users and requires the code's owner still active at the
    // moment the token is minted — a code issued before the owner was
    // disabled must not still hand out a working token afterward.
    const [inserted] = await db.batch([
      db
        .prepare(
          `INSERT INTO desktop_tokens (token_hash, owner_id, label, scopes, pair_code_hash, expires_at, created_at)
           SELECT ?1, dpc.owner_id, ?2, dpc.scopes, dpc.code_hash, ?3, ?4 FROM desktop_pair_codes dpc
           JOIN users u ON u.id = dpc.owner_id
           WHERE dpc.code_hash = ?5 AND dpc.consumed_at IS NULL AND dpc.expires_at > ?4
             AND u.disabled_at IS NULL`,
        )
        .bind(tokenHash, label, now + DESKTOP_TOKEN_MAX_AGE, now, codeHash),
      db
        .prepare(
          'UPDATE desktop_pair_codes SET consumed_at = ?1 WHERE code_hash = ?2 AND consumed_at IS NULL AND expires_at > ?1',
        )
        .bind(now, codeHash),
    ]);
    if (inserted?.meta.changes !== 1) throw new ApplicationError('pair_code_invalid', 400);
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError('pair_code_already_consumed', 409);
  }
  return { token, scopes: parsedScopes };
}

export async function requireDesktopToken(
  db: D1Database,
  token: string,
  scope: DesktopScope,
): Promise<string> {
  const tokenHash = await hashText(token);
  const now = nowSeconds();
  // Joined to users so a token whose owner has since been disabled stops
  // validating on its very next use, the same request it's revoked on
  // disable notwithstanding (belt-and-braces against any token that slips
  // past that revoke, e.g. one minted in the same race window as the
  // disable itself).
  const row = await db
    .prepare(
      `SELECT dt.owner_id, dt.scopes, dt.expires_at, dt.revoked_at, dt.last_used_at
       FROM desktop_tokens dt JOIN users u ON u.id = dt.owner_id
       WHERE dt.token_hash = ?1 AND u.disabled_at IS NULL`,
    )
    .bind(tokenHash)
    .first<{
      owner_id: string;
      scopes: string;
      expires_at: number | null;
      revoked_at: number | null;
      last_used_at: number | null;
    }>();
  if (!row || row.revoked_at !== null || (row.expires_at !== null && row.expires_at <= now))
    throw new ApplicationError('desktop_token_invalid', 401);
  const scopesValue: unknown = JSON.parse(row.scopes);
  if (!validScopes(scopesValue) || !scopesValue.includes(scope))
    throw new ApplicationError('desktop_token_scope_missing', 403);
  if (row.last_used_at === null || row.last_used_at <= now - DESKTOP_ACTIVITY_INTERVAL)
    await db
      .prepare(
        'UPDATE desktop_tokens SET last_used_at = ?1 WHERE token_hash = ?2 AND (last_used_at IS NULL OR last_used_at <= ?3)',
      )
      .bind(now, tokenHash, now - DESKTOP_ACTIVITY_INTERVAL)
      .run();
  return row.owner_id;
}

export async function listDesktopTokens(
  db: D1Database,
  ownerId: string,
): Promise<
  Array<{
    id: string;
    label: string;
    scopes: DesktopScope[];
    expiresAt: string | null;
    revokedAt: string | null;
    lastUsedAt: string | null;
  }>
> {
  const result = await db
    .prepare(
      'SELECT token_hash, label, scopes, expires_at, revoked_at, last_used_at FROM desktop_tokens WHERE owner_id = ?1 ORDER BY created_at DESC',
    )
    .bind(ownerId)
    .all<{
      token_hash: string;
      label: string;
      scopes: string;
      expires_at: number | null;
      revoked_at: number | null;
      last_used_at: number | null;
    }>();
  return result.results.flatMap((row) => {
    const scopes: unknown = JSON.parse(row.scopes);
    return validScopes(scopes)
      ? [
          {
            id: row.token_hash,
            label: row.label,
            scopes,
            expiresAt: row.expires_at ? new Date(row.expires_at * 1000).toISOString() : null,
            revokedAt: row.revoked_at ? new Date(row.revoked_at * 1000).toISOString() : null,
            lastUsedAt: row.last_used_at ? new Date(row.last_used_at * 1000).toISOString() : null,
          },
        ]
      : [];
  });
}

export async function revokeDesktopToken(
  db: D1Database,
  ownerId: string,
  tokenId: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      'UPDATE desktop_tokens SET revoked_at = ?1 WHERE token_hash = ?2 AND owner_id = ?3 AND revoked_at IS NULL',
    )
    .bind(nowSeconds(), tokenId, ownerId)
    .run();
  return result.meta.changes === 1;
}
