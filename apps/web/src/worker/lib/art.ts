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
  committed_object_key: string | null;
}

export interface ArtUploadRequest {
  cardId: string;
  variant: ArtVariant;
  sha256: string;
  maxBytes: number;
}

export interface ArtUploadTicket extends ArtUploadRequest {
  token: string;
  ticketId: string;
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

function ticketId(tokenHash: string): string {
  return tokenHash.slice(0, 24);
}

async function isWebpObject(object: R2ObjectBody): Promise<boolean> {
  const reader = object.body.getReader();
  const header = new Uint8Array(12);
  const chunkHeader = new Uint8Array(8);
  let headerBytes = 0;
  let chunkHeaderBytes = 0;
  let chunkRemaining = 0;
  let position = 0;
  let imageChunk = false;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    const value: unknown = next.value;
    if (!(value instanceof Uint8Array)) return false;
    let offset = 0;
    while (offset < value.byteLength) {
      if (headerBytes < header.byteLength) {
        const length = Math.min(header.byteLength - headerBytes, value.byteLength - offset);
        header.set(value.subarray(offset, offset + length), headerBytes);
        headerBytes += length;
        offset += length;
        position += length;
        if (headerBytes === header.byteLength) {
          const view = new DataView(header.buffer);
          if (
            ascii(header, 0, 4) !== 'RIFF' ||
            ascii(header, 8, 4) !== 'WEBP' ||
            view.getUint32(4, true) !== object.size - 8
          )
            return false;
        }
        continue;
      }
      if (chunkRemaining > 0) {
        const length = Math.min(chunkRemaining, value.byteLength - offset);
        chunkRemaining -= length;
        offset += length;
        position += length;
        continue;
      }
      const length = Math.min(chunkHeader.byteLength - chunkHeaderBytes, value.byteLength - offset);
      chunkHeader.set(value.subarray(offset, offset + length), chunkHeaderBytes);
      chunkHeaderBytes += length;
      offset += length;
      position += length;
      if (chunkHeaderBytes === chunkHeader.byteLength) {
        const kind = ascii(chunkHeader, 0, 4);
        const size = new DataView(chunkHeader.buffer).getUint32(4, true);
        chunkRemaining = size + (size % 2);
        if (position + chunkRemaining > object.size) return false;
        if (kind === 'VP8 ' || kind === 'VP8L' || kind === 'VP8X' || kind === 'ANMF')
          imageChunk = true;
        chunkHeaderBytes = 0;
      }
    }
  }
  return (
    position === object.size &&
    headerBytes === header.byteLength &&
    chunkHeaderBytes === 0 &&
    chunkRemaining === 0 &&
    imageChunk
  );
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
): Promise<ArtUploadTicket> {
  const tickets = await createArtUploadTokens(db, ownerId, [
    { cardId, variant, sha256: expectedSha256, maxBytes },
  ]);
  const ticket = tickets.at(0);
  if (!ticket) throw new ApplicationError('invalid_art_upload_request', 400);
  return ticket;
}

export async function createArtUploadTokens(
  db: D1Database,
  ownerId: string,
  requests: ArtUploadRequest[],
): Promise<ArtUploadTicket[]> {
  if (
    requests.length < 1 ||
    requests.length > 100 ||
    requests.some(
      (request) =>
        !request.cardId ||
        !/^[a-f0-9]{64}$/u.test(request.sha256) ||
        request.maxBytes < 1 ||
        request.maxBytes > MAX_ART_BYTES,
    ) ||
    new Set(requests.map((request) => `${request.cardId}\u0000${request.variant}`)).size !==
      requests.length
  )
    throw new ApplicationError('invalid_art_upload_request', 400);
  const requested = JSON.stringify(requests);
  const versions = await db
    .prepare(
      `SELECT CAST(input.key AS INTEGER) AS request_index,
        COALESCE(manifest.version, 0) + 1 AS expected_version
       FROM json_each(?1) input
       JOIN catalogue_cards card ON card.id = json_extract(input.value, '$.cardId')
       LEFT JOIN art_manifest manifest
         ON manifest.card_id = card.id
         AND manifest.variant = json_extract(input.value, '$.variant')
       ORDER BY CAST(input.key AS INTEGER)`,
    )
    .bind(requested)
    .all<{ request_index: number; expected_version: number }>();
  if (versions.results.length !== requests.length)
    throw new ApplicationError('card_not_found', 404);
  const now = nowSeconds();
  const tickets = await Promise.all(
    requests.map(
      async (
        request,
        index,
      ): Promise<ArtUploadTicket & { tokenHash: string; expectedVersion: number }> => {
        const version = versions.results[index];
        if (!version || version.request_index !== index)
          throw new ApplicationError('invalid_art_upload_request', 400);
        const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll('-', '');
        const tokenHash = await hashToken(token);
        return {
          ...request,
          token,
          tokenHash,
          ticketId: ticketId(tokenHash),
          expectedVersion: version.expected_version,
        };
      },
    ),
  );
  await db
    .prepare(
      `INSERT INTO art_upload_tokens
        (token_hash, owner_id, card_id, variant, expected_sha256, expected_version,
         max_bytes, expires_at, created_at)
       SELECT json_extract(value, '$.tokenHash'), ?1, json_extract(value, '$.cardId'),
         json_extract(value, '$.variant'), json_extract(value, '$.sha256'),
         json_extract(value, '$.expectedVersion'), json_extract(value, '$.maxBytes'), ?2, ?3
       FROM json_each(?4)`,
    )
    .bind(ownerId, now + 900, now, JSON.stringify(tickets))
    .run();
  return tickets.map(({ tokenHash: ignoredHash, expectedVersion: ignoredVersion, ...ticket }) => {
    void ignoredHash;
    void ignoredVersion;
    return ticket;
  });
}

export async function uploadArt(
  db: D1Database,
  art: R2Bucket,
  token: string,
  suppliedTicketId: string,
  request: Request,
): Promise<{ cardId: string; variant: ArtVariant; objectKey: string; replayed: boolean }> {
  const tokenHash = await hashToken(token);
  if (ticketId(tokenHash) !== suppliedTicketId && token !== suppliedTicketId)
    throw new ApplicationError('art_upload_token_invalid', 400);
  const upload = await db
    .prepare(
      `SELECT token.owner_id, token.card_id, token.variant, token.expected_sha256,
        token.expected_version, token.max_bytes, token.expires_at, token.consumed_at,
        CASE WHEN manifest.sha256 = token.expected_sha256
          AND manifest.version >= token.expected_version THEN manifest.object_key END
          AS committed_object_key
       FROM art_upload_tokens token
       LEFT JOIN art_manifest manifest
         ON manifest.card_id = token.card_id AND manifest.variant = token.variant
       WHERE token.token_hash = ?1`,
    )
    .bind(tokenHash)
    .first<UploadTokenRow>();
  if (!upload) throw new ApplicationError('art_upload_token_invalid', 400);
  if (upload.committed_object_key)
    return {
      cardId: upload.card_id,
      variant: upload.variant,
      objectKey: upload.committed_object_key,
      replayed: true,
    };
  const claimedAt = nowSeconds();
  if (upload.expires_at <= claimedAt) throw new ApplicationError('art_upload_token_invalid', 400);
  const claim = await db
    .prepare(
      `UPDATE art_upload_tokens SET consumed_at = ?1
       WHERE token_hash = ?2 AND expires_at > ?1
         AND (consumed_at IS NULL OR consumed_at <= ?3)`,
    )
    .bind(claimedAt, tokenHash, claimedAt - 120)
    .run();
  if (claim.meta.changes !== 1) throw new ApplicationError('art_upload_in_progress', 409);

  let committed = false;
  const objectKey = artObjectKey(upload.card_id, upload.variant, upload.expected_sha256);
  try {
    const declaredLength = Number(request.headers.get('content-length'));
    if (
      !request.body ||
      !Number.isInteger(declaredLength) ||
      declaredLength < 1 ||
      declaredLength > upload.max_bytes
    )
      throw new ApplicationError('art_upload_size_invalid', 413);
    const previous = await db
      .prepare('SELECT object_key FROM art_manifest WHERE card_id = ?1 AND variant = ?2')
      .bind(upload.card_id, upload.variant)
      .first<{ object_key: string }>();
    const fixedLength = new FixedLengthStream(declaredLength);
    const writeBody = request.body.pipeTo(fixedLength.writable);
    let object: R2Object;
    try {
      object = await art.put(objectKey, fixedLength.readable, {
        httpMetadata: {
          contentType: 'image/webp',
          cacheControl: 'public, max-age=31536000, immutable',
        },
        customMetadata: {
          cardId: upload.card_id,
          variant: upload.variant,
          sha256: upload.expected_sha256,
          version: String(upload.expected_version),
        },
        sha256: upload.expected_sha256,
      });
      await writeBody;
    } catch (error) {
      await writeBody.catch(() => undefined);
      throw error;
    }
    if (object.size !== declaredLength) throw new ApplicationError('art_upload_size_invalid', 400);
    const stored = await art.get(objectKey);
    if (!stored || !(await isWebpObject(stored)))
      throw new ApplicationError('art_upload_not_webp', 400);
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
        upload.expected_sha256,
        object.size,
        upload.expected_version,
        now,
      )
      .run();
    if (manifest.meta.changes < 1) {
      await recordOrphan(db, objectKey, 'manifest_version_conflict');
      throw new ApplicationError('art_upload_version_conflict', 409);
    }
    committed = true;
    if (previous && previous.object_key !== objectKey)
      await recordOrphan(db, previous.object_key, 'manifest_superseded');
    await cleanupArtOrphans(db, art);
    return { cardId: upload.card_id, variant: upload.variant, objectKey, replayed: false };
  } catch (error) {
    if (!committed) {
      await Promise.all([
        recordOrphan(db, objectKey, 'upload_failed'),
        db
          .prepare(
            'UPDATE art_upload_tokens SET consumed_at = NULL WHERE token_hash = ?1 AND consumed_at = ?2',
          )
          .bind(tokenHash, claimedAt)
          .run(),
      ]);
      await cleanupArtOrphans(db, art, nowSeconds());
    }
    throw error;
  }
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
