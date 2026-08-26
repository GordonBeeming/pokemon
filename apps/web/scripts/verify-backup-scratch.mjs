import { execFile, spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const app = fileURLToPath(new URL('..', import.meta.url));
const persist = await mkdtemp(join(tmpdir(), 'pokedex-backup-roundtrip-'));
const wrangler = join(app, 'node_modules/.bin/wrangler');
const port = await new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string')
      return reject(new Error('ephemeral port unavailable'));
    server.close((error) => (error ? reject(error) : resolve(address.port)));
  });
});
const base = `http://127.0.0.1:${port}`;
const run = (args) => exec(wrangler, args, { cwd: app });
const d1 = (command) =>
  run(['d1', 'execute', 'DB', '--local', '--persist-to', persist, '--command', command]);
let worker;
let workerOutput = '';

async function waitForWorker() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/live`);
      if (response.ok) return;
    } catch {
      // The local listener is expected to reject connections while Wrangler starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`local worker did not become live:\n${workerOutput}`);
}

async function json(path, init = {}) {
  const response = await fetch(`${base}${path}`, init);
  const body = await response.json();
  if (!response.ok)
    throw new Error(
      `${path} failed (${response.status}): ${JSON.stringify(body)}\n${workerOutput}`,
    );
  return { response, body };
}

async function completedWorkflow(workflowId, cookie, allowReauthentication = false) {
  let statusCookie = cookie;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const status = await fetch(`${base}/api/backups/workflows/${encodeURIComponent(workflowId)}`, {
      headers: { cookie: statusCookie },
    });
    const body = await status.json();
    if (status.status === 200) return body;
    if (status.status === 401 && allowReauthentication) {
      const login = await json('/api/auth/dev-login', { method: 'POST' });
      statusCookie = login.response.headers.get('set-cookie')?.split(';', 1)[0];
      if (!statusCookie) throw new Error('workflow polling re-login did not return a cookie');
      continue;
    }
    if (status.status !== 202)
      throw new Error(`backup workflow failed (${status.status}): ${JSON.stringify(body)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`backup workflow did not complete: ${workflowId}`);
}

try {
  await run(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persist]);
  await d1(
    `INSERT INTO users (id,label,created_at) VALUES ('owner','Owner',1);
     INSERT INTO catalogue_cards (id,name,language,category,set_id,set_name,number,is_custom,is_active,created_at,updated_at)
       VALUES ('custom_fixture','Custom Fixture','en','special','custom','Custom cards','custom',1,1,1,1);
     WITH RECURSIVE sequence(value) AS (
       SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 300
     )
     INSERT INTO catalogue_cards (id,name,language,category,set_id,set_name,number,is_custom,is_active,created_at,updated_at)
       SELECT printf('custom_bulk_%03d', value), printf('Custom Bulk %03d', value), 'en',
         'special', 'custom', 'Custom cards', printf('%03d', value), 1, 1, 1, 1 FROM sequence;
     INSERT INTO collection_cards (owner_id,card_id,quantity,notes,revision,updated_at)
       VALUES ('owner','custom_fixture',2,'private fixture',3,2);
     INSERT INTO collection_mutations (owner_id,mutation_id,card_id,response_json,created_at)
       VALUES ('owner','00000000-0000-4000-8000-000000000001','custom_fixture','{}',2);
     INSERT INTO binders (id,owner_id,name,active_version_id,created_at,updated_at)
       VALUES ('binder_fixture','owner','Fixture binder',NULL,1,1);
     INSERT INTO binder_versions (id,binder_id,version_number,status,layout_kind,rows,columns,created_at,activated_at)
       VALUES ('version_fixture','binder_fixture',1,'active','2x2',2,2,1,1);
     UPDATE binders SET active_version_id='version_fixture' WHERE id='binder_fixture';
     INSERT INTO binder_pages (id,binder_version_id,position) VALUES ('page_fixture','version_fixture',0);
     INSERT INTO binder_slots (binder_page_id,row_index,column_index,card_id)
       VALUES ('page_fixture',0,0,'custom_fixture'),('page_fixture',0,1,NULL),('page_fixture',1,0,NULL),('page_fixture',1,1,NULL);`,
  );

  worker = spawn(
    wrangler,
    [
      'dev',
      '--config',
      'wrangler.jsonc',
      '--local',
      '--persist-to',
      persist,
      '--port',
      String(port),
      '--var',
      'SESSION_SECRET:01234567890123456789012345678901',
      '--var',
      'ENROLL_SECRET:local-backup-verifier',
    ],
    {
      cwd: app,
      env: {
        ...process.env,
        SESSION_SECRET: '01234567890123456789012345678901',
        ENROLL_SECRET: 'local-backup-verifier',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  worker.stdout?.on('data', (chunk) => {
    workerOutput += String(chunk);
  });
  worker.stderr?.on('data', (chunk) => {
    workerOutput += String(chunk);
  });
  await waitForWorker();
  const readiness = await fetch(`${base}/api/ready`);
  const readinessBody = await readiness.json();
  if (
    readiness.status !== 503 ||
    readinessBody.ok !== false ||
    readinessBody.freshness?.backup?.state !== 'missing' ||
    readinessBody.freshness?.catalogue?.state !== 'missing' ||
    readinessBody.freshness?.pricing?.state !== 'missing'
  )
    throw new Error(
      `missing schedule data did not degrade readiness: ${JSON.stringify(readinessBody)}`,
    );
  const optionResponses = await Promise.all(
    Array.from({ length: 25 }, () =>
      fetch(`${base}/api/auth/passkey/auth/options`, { method: 'POST' }),
    ),
  );
  const allowedOptions = optionResponses.filter((response) => response.status === 200).length;
  const limitedOptions = optionResponses.filter((response) => response.status === 429).length;
  if (allowedOptions !== 20 || limitedOptions !== 5)
    throw new Error(
      `atomic option rate limit mismatch: ${allowedOptions} allowed, ${limitedOptions} limited`,
    );
  const login = await json('/api/auth/dev-login', { method: 'POST' });
  let cookie = login.response.headers.get('set-cookie')?.split(';', 1)[0];
  if (!cookie) throw new Error('development login did not return a session cookie');
  const sessionStillValid = async (after) => {
    const response = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
    if (response.status !== 200)
      throw new Error(`ordinary ${after} mutation revoked the current session: ${response.status}`);
  };
  const backupEpoch = async () => {
    const result = await d1("SELECT backup_epoch FROM users WHERE id='owner';");
    const match = result.stdout.match(/"backup_epoch":\s*(\d+)/u);
    if (!match) throw new Error(`backup epoch was not queryable: ${result.stdout}`);
    return Number(match[1]);
  };
  const epochBeforeMutations = await backupEpoch();
  await json('/api/collection/custom_fixture', {
    method: 'PUT',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      mutationId: '00000000-0000-4000-8000-000000000002',
      expectedRevision: 3,
      quantity: 3,
      notes: 'private fixture updated',
    }),
  });
  await sessionStillValid('collection');
  await json('/api/binders/versions/version_fixture/clone', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 1 }),
  });
  await sessionStillValid('binder');
  const pair = await json('/api/desktop/pair', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ scopes: ['art:read', 'art:write'] }),
  });
  const redeemed = await json('/api/desktop/pair/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: pair.body.code, label: 'Backup verifier' }),
  });
  const webp = Buffer.alloc(20);
  webp.write('RIFF', 0, 'ascii');
  webp.writeUInt32LE(12, 4);
  webp.write('WEBPVP8 ', 8, 'ascii');
  webp.writeUInt32LE(0, 16);
  const checksum = createHash('sha256').update(webp).digest('hex');
  const ticket = await json('/api/desktop/art/upload-tokens', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${redeemed.body.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      cardId: 'custom_fixture',
      variant: 'high',
      sha256: checksum,
      maxBytes: webp.byteLength,
    }),
  });
  await json(ticket.body.uploadPath, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${ticket.body.token}`,
      'content-type': 'image/webp',
      'content-length': String(webp.byteLength),
    },
    body: webp,
  });
  await sessionStillValid('custom art');
  const epochAfterMutations = await backupEpoch();
  if (epochAfterMutations <= epochBeforeMutations)
    throw new Error(
      `ordinary mutations did not advance backup consistency: ${epochBeforeMutations} -> ${epochAfterMutations}`,
    );
  const firstCataloguePage = await json('/api/catalogue/search?limit=100&offset=0', {
    headers: { cookie },
  });
  if (
    firstCataloguePage.body.cards.length !== 100 ||
    typeof firstCataloguePage.body.cursor !== 'string'
  )
    throw new Error('catalogue search did not return the first keyset page');
  const secondCataloguePage = await json(
    `/api/catalogue/search?limit=100&cursor=${encodeURIComponent(firstCataloguePage.body.cursor)}`,
    { headers: { cookie } },
  );
  const firstIds = new Set(firstCataloguePage.body.cards.map((card) => card.id));
  if (
    secondCataloguePage.body.cards.length !== 100 ||
    secondCataloguePage.body.cards.some((card) => firstIds.has(card.id))
  )
    throw new Error('catalogue keyset page repeated or omitted the expected page size');
  await d1(
    `WITH RECURSIVE sequence(value) AS (
       SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 12000
     )
     INSERT INTO art_upload_tokens
       (token_hash,owner_id,card_id,variant,expected_sha256,expected_version,max_bytes,expires_at,consumed_at,created_at)
     SELECT printf('expired_%05d', value), 'owner', 'custom_fixture', 'low',
       '${'b'.repeat(64)}', 1, 20, 1, 1, 1 FROM sequence;`,
  );
  const backupResponses = await Promise.all(
    Array.from({ length: 5 }, () =>
      fetch(`${base}/api/backups`, { method: 'POST', headers: { cookie } }),
    ),
  );
  const createdBackups = backupResponses.filter((response) => response.status === 202);
  const limitedBackups = backupResponses.filter((response) => response.status === 429);
  if (createdBackups.length !== 1 || limitedBackups.length !== 4)
    throw new Error(
      `atomic backup rate limit mismatch: ${createdBackups.length} created, ${limitedBackups.length} limited`,
    );
  if (limitedBackups.some((response) => !response.headers.has('retry-after')))
    throw new Error('rate-limited backup response omitted Retry-After');
  const backup = await createdBackups[0].json();
  if (typeof backup.workflowId !== 'string')
    throw new Error('backup response did not contain a workflow id');
  const backupId = (await completedWorkflow(backup.workflowId, cookie)).id;
  if (typeof backupId !== 'string') throw new Error('backup response did not contain an id');
  const retained = await d1(
    'SELECT COUNT(*) AS count FROM art_upload_tokens WHERE expires_at <= 1;',
  );
  if (!/"count":\s*0/s.test(retained.stdout))
    throw new Error(`retention workflow left an expired backlog: ${retained.stdout}`);

  await d1(
    `DELETE FROM collection_mutations WHERE owner_id='owner';
     DELETE FROM collection_cards WHERE owner_id='owner';
     DELETE FROM binders WHERE owner_id='owner';
     DELETE FROM art_upload_tokens WHERE card_id='custom_fixture';
     DELETE FROM art_manifest WHERE card_id='custom_fixture';
     DELETE FROM catalogue_cards WHERE is_custom=1;`,
  );
  const restoreLogin = await json('/api/auth/dev-login', { method: 'POST' });
  cookie = restoreLogin.response.headers.get('set-cookie')?.split(';', 1)[0];
  if (!cookie) throw new Error('restore login did not return a session cookie');
  const restore = await json(`/api/backups/${encodeURIComponent(backupId)}/restore`, {
    method: 'POST',
    headers: { cookie },
  });
  if (typeof restore.body.workflowId !== 'string')
    throw new Error('restore response did not contain a workflow id');
  const restoreResult = await completedWorkflow(restore.body.workflowId, cookie, true);
  if (restoreResult.restored !== true || restoreResult.backupId !== backupId)
    throw new Error(
      `restore workflow returned an invalid result: ${JSON.stringify(restoreResult)}`,
    );

  const verified = await d1(
    `SELECT
       (SELECT COUNT(*) FROM catalogue_cards WHERE id='custom_fixture' AND is_custom=1) AS catalogue,
       (SELECT COUNT(*) FROM catalogue_cards WHERE id LIKE 'custom_bulk_%' AND is_custom=1) AS bulk_catalogue,
       (SELECT quantity FROM collection_cards WHERE owner_id='owner' AND card_id='custom_fixture') AS quantity,
       (SELECT COUNT(*) FROM binders WHERE owner_id='owner' AND id='binder_fixture') AS binders,
       (SELECT COUNT(*) FROM binder_slots WHERE binder_page_id='page_fixture' AND card_id='custom_fixture') AS slots,
       (SELECT COUNT(*) FROM collection_mutations WHERE owner_id='owner') AS mutations,
       (SELECT mutation_epoch FROM users WHERE id='owner') AS epoch,
       (SELECT COUNT(*) FROM backup_runs WHERE id='${backupId}' AND owner_id='owner' AND restored_at IS NOT NULL) AS restored;`,
  );
  const match = verified.stdout.match(
    /"catalogue":\s*1,\s*"bulk_catalogue":\s*300,\s*"quantity":\s*3,\s*"binders":\s*1,\s*"slots":\s*1,\s*"mutations":\s*0,\s*"epoch":\s*(\d+),\s*"restored":\s*1/s,
  );
  if (!match) throw new Error(`backup round-trip mismatch: ${verified.stdout}`);
  if (Number(match[1]) < 1) throw new Error(`restore did not advance mutation epoch: ${match[1]}`);
  const revokedSession = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
  if (revokedSession.status !== 401)
    throw new Error(`restore did not revoke the previous session: ${revokedSession.status}`);
  const artLogin = await json('/api/auth/dev-login', { method: 'POST' });
  const artCookie = artLogin.response.headers.get('set-cookie')?.split(';', 1)[0];
  if (!artCookie) throw new Error('art verification login did not return a session cookie');
  const restoredArt = await fetch(`${base}/api/art/custom_fixture/high`, {
    headers: { cookie: artCookie },
  });
  const restoredBytes = Buffer.from(await restoredArt.arrayBuffer());
  if (!restoredArt.ok || !restoredBytes.equals(webp))
    throw new Error(`custom art did not survive backup restore: ${restoredArt.status}`);
  process.stdout.write('real D1/R2 backup round-trip passed\n');
} finally {
  worker?.kill('SIGTERM');
  await rm(persist, { recursive: true, force: true });
}
