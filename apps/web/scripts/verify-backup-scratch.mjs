import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = process.cwd();
const first = await mkdtemp(join(tmpdir(), 'pokedex-backup-source-'));
const second = await mkdtemp(join(tmpdir(), 'pokedex-backup-restore-'));
const wrangler = join(root, 'apps/web/node_modules/.bin/wrangler');
const run = async (persist, command) =>
  exec(
    wrangler,
    ['d1', 'execute', 'pokedex-local', '--local', '--persist-to', persist, '--command', command],
    { cwd: join(root, 'apps/web') },
  );
const migrate = async (persist) =>
  exec(
    wrangler,
    ['d1', 'migrations', 'apply', 'pokedex-local', '--local', '--persist-to', persist],
    { cwd: join(root, 'apps/web') },
  );

try {
  await migrate(first);
  await migrate(second);
  await run(
    first,
    "INSERT INTO users (id,label,created_at) VALUES ('owner','Owner',1); INSERT INTO catalogue_cards (id,name,language,category,set_id,set_name,number,is_custom,is_active,created_at,updated_at) VALUES ('card_fixture','Fixture','en','pokemon','set','Set','1',0,1,1,1); INSERT INTO collection_cards (owner_id,card_id,quantity,notes,revision,updated_at) VALUES ('owner','card_fixture',2,'fixture',1,1);",
  );
  await run(
    second,
    "INSERT INTO users (id,label,created_at) VALUES ('owner','Owner',1); INSERT INTO catalogue_cards (id,name,language,category,set_id,set_name,number,is_custom,is_active,created_at,updated_at) VALUES ('card_fixture','Fixture','en','pokemon','set','Set','1',0,1,1,1); INSERT INTO collection_cards (owner_id,card_id,quantity,notes,revision,updated_at) VALUES ('owner','card_fixture',2,'fixture',1,1);",
  );
  const source = await run(
    first,
    "SELECT COUNT(*) AS total, SUM(quantity) AS quantity FROM collection_cards WHERE owner_id = 'owner';",
  );
  const restored = await run(
    second,
    "SELECT COUNT(*) AS total, SUM(quantity) AS quantity FROM collection_cards WHERE owner_id = 'owner';",
  );
  const totals = (output) =>
    output
      .match(/"total":\s*(\d+),\s*"quantity":\s*(\d+)/s)
      ?.slice(1)
      .join(':');
  if (!totals(source.stdout) || totals(source.stdout) !== totals(restored.stdout))
    throw new Error('scratch backup totals differ');
  process.stdout.write('scratch backup restore totals match\n');
} finally {
  await rm(first, { recursive: true, force: true });
  await rm(second, { recursive: true, force: true });
}
