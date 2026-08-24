import { nowSeconds } from './db';
import { ApplicationError, describeError, logWarn } from './log';

const MAX_ART_BYTES = 15 * 1024 * 1024;
const ORPHAN_GRACE_SECONDS = 60 * 60;

export type ArtVariant = 'high' | 'low';

interface UploadTokenRow {
  owner_id: string;
  card_id: string;
  variant: ArtVariant;
  expected_sha256: string;
  expected_version: number;
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

function ascii(value: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...value.slice(start, start + length));
}

export function isWebp(value: Uint8Array): boolean {
  if (value.byteLength < 20 || ascii(value, 0, 4) !== 'RIFF' || ascii(value, 8, 4) !== 'WEBP')
    return false;
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  if (view.getUint32(4, true) !== value.byteLength - 8) return false;
  let offset = 12;
  let imageChunk = false;
  while (offset + 8 <= value.byteLength) {
    const kind = ascii(value, offset, 4);
    const length = view.getUint32(offset + 4, true);
    const next = offset + 8 + length + (length % 2);
    if (next > value.byteLength) return false;
    if (kind === 'VP8 ' || kind === 'VP8L' || kind === 'VP8X' || kind === 'ANMF') imageChunk = true;
    offset = next;
  }
  return imageChunk && offset === value.byteLength;
}

export function artObjectKey(cardId: string, variant: ArtVariant, checksum: string): string {
  if (!/^[a-f0-9]{64}$/u.test(checksum)) throw new ApplicationError('invalid_art_checksum', 400);
  return `cards/${encodeURIComponent(cardId)}/${variant}/${checksum}.webp`;
}

async function hashToken(token: string): Promise<string> {
  return sha256(new TextEncoder().encode(token));
}

async function readBoundedBody(request: Request, maximum: number): Promise<ArrayBuffer> {
  if (!request.body) throw new ApplicationError('art_upload_size_invalid', 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maximum) {
      await reader.cancel('art upload exceeded maximum size');
      throw new ApplicationError('art_upload_size_invalid', 413);
    }
    chunks.push(next.value);
  }
  if (total < 1) throw new ApplicationError('art_upload_size_invalid', 400);
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined.buffer;
}

async function recordOrphan(db: D1Database, objectKey: string, reason: string): Promise<void> {
  await db
    .prepare(
      'INSERT INTO art_orphans (object_key, reason, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(object_key) DO UPDATE SET reason = excluded.reason, created_at = excluded.created_at',
    )
    .bind(objectKey, reason, nowSeconds())
    .run();
}

export async function cleanupArtOrphans(
  db: D1Database,
  art: R2Bucket,
  cutoff = nowSeconds() - ORPHAN_GRACE_SECONDS,
  limit = 25,
): Promise<number> {
  const rows = await db
    .prepare(
      'SELECT object_key FROM art_orphans o WHERE o.created_at <= ?1 AND NOT EXISTS (SELECT 1 FROM art_manifest m WHERE m.object_key = o.object_key) ORDER BY o.created_at LIMIT ?2',
    )
    .bind(cutoff, limit)
    .all<{ object_key: string }>();
  let deleted = 0;
  for (const row of rows.results) {
    try {
      await art.delete(row.object_key);
      await db.prepare('DELETE FROM art_orphans WHERE object_key = ?1').bind(row.object_key).run();
      deleted += 1;
    } catch (error) {
      logWarn({
        evt: 'art.orphan_cleanup_failed',
        objectKey: row.object_key,
        err: describeError(error),
      });
    }
  }
  return deleted;
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
    throw new ApplicationError('invalid_art_upload_request', 400);
  const card = await db
    .prepare(
      `SELECT c.id, COALESCE(m.version, 0) AS current_version FROM catalogue_cards c
       LEFT JOIN art_manifest m ON m.card_id = c.id AND m.variant = ?2 WHERE c.id = ?1`,
    )
    .bind(cardId, variant)
    .first<{ id: string; current_version: number }>();
  if (!card) throw new ApplicationError('card_not_found', 404);
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll('-', '');
  const now = nowSeconds();
  await db
    .prepare(
      'INSERT INTO art_upload_tokens (token_hash, owner_id, card_id, variant, expected_sha256, expected_version, max_bytes, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)',
    )
    .bind(
      await hashToken(token),
      ownerId,
      cardId,
      variant,
      expectedSha256,
      card.current_version + 1,
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
  const tokenHash = await hashToken(token);
  const upload = await db
    .prepare(
      'SELECT owner_id, card_id, variant, expected_sha256, expected_version, max_bytes, expires_at, consumed_at FROM art_upload_tokens WHERE token_hash = ?1',
    )
    .bind(tokenHash)
    .first<UploadTokenRow>();
  if (!upload || upload.consumed_at !== null || upload.expires_at <= nowSeconds())
    throw new ApplicationError('art_upload_token_invalid', 400);
  const claimedAt = nowSeconds();
  const claim = await db
    .prepare(
      'UPDATE art_upload_tokens SET consumed_at = ?1 WHERE token_hash = ?2 AND consumed_at IS NULL AND expires_at > ?1',
    )
    .bind(claimedAt, tokenHash)
    .run();
  if (claim.meta.changes !== 1) throw new ApplicationError('art_upload_token_invalid', 409);

  const declaredLength = Number(request.headers.get('content-length'));
  if (!Number.isInteger(declaredLength) || declaredLength < 1 || declaredLength > upload.max_bytes)
    throw new ApplicationError('art_upload_size_invalid', 413);
  const buffer = await readBoundedBody(request, Math.min(upload.max_bytes, MAX_ART_BYTES));
  if (buffer.byteLength !== declaredLength)
    throw new ApplicationError('art_upload_size_invalid', 400);
  const data = new Uint8Array(buffer);
  if (!isWebp(data)) throw new ApplicationError('art_upload_not_webp', 400);
  const checksum = await sha256(buffer);
  if (checksum !== upload.expected_sha256)
    throw new ApplicationError('art_upload_checksum_mismatch', 400);

  const previous = await db
    .prepare('SELECT object_key, version FROM art_manifest WHERE card_id = ?1 AND variant = ?2')
    .bind(upload.card_id, upload.variant)
    .first<{ object_key: string; version: number }>();
  const objectKey = artObjectKey(upload.card_id, upload.variant, checksum);
  const object = await art.put(objectKey, buffer, {
    httpMetadata: {
      contentType: 'image/webp',
      cacheControl: 'public, max-age=31536000, immutable',
    },
    customMetadata: {
      cardId: upload.card_id,
      variant: upload.variant,
      sha256: checksum,
      version: String(upload.expected_version),
    },
    sha256: checksum,
  });
  const now = nowSeconds();
  const manifest = await db
    .prepare(
      `INSERT INTO art_manifest (card_id, variant, object_key, sha256, bytes, version, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(card_id, variant) DO UPDATE SET object_key = excluded.object_key,
         sha256 = excluded.sha256, bytes = excluded.bytes, version = excluded.version,
         updated_at = excluded.updated_at WHERE art_manifest.version < excluded.version`,
    )
    .bind(
      upload.card_id,
      upload.variant,
      objectKey,
      checksum,
      object.size,
      upload.expected_version,
      now,
    )
    .run();
  if (manifest.meta.changes !== 1) {
    await recordOrphan(db, objectKey, 'manifest_version_conflict');
    await cleanupArtOrphans(db, art, now);
    throw new ApplicationError('art_upload_version_conflict', 409);
  }
  if (previous && previous.object_key !== objectKey)
    await recordOrphan(db, previous.object_key, 'manifest_superseded');
  await cleanupArtOrphans(db, art);
  return { cardId: upload.card_id, variant: upload.variant, objectKey };
}

function validRangeHeader(value: string | null): boolean {
  return value === null || /^bytes=(?:\d+-\d*|-\d+)$/u.test(value);
}

function normalizedRange(range: R2Range, size: number): { offset: number; length: number } {
  if ('suffix' in range) {
    const length = Math.min(range.suffix, size);
    return { offset: size - length, length };
  }
  const offset = range.offset ?? 0;
  return { offset, length: range.length ?? Math.max(0, size - offset) };
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
  const rangeHeader = request.headers.get('range');
  if (!validRangeHeader(rangeHeader))
    return new Response(null, { status: 416, headers: { 'accept-ranges': 'bytes' } });
  const object = await art.get(manifest.object_key, { range: request.headers });
  if (!object || !('body' in object)) return null;
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('cache-control', 'private, max-age=31536000, immutable');
  headers.set('accept-ranges', 'bytes');
  if (object.range) {
    const range = normalizedRange(object.range, object.size);
    headers.set(
      'content-range',
      `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`,
    );
    headers.set('content-length', String(range.length));
  } else {
    headers.set('content-length', String(object.size));
  }
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
  return {
    entries: rows.map((row) => ({
      cardId: row.card_id,
      variant: row.variant,
      sha256: row.sha256,
      bytes: row.bytes,
    })),
    cursor:
      result.results.length > limit && rows.length > 0
        ? `${rows.at(-1)?.card_id ?? ''}|${rows.at(-1)?.variant ?? ''}`
        : null,
  };
}
