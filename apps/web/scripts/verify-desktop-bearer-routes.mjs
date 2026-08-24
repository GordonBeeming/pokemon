import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const app = fileURLToPath(new URL('..', import.meta.url));
const wrangler = join(app, 'node_modules/.bin/wrangler');
const persist = await mkdtemp(join(tmpdir(), 'pokedex-desktop-routes-'));
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
const token = (value) => `${value}`.padEnd(64, value).slice(0, 64);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const ownerAToken = token('a');
const ownerBToken = token('b');
const wrongScopeToken = token('c');
const revokedToken = token('d');
const run = (args) => exec(wrangler, args, { cwd: app });
const request = async (path, authorization) => {
  const response = await fetch(`${base}${path}`, {
    headers: authorization ? { authorization } : {},
  });
  return { status: response.status, body: await response.json() };
};
let worker;
let workerOutput = '';

try {
  await run(['d1', 'migrations', 'apply', 'pokedex-local', '--local', '--persist-to', persist]);
  const sql = [
    "INSERT INTO users (id,label,created_at) VALUES ('owner-a','A',1),('owner-b','B',1);",
    "INSERT INTO catalogue_cards (id,name,language,category,set_id,set_name,number,is_custom,is_active,created_at,updated_at) VALUES ('card-a','Fixture','en','pokemon','set','Set','1',0,1,1,1);",
    `INSERT INTO card_sources (provider,source_id,card_id,language,source_updated_at,checksum,active,imported_at) VALUES ('tcgdex','source-a','card-a','en',123,'${'a'.repeat(64)}',1,1);`,
    "INSERT INTO collection_cards (owner_id,card_id,quantity,notes,revision,updated_at) VALUES ('owner-a','card-a',2,'private',1,1);",
    "INSERT INTO binders (id,owner_id,name,created_at,updated_at) VALUES ('binder-a','owner-a','A binder',1,1);",
    `INSERT INTO desktop_tokens (token_hash,owner_id,label,scopes,created_at,revoked_at) VALUES ('${hash(ownerAToken)}','owner-a','A','["catalogue:read","collection:write","binders:write"]',1,NULL),('${hash(ownerBToken)}','owner-b','B','["catalogue:read","binders:write"]',1,NULL),('${hash(wrongScopeToken)}','owner-a','wrong','["art:read"]',1,NULL),('${hash(revokedToken)}','owner-a','revoked','["catalogue:read"]',1,1);`,
  ].join(' ');
  await run([
    'd1',
    'execute',
    'pokedex-local',
    '--local',
    '--persist-to',
    persist,
    '--command',
    sql,
  ]);
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
    ],
    {
      cwd: app,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  worker.stdout?.on('data', (chunk) => {
    workerOutput += String(chunk);
  });
  worker.stderr?.on('data', (chunk) => {
    workerOutput += String(chunk);
  });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      if ((await fetch(`${base}/api/live`)).status === 200) break;
    } catch (error) {
      if (attempt === 39) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (attempt === 39) throw new Error('local worker did not start');
  }
  const valid = await request('/api/desktop/catalogue/search', `Bearer ${ownerAToken}`);
  const sources = await request(
    '/api/desktop/catalogue/sources?limit=500',
    `Bearer ${ownerAToken}`,
  );
  const invalidCursor = await request(
    '/api/desktop/catalogue/sources?cursor=bad',
    `Bearer ${ownerAToken}`,
  );
  const wrong = await request('/api/desktop/catalogue/search', `Bearer ${wrongScopeToken}`);
  const revoked = await request('/api/desktop/catalogue/search', `Bearer ${revokedToken}`);
  const raw = await request('/api/desktop/catalogue/search', ownerAToken);
  const ownerA = await request('/api/desktop/binders', `Bearer ${ownerAToken}`);
  const ownerB = await request('/api/desktop/binders', `Bearer ${ownerBToken}`);
  if (valid.status !== 200 || valid.body.cards.length !== 1)
    throw new Error(`valid scoped token failed: ${JSON.stringify(valid)}`);
  if (
    sources.status !== 200 ||
    sources.body.entries.length !== 1 ||
    JSON.stringify(sources.body.entries[0]) !==
      JSON.stringify({
        cardId: 'card-a',
        provider: 'tcgdex',
        sourceId: 'source-a',
        language: 'en',
        sourceUpdatedAt: 123,
        sourceChecksum: 'a'.repeat(64),
      }) ||
    sources.body.cursor !== null ||
    invalidCursor.status !== 400
  )
    throw new Error(
      `catalogue source contract failed: ${JSON.stringify({ sources, invalidCursor })}\n${workerOutput}`,
    );
  if (wrong.status !== 403 || revoked.status !== 401 || raw.status !== 401)
    throw new Error(
      `desktop token rejection failed: ${JSON.stringify({ wrong, revoked, raw })}\n${workerOutput}`,
    );
  if (ownerA.body.binders.length !== 1 || ownerB.body.binders.length !== 0)
    throw new Error('owner isolation failed');
  process.stdout.write('desktop bearer route verification passed\n');
} finally {
  worker?.kill('SIGTERM');
  await rm(persist, { recursive: true, force: true });
}
