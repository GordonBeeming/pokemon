import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const [command, repoArg, runArg, limitArg] = process.argv.slice(2);
if (!['provision', 'warm', 'verify', 'revoke'].includes(command) || !repoArg || !runArg) {
  throw new Error(
    'Usage: node artwork-refresh.mjs provision|warm|verify|revoke REPO RUN_DIR [LIMIT]',
  );
}
const repo = resolve(repoArg);
const config = readFileSync(join(repo, 'apps/web/wrangler.jsonc'), 'utf8');
if (
  config.match(/"name"\s*:\s*"([^"]+)"/u)?.[1] !== 'pokedex-web' ||
  config.match(/"database_id"\s*:\s*"([^"]+)"/u)?.[1] !== '5e955d9c-188b-476a-80e9-8b1908f20f54'
)
  throw new Error('Repository configuration does not match the production Pokédex resources');
const runDir = resolve(runArg);
mkdirSync(runDir, { recursive: true });
const metaPath = join(runDir, 'access.json');
const logPath = join(runDir, 'artwork.jsonl');
const progressPath = join(runDir, 'progress.json');
const origin = 'https://pokedex.gordonbeeming.com';
const sqlString = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const sha = (value) => createHash('sha256').update(value).digest('hex');
function execute(program, args, input) {
  return execFileSync(program, args, {
    cwd: repo,
    input,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}
function database(sql) {
  const raw = execute('pnpm', [
    '--dir',
    'apps/web',
    'exec',
    'wrangler',
    'd1',
    'execute',
    'DB',
    '--remote',
    '--config',
    'wrangler.jsonc',
    '--env-file',
    '/dev/null',
    '--json',
    '--command',
    sql,
  ]);
  const result = JSON.parse(raw);
  if (!Array.isArray(result) || result.some((item) => !item.success))
    throw Object.assign(new Error('D1 query failed'), { stdout: raw });
  return result.flatMap((item) => item.results ?? []);
}
async function readDatabase(sql) {
  let lastReset;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return database(sql);
    } catch (error) {
      const reset =
        error && typeof error.stdout === 'string' && /"code"\s*:\s*7429\b/u.test(error.stdout);
      if (!reset) throw error;
      lastReset = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  throw new Error('D1 inventory read failed after three CPU-reset attempts', {
    cause: lastReset,
  });
}
// The site is multi-user, so the refresh acts as a real admin rather than a fixed id.
// POKEDEX_ADMIN_ID picks one when several admins are active.
function resolveAdmin() {
  const admins = database(
    "SELECT id,label FROM users WHERE role='admin' AND disabled_at IS NULL ORDER BY id;",
  );
  const requested = process.env.POKEDEX_ADMIN_ID;
  if (requested) {
    const match = admins.find((admin) => admin.id === requested);
    if (!match) throw new Error(`POKEDEX_ADMIN_ID ${requested} is not an active admin`);
    return match.id;
  }
  if (admins.length === 1) return admins[0].id;
  if (!admins.length) throw new Error('No active admin found in users');
  throw new Error(
    `Several active admins (${admins.map((admin) => `${admin.id} ${admin.label}`).join(', ')}); set POKEDEX_ADMIN_ID`,
  );
}
let activeStats = null;
function readMeta() {
  return JSON.parse(readFileSync(metaPath, 'utf8'));
}
function log(entry) {
  appendFileSync(logPath, JSON.stringify(entry) + '\n');
}
function progress(value) {
  writeFileSync(
    progressPath,
    JSON.stringify({ ...value, updatedAt: new Date().toISOString() }, null, 2),
  );
}
function headers() {
  const token = process.env.POKEDEX_ART_TOKEN;
  if (!token || !/^[a-f0-9]{64}$/u.test(token))
    throw new Error('POKEDEX_ART_TOKEN must be injected through op run');
  if (sha(token) !== readMeta().tokenHash) throw new Error('Token does not belong to this refresh');
  return { authorization: `Bearer ${token}` };
}
async function request(path) {
  return fetch(origin + path, {
    headers: headers(),
    signal: AbortSignal.timeout(60000),
  });
}
try {
  if (command === 'provision') {
    if (existsSync(metaPath))
      throw new Error('Access metadata already exists; reuse it or choose a new run directory');
    execute('op', ['whoami']);
    const adminId = resolveAdmin();
    const createdAt = Math.floor(Date.now() / 1000);
    const expiresAt = createdAt + 24 * 60 * 60;
    const title = `Pokédex artwork refresh ${new Date().toISOString()}`;
    const item = JSON.parse(
      execute('op', [
        'item',
        'create',
        '--category',
        'Password',
        '--generate-password=64,digits',
        '--title',
        title,
        '--vault',
        'ai-secrets',
        '--format',
        'json',
        `notesPlain=Temporary art:read access for ${origin}; expires ${new Date(expiresAt * 1000).toISOString()}. Revoke after verification.`,
      ]),
    );
    const tokenRef = `op://ai-secrets/${item.id}/password`;
    const token = execute('op', ['read', tokenRef]).trim();
    if (!/^[0-9]{64}$/u.test(token))
      throw new Error('Generated artwork credential did not match the expected format');
    const tokenHash = sha(token);
    const meta = {
      itemId: item.id,
      tokenRef,
      tokenHash,
      ownerId: adminId,
      createdAt,
      expiresAt,
      origin,
    };
    // Register the token before recording the run, so a failed insert leaves no
    // access.json pointing at a credential the site doesn't know; archive the unused item.
    try {
      database(`INSERT INTO desktop_tokens (token_hash,owner_id,label,scopes,created_at,expires_at)
    VALUES (${sqlString(tokenHash)},${sqlString(adminId)},${sqlString(title)},'["art:read"]',${createdAt},${expiresAt});
    INSERT INTO audit (actor,action,target,meta,created_at) VALUES (${sqlString(adminId)},'catalogue.art_refresh_started',${sqlString(tokenHash)},'{"scope":"art:read"}',${createdAt});`);
    } catch (error) {
      execute('op', ['item', 'delete', item.id, '--vault', 'ai-secrets', '--archive']);
      throw error;
    }
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    console.log(
      JSON.stringify({
        tokenRef: meta.tokenRef,
        expiresAt: new Date(expiresAt * 1000).toISOString(),
      }),
    );
  } else if (command === 'revoke') {
    const meta = readMeta();
    // Run directories provisioned before the multi-user change have no ownerId; those
    // tokens were all issued to the original 'owner' admin.
    const ownerId = meta.ownerId ?? 'owner';
    database(
      `UPDATE desktop_tokens SET revoked_at=${Math.floor(Date.now() / 1000)} WHERE token_hash=${sqlString(meta.tokenHash)} AND owner_id=${sqlString(ownerId)};`,
    );
    execute('op', ['item', 'delete', meta.itemId, '--vault', 'ai-secrets', '--archive']);
    writeFileSync(
      metaPath,
      JSON.stringify({ ...meta, revokedAt: new Date().toISOString() }, null, 2),
    );
    console.log('Temporary artwork access revoked and archived.');
  } else if (command === 'warm') {
    headers();
    const limit = limitArg === undefined ? Infinity : Number(limitArg);
    const concurrency = Number(process.env.POKEDEX_ART_CONCURRENCY ?? '8');
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 24)
      throw new Error('Artwork concurrency must be between 1 and 24');
    if (!(limit > 0) || (limit !== Infinity && !Number.isInteger(limit)))
      throw new Error('Invalid limit');
    const completed = new Set();
    if (existsSync(logPath))
      for (const line of readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean)) {
        const entry = JSON.parse(line);
        // The latest entry for a variant wins, so a failed retry after an earlier
        // success is attempted again.
        const key = `${entry.id}|${entry.variant}`;
        if (entry.ok) completed.add(key);
        else completed.delete(key);
      }
    const previousVerification = join(runDir, 'verification.json');
    if (existsSync(previousVerification)) {
      const result = JSON.parse(readFileSync(previousVerification, 'utf8'));
      for (const key of result.mismatches ?? []) completed.delete(key);
    }
    const stats = {
      phase: 'warming',
      startedAt: new Date().toISOString(),
      scanned: 0,
      skipped: 0,
      succeeded: 0,
      failed: 0,
      bytes: 0,
    };
    activeStats = stats;
    progress(stats);
    let lastId = '',
      processed = 0;
    let fatal = false;
    async function warm(card) {
      if (fatal) return;
      const key = `${card.id}|${card.variant}`;
      if (completed.has(key)) {
        stats.skipped++;
        return;
      }
      let lastError = '';
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await request(
            `/api/desktop/art/${encodeURIComponent(card.id)}/${card.variant}`,
          );
          if (response.status === 401 || response.status === 403) {
            await response.body?.cancel();
            fatal = true;
            throw new Error(`Artwork authorization failed (${response.status})`);
          }
          if (!response.ok) {
            await response.body?.cancel();
            lastError = `HTTP ${response.status}`;
            if (response.status === 404) break;
            throw new Error(lastError);
          }
          if (!response.body) throw new Error('Empty artwork response');
          const chunks = [];
          let length = 0;
          for await (const chunk of response.body) {
            length += chunk.byteLength;
            if (length > 15 * 1024 * 1024) throw new Error('Artwork exceeded size limit');
            chunks.push(chunk);
          }
          const bytes = Buffer.concat(chunks);
          // The art route serves TCGdex WebP, or a TCGplayer JPEG when TCGdex has none.
          const webp =
            bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
          const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
          if (!webp && !jpeg) throw new Error('Artwork is not WebP or JPEG');
          log({
            ...card,
            ok: true,
            sha256: sha(bytes),
            bytes: length,
            checkedAt: new Date().toISOString(),
          });
          completed.add(key);
          stats.succeeded++;
          stats.bytes += length;
          return;
        } catch (error) {
          lastError = error instanceof Error ? error.message : 'Artwork request failed';
          if (fatal) throw new Error(lastError);
          if (attempt < 2)
            await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
        }
      }
      stats.failed++;
      log({
        ...card,
        ok: false,
        error: lastError,
        checkedAt: new Date().toISOString(),
      });
    }
    while (!fatal && processed < limit) {
      const inventory = await readDatabase(`SELECT c.id,c.language,c.is_active,
      EXISTS (SELECT 1 FROM card_sources s WHERE s.card_id=c.id AND s.provider='tcgdex' AND s.active=1) AS is_source
      FROM catalogue_cards c WHERE c.id>${sqlString(lastId)} ORDER BY c.id
      LIMIT ${Math.min(125, Math.ceil((limit - processed) / 2))};`);
      if (!inventory.length) break;
      const page = inventory
        .filter((card) => card.language === 'en' && card.is_active === 1 && card.is_source === 1)
        .flatMap((card) => ['high', 'low'].map((variant) => ({ id: card.id, variant })))
        .slice(0, limit - processed);
      let nextIndex = 0;
      const results = await Promise.allSettled(
        Array.from({ length: concurrency }, async () => {
          while (!fatal && nextIndex < page.length) {
            const card = page[nextIndex++];
            await warm(card);
            stats.scanned++;
            processed++;
            if (stats.scanned % 8 === 0) progress(stats);
          }
        }),
      );
      progress(stats);
      const rejection = results.find((result) => result.status === 'rejected');
      if (rejection) throw rejection.reason;
      lastId = inventory.at(-1).id;
      console.log(JSON.stringify(stats));
    }
    progress({
      ...stats,
      phase: stats.failed ? 'partial' : 'warmed',
      finishedAt: new Date().toISOString(),
      limited: limit !== Infinity,
    });
    console.log(JSON.stringify(stats));
  } else if (command === 'verify') {
    headers();
    const records = new Map();
    for (const line of readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean)) {
      const entry = JSON.parse(line);
      records.set(`${entry.id}|${entry.variant}`, entry);
    }
    const manifest = new Map();
    let cursor = null;
    do {
      const response = await request(
        '/api/desktop/art/manifest?limit=5000' +
          (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
      );
      if (!response.ok) throw new Error(`Manifest HTTP ${response.status}`);
      const data = await response.json();
      for (const entry of data.entries) manifest.set(`${entry.cardId}|${entry.variant}`, entry);
      if (data.cursor && data.cursor === cursor) throw new Error('Manifest cursor did not advance');
      cursor = data.cursor;
    } while (cursor);
    const expected = new Set();
    let afterId = '';
    while (true) {
      const cards = await readDatabase(`SELECT c.id,c.language,c.is_active,
      EXISTS (SELECT 1 FROM card_sources s WHERE s.card_id=c.id AND s.provider='tcgdex' AND s.active=1) AS is_source
      FROM catalogue_cards c WHERE c.id>${sqlString(afterId)} ORDER BY c.id LIMIT 1000;`);
      if (!cards.length) break;
      for (const card of cards) {
        if (card.language === 'en' && card.is_active === 1 && card.is_source === 1)
          for (const variant of ['high', 'low']) expected.add(`${card.id}|${variant}`);
      }
      afterId = cards.at(-1).id;
    }
    if (!expected.size)
      throw new Error('No active source cards found; refusing empty verification');
    const mismatches = [],
      failed = [],
      unverified = [];
    let verified = 0;
    for (const key of expected) {
      const entry = records.get(key);
      if (!entry) {
        unverified.push(key);
        continue;
      }
      if (!entry.ok) {
        failed.push(entry);
        continue;
      }
      const stored = manifest.get(key);
      if (!stored || stored.sha256 !== entry.sha256 || stored.bytes !== entry.bytes)
        mismatches.push(key);
      else verified++;
    }
    const report = {
      expected: expected.size,
      verified,
      failed,
      unverified,
      mismatches,
      checkedAt: new Date().toISOString(),
    };
    writeFileSync(join(runDir, 'verification.json'), JSON.stringify(report, null, 2));
    console.log(
      JSON.stringify({
        expected: expected.size,
        verified,
        failed: failed.length,
        unverified: unverified.length,
        mismatches,
      }),
    );
    if (mismatches.length || failed.length || unverified.length) process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : 'Artwork refresh failed';
  progress({
    ...(activeStats ?? {}),
    phase: 'failed',
    command,
    error: message,
    failedAt: new Date().toISOString(),
  });
  console.error(message);
  process.exitCode = 1;
}
