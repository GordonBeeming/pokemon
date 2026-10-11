const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  cp = require('node:child_process'),
  assert = require('node:assert/strict');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokedex-art-test-'));
const bin = path.join(dir, 'bin');
fs.mkdirSync(bin);
const mockRepo = path.join(dir, 'repo');
fs.mkdirSync(path.join(mockRepo, 'apps/web'), { recursive: true });
fs.writeFileSync(
  path.join(mockRepo, 'apps/web/wrangler.jsonc'),
  JSON.stringify({
    name: 'pokedex-web',
    database_id: '5e955d9c-188b-476a-80e9-8b1908f20f54',
  }),
);
const mock = String.raw`#!/usr/bin/env node
const fs=require('node:fs');const a=process.argv.slice(2), cmd=require('node:path').basename(process.argv[1]);
if(cmd==='op') {
 if(a[0]==='whoami') console.log('test service account');
 else if(a[0]==='read') console.log(JSON.parse(fs.readFileSync(process.env.MOCK_DIR+'/test-item.json')).fields.find(f=>f.id==='credential'||f.id==='password').value);
 else if(a[1]==='template') console.log(JSON.stringify({category:'API_CREDENTIAL',fields:[{id:'credential'},{id:'notesPlain'},{id:'hostname'}]}));
 else if(a[1]==='create') {let data={fields:[{id:'password',value:'7'.repeat(64)}]};fs.writeFileSync(process.env.MOCK_DIR+'/test-item.json',JSON.stringify(data));console.log(JSON.stringify({id:'test-item'}));}
 else if(a[1]==='delete') {fs.appendFileSync(process.env.MOCK_DIR+'/op-deletes',a[2]+'\n');console.log('archived');} else process.exit(3);
} else {
 const sql=a[a.indexOf('--command')+1];let rows=[];
 if(process.env.MOCK_DB_FAIL && sql.startsWith('INSERT')) process.exit(1);
 if(/^(INSERT|UPDATE)/.test(sql)) fs.appendFileSync(process.env.MOCK_DIR+'/writes.jsonl',JSON.stringify(sql)+'\n');
 if(sql.startsWith('SELECT id,label FROM users')) {console.log(JSON.stringify([{success:true,results:JSON.parse(process.env.MOCK_ADMINS||'[{"id":"admin-1","label":"Ash"}]')}]));process.exit(0);}
 if(sql.startsWith('SELECT c.id,c.language,c.is_active')) {
  const marker=process.env.MOCK_DIR+'/retry-marker';
  if(process.env.MOCK_RETRY_ZERO && !fs.existsSync(marker+'-zero')) {fs.writeFileSync(marker+'-zero','1');console.log(JSON.stringify([{success:false,error:{code:7429}}]));process.exit(0);}
  if(process.env.MOCK_RETRY && !fs.existsSync(marker)) {fs.writeFileSync(marker,'1');console.log(JSON.stringify({error:{code:7429}}));process.exit(1);}
  fs.appendFileSync(process.env.MOCK_DIR+'/queries.jsonl',JSON.stringify(sql)+'\n');
  const after=sql.match(/c\.id>'([^']*)'/)?.[1]??'';
  rows=[{id:'card-0',language:'en',is_active:0,is_source:1},{id:'card-1',language:'fr',is_active:1,is_source:1},{id:'card-a',language:'en',is_active:1,is_source:1},{id:'card-b',language:'en',is_active:1,is_source:1},{id:'card-c',language:'en',is_active:1,is_source:0}]
    .filter(row=>row.id>after).slice(0,Number(sql.match(/LIMIT (\d+)/)[1]));
 }
 if(process.env.MOCK_EMPTY) rows=[];
 console.log(JSON.stringify([{success:true,results:rows}]));
}`;
for (const name of ['op', 'pnpm']) {
  fs.writeFileSync(path.join(bin, name), mock, { mode: 0o755 });
}
const preload = path.join(dir, 'fetch.mjs');
fs.writeFileSync(
  preload,
  `import{createHash}from'node:crypto';const bytes=process.env.MOCK_JPEG?Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0]),Buffer.from('jpegfixture')]):Buffer.from('RIFF0000WEBPfixture'+(process.env.MOCK_CHANGE?'changed':''));globalThis.fetch=async(url)=>{if(process.env.MOCK_AUTH_FAIL)return new Response('',{status:401});if(String(url).includes('/manifest'))return Response.json({entries:['card-a','card-b'].flatMap(cardId=>['high','low'].map(variant=>({cardId,variant,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length}))),cursor:null});return new Response(bytes,{headers:{'content-type':'image/webp'}})};`,
);
let env = { ...process.env, PATH: bin + ':' + process.env.PATH, MOCK_DIR: dir };
const runDir = path.join(dir, 'run');
function run(command, limit, runPath = runDir, overrides = {}) {
  return cp.spawnSync(
    process.execPath,
    [
      '--import',
      preload,
      path.join(__dirname, 'artwork-refresh.mjs'),
      command,
      mockRepo,
      runPath,
      ...(limit ? [String(limit)] : []),
    ],
    { encoding: 'utf8', env: { ...env, ...overrides } },
  );
}
let r = run('provision');
assert.equal(r.status, 0, r.stderr);
const token = JSON.parse(fs.readFileSync(path.join(dir, 'test-item.json'))).fields.find(
  (f) => f.id === 'credential' || f.id === 'password',
).value;
assert(!r.stdout.includes(token));
env.POKEDEX_ART_TOKEN = token;
r = run('warm', 2, runDir, { MOCK_RETRY: '1' });
assert.equal(r.status, 0, r.stderr);
r = run('verify');
assert.equal(r.status, 1);
assert.equal(
  JSON.parse(fs.readFileSync(path.join(runDir, 'verification.json'))).unverified.length,
  2,
);
r = run('warm', undefined, runDir, { MOCK_RETRY_ZERO: '1' });
assert.equal(r.status, 0, r.stderr);
r = run('verify');
assert.equal(r.status, 0, r.stderr);
assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'verification.json'))).verified, 4);
r = run('verify', undefined, runDir, { MOCK_EMPTY: '1' });
assert.equal(r.status, 1);
r = run('verify', undefined, runDir, { MOCK_CHANGE: '1' });
assert.equal(r.status, 1);
r = run('warm', undefined, runDir, { MOCK_CHANGE: '1' });
assert.equal(r.status, 0, r.stderr);
r = run('verify', undefined, runDir, { MOCK_CHANGE: '1' });
assert.equal(r.status, 0, r.stderr);
const failedDir = path.join(dir, 'failed');
fs.mkdirSync(failedDir);
fs.copyFileSync(path.join(runDir, 'access.json'), path.join(failedDir, 'access.json'));
r = run('warm', 2, failedDir, { MOCK_AUTH_FAIL: '1' });
assert.equal(r.status, 1);
assert(!r.stderr.includes(token));
assert.equal(JSON.parse(fs.readFileSync(path.join(failedDir, 'progress.json'))).phase, 'failed');
r = run('revoke');
assert.equal(r.status, 0, r.stderr);
assert(JSON.parse(fs.readFileSync(path.join(runDir, 'access.json'))).revokedAt);

// A TCGplayer JPEG served by the art route counts as cached artwork.
const jpegDir = path.join(dir, 'jpeg');
fs.mkdirSync(jpegDir);
fs.copyFileSync(path.join(runDir, 'access.json'), path.join(jpegDir, 'access.json'));
r = run('warm', undefined, jpegDir, { MOCK_JPEG: '1' });
assert.equal(r.status, 0, r.stderr);
r = run('verify', undefined, jpegDir, { MOCK_JPEG: '1' });
assert.equal(r.status, 0, r.stderr);

// A failed retry after an earlier success is attempted again on the next warm.
const resumeDir = path.join(dir, 'resume');
fs.mkdirSync(resumeDir);
fs.copyFileSync(path.join(runDir, 'access.json'), path.join(resumeDir, 'access.json'));
const resumeLog = path.join(resumeDir, 'artwork.jsonl');
fs.writeFileSync(
  resumeLog,
  [
    { id: 'card-a', variant: 'high', ok: true, sha256: 'old', bytes: 1 },
    { id: 'card-a', variant: 'high', ok: false, error: 'HTTP 500' },
  ]
    .map((entry) => JSON.stringify(entry))
    .join('\n') + '\n',
);
r = run('warm', undefined, resumeDir);
assert.equal(r.status, 0, r.stderr);
const retried = fs
  .readFileSync(resumeLog, 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
  .filter((entry) => entry.id === 'card-a' && entry.variant === 'high');
assert.equal(retried.length, 3);
assert.equal(retried.at(-1).ok, true);

// A failed D1 registration leaves no access.json and archives the unused credential.
const provisionDir = path.join(dir, 'provision-fail');
r = run('provision', undefined, provisionDir, { MOCK_DB_FAIL: '1' });
assert.equal(r.status, 1);
assert(!fs.existsSync(path.join(provisionDir, 'access.json')));
assert(fs.readFileSync(path.join(dir, 'op-deletes'), 'utf8').includes('test-item'));

// The token and audit rows belong to the active admin, and revoke targets that admin.
const writes = fs.readFileSync(path.join(dir, 'writes.jsonl'), 'utf8');
assert(writes.includes("'admin-1'"));
assert(!writes.includes("'owner'"));
assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'access.json'))).ownerId, 'admin-1');

// Several active admins need POKEDEX_ADMIN_ID to pick one.
const twoAdmins = JSON.stringify([
  { id: 'admin-1', label: 'Ash' },
  { id: 'admin-2', label: 'Misty' },
]);
r = run('provision', undefined, path.join(dir, 'two-admins'), { MOCK_ADMINS: twoAdmins });
assert.equal(r.status, 1);
assert(r.stderr.includes('set POKEDEX_ADMIN_ID'));
const pickedDir = path.join(dir, 'picked-admin');
r = run('provision', undefined, pickedDir, {
  MOCK_ADMINS: twoAdmins,
  POKEDEX_ADMIN_ID: 'admin-2',
});
assert.equal(r.status, 0, r.stderr);
assert.equal(JSON.parse(fs.readFileSync(path.join(pickedDir, 'access.json'))).ownerId, 'admin-2');
r = run('provision', undefined, path.join(dir, 'unknown-admin'), { POKEDEX_ADMIN_ID: 'nobody' });
assert.equal(r.status, 1);

const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(':memory:');
db.exec(
  'CREATE TABLE catalogue_cards(id TEXT PRIMARY KEY,language TEXT,is_active INTEGER); CREATE TABLE card_sources(card_id TEXT,provider TEXT,active INTEGER); CREATE INDEX source_card ON card_sources(card_id);',
);
const actualQuery = JSON.parse(
  fs.readFileSync(path.join(dir, 'queries.jsonl'), 'utf8').trim().split('\n')[0],
);
const plan = db.prepare('EXPLAIN QUERY PLAN ' + actualQuery).all();
assert(
  plan.some(
    (row) =>
      String(row.detail).includes('sqlite_autoindex_catalogue_cards_1') &&
      String(row.detail).includes('id>?'),
  ),
);
db.close();
console.log(
  'PASS: secret-safe provisioning; partial verification fails; resume completes all variants; authorization failure stops; cleanup records revocation; JPEG artwork accepted; failed retries resume; failed registration leaves no run state; runs as a real admin.',
);
fs.rmSync(dir, { recursive: true });
