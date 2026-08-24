import { execFile, spawn } from 'node:child_process';
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
  run(['d1', 'execute', 'pokedex-local', '--local', '--persist-to', persist, '--command', command]);
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

try {
  await run(['d1', 'migrations', 'apply', 'pokedex-local', '--local', '--persist-to', persist]);
  await d1(
    `INSERT INTO users (id,label,created_at) VALUES ('owner','Owner',1);
     INSERT INTO catalogue_cards (id,name,language,category,set_id,set_name,number,is_custom,is_active,created_at,updated_at)
       VALUES ('custom_fixture','Custom Fixture','en','special','custom','Custom cards','custom',1,1,1,1);
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
  const cookie = login.response.headers.get('set-cookie')?.split(';', 1)[0];
  if (!cookie) throw new Error('development login did not return a session cookie');
  const backup = await json('/api/backups', { method: 'POST', headers: { cookie } });
  const backupId = backup.body.id;
  if (typeof backupId !== 'string') throw new Error('backup response did not contain an id');

  await d1(
    `DELETE FROM collection_mutations WHERE owner_id='owner';
     DELETE FROM collection_cards WHERE owner_id='owner';
     DELETE FROM binders WHERE owner_id='owner';
     DELETE FROM catalogue_cards WHERE id='custom_fixture';`,
  );
  await json(`/api/backups/${encodeURIComponent(backupId)}/restore`, {
    method: 'POST',
    headers: { cookie },
  });

  const verified = await d1(
    `SELECT
       (SELECT COUNT(*) FROM catalogue_cards WHERE id='custom_fixture' AND is_custom=1) AS catalogue,
       (SELECT quantity FROM collection_cards WHERE owner_id='owner' AND card_id='custom_fixture') AS quantity,
       (SELECT COUNT(*) FROM binders WHERE owner_id='owner' AND id='binder_fixture') AS binders,
       (SELECT COUNT(*) FROM binder_slots WHERE binder_page_id='page_fixture' AND card_id='custom_fixture') AS slots,
       (SELECT COUNT(*) FROM collection_mutations WHERE owner_id='owner') AS mutations,
       (SELECT mutation_epoch FROM users WHERE id='owner') AS epoch,
       (SELECT COUNT(*) FROM backup_runs WHERE id='${backupId}' AND owner_id='owner' AND restored_at IS NOT NULL) AS restored;`,
  );
  const match = verified.stdout.match(
    /"catalogue":\s*1,\s*"quantity":\s*2,\s*"binders":\s*1,\s*"slots":\s*1,\s*"mutations":\s*0,\s*"epoch":\s*1,\s*"restored":\s*1/s,
  );
  if (!match) throw new Error(`backup round-trip mismatch: ${verified.stdout}`);
  const revokedSession = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
  if (revokedSession.status !== 401)
    throw new Error(`restore did not revoke the previous session: ${revokedSession.status}`);
  process.stdout.write('real D1/R2 backup round-trip passed\n');
} finally {
  worker?.kill('SIGTERM');
  await rm(persist, { recursive: true, force: true });
}
