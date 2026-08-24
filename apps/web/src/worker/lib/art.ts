import { nowSeconds } from './db';

const MAX_ART_BYTES = 15 * 1024 * 1024;

export type ArtVariant = 'high' | 'low';

interface UploadTokenRow {
  owner_id: string;
  card_id: string;
  variant: ArtVariant;
  expected_sha256: string;
  max_bytes: number;
  expires_at: number;
  consumed_at: number | null;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256(value: BufferSource): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', value)));
}

export function isWebp(value: Uint8Array): boolean {
  return (
    value.byteLength >= 12 &&
    new TextDecoder().decode(value.slice(0, 4)) === 'RIFF' &&
    new TextDecoder().decode(value.slice(8, 12)) === 'WEBP'
  );
}

export function artObjectKey(cardId: string, variant: ArtVariant, checksum: string): string {
  if (!/^[a-f0-9]{64}$/u.test(checksum)) throw new Error('invalid_art_checksum');
  return `cards/${encodeURIComponent(cardId)}/${variant}/${checksum}.webp`;
}

async function hashToken(token: string): Promise<string> {
  return sha256(new TextEncoder().encode(token));
}

export async function createArtUploadToken(
  db: D1Database,
  ownerId: string,
  cardId: string,
  variant: ArtVariant,
  expectedSha256: string,
  maxBytes: number,
): Promise<string> {
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256) || maxBytes < 1 || maxBytes > MAX_ART_BYTES)
    throw new Error('invalid_art_upload_request');
  const card = await db
    .prepare('SELECT id FROM catalogue_cards WHERE id = ?1')
    .bind(cardId)
    .first();
  if (!card) throw new Error('card_not_found');
  const token = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
  const now = nowSeconds();
  await db
    .prepare(
      'INSERT INTO art_upload_tokens (token_hash, owner_id, card_id, variant, expected_sha256, max_bytes, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)',
    )
    .bind(
      await hashToken(token),
      ownerId,
      cardId,
      variant,
      expectedSha256,
      maxBytes,
      now + 900,
      now,
    )
    .run();
  return token;
}

export async function uploadArt(
  db: D1Database,
  art: R2Bucket,
  token: string,
  request: Request,
): Promise<{ cardId: string; variant: ArtVariant; objectKey: string }> {
  const upload = await db
    .prepare(
      'SELECT owner_id, card_id, variant, expected_sha256, max_bytes, expires_at, consumed_at FROM art_upload_tokens WHERE token_hash = ?1',
    )
    .bind(await hashToken(token))
    .first<UploadTokenRow>();
  if (!upload || upload.consumed_at !== null || upload.expires_at <= nowSeconds())
    throw new Error('art_upload_token_invalid');
  const declaredLength = Number(request.headers.get('content-length'));
  if (!Number.isInteger(declaredLength) || declaredLength < 1 || declaredLength > upload.max_bytes)
    throw new Error('art_upload_size_invalid');
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength !== declaredLength || buffer.byteLength > upload.max_bytes)
    throw new Error('art_upload_size_invalid');
  const data = new Uint8Array(buffer);
  if (!isWebp(data)) throw new Error('art_upload_not_webp');
  const checksum = await sha256(buffer);
  if (checksum !== upload.expected_sha256) throw new Error('art_upload_checksum_mismatch');
  const objectKey = artObjectKey(upload.card_id, upload.variant, checksum);
  const object = await art.put(objectKey, buffer, {
    httpMetadata: {
      contentType: 'image/webp',
      cacheControl: 'public, max-age=31536000, immutable',
    },
    customMetadata: { cardId: upload.card_id, variant: upload.variant, sha256: checksum },
  });
  const now = nowSeconds();
  await db.batch([
    db
      .prepare(
        'INSERT INTO art_manifest (card_id, variant, object_key, sha256, bytes, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(card_id, variant) DO UPDATE SET object_key = excluded.object_key, sha256 = excluded.sha256, bytes = excluded.bytes, updated_at = excluded.updated_at',
      )
      .bind(upload.card_id, upload.variant, objectKey, checksum, object.size, now),
    db
      .prepare('UPDATE art_upload_tokens SET consumed_at = ?1 WHERE token_hash = ?2')
      .bind(now, await hashToken(token)),
  ]);
  return { cardId: upload.card_id, variant: upload.variant, objectKey };
}

export async function getArtResponse(
  db: D1Database,
  art: R2Bucket,
  cardId: string,
  variant: ArtVariant,
  request: Request,
): Promise<Response | null> {
  const manifest = await db
    .prepare('SELECT object_key FROM art_manifest WHERE card_id = ?1 AND variant = ?2')
    .bind(cardId, variant)
    .first<{ object_key: string }>();
  if (!manifest) return null;
  const object = await art.get(manifest.object_key, { range: request.headers });
  if (!object) return null;
  if (!('body' in object)) return null;
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('cache-control', 'private, max-age=31536000, immutable');
  return new Response(object.body, { headers, status: object.range ? 206 : 200 });
}

export async function listArtManifest(
  db: D1Database,
  cursor: string | null,
  limit: number,
): Promise<{
  entries: Array<{ cardId: string; variant: ArtVariant; sha256: string; bytes: number }>;
  cursor: string | null;
}> {
  const [cardId, variant] = cursor?.split('|', 2) ?? ['', ''];
  const result = await db
    .prepare(
      'SELECT card_id, variant, sha256, bytes FROM art_manifest WHERE card_id > ?1 OR (card_id = ?1 AND variant > ?2) ORDER BY card_id, variant LIMIT ?3',
    )
    .bind(cardId, variant, limit + 1)
    .all<{ card_id: string; variant: ArtVariant; sha256: string; bytes: number }>();
  const rows = result.results.slice(0, limit);
  const extra = result.results.length > limit;
  return {
    entries: rows.map((row) => ({
      cardId: row.card_id,
      variant: row.variant,
      sha256: row.sha256,
      bytes: row.bytes,
    })),
    cursor:
      extra && rows.length > 0
        ? `${rows.at(-1)?.card_id ?? ''}|${rows.at(-1)?.variant ?? ''}`
        : null,
  };
}
