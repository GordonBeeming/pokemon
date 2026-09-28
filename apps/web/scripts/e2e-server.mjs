import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Playwright's webServer runs this file. It never touches the dev server on
// :7741 or its state directory: it copies apps/web/.wrangler/state/v3 to a fresh
// temp directory (outside the repo, so it's never a git concern) and points the
// Cloudflare vite plugin's persistState at the copy instead, via vite.config.ts's
// POKEDEX_PERSIST_DIR/POKEDEX_E2E_PORT env vars. Every run starts from a fresh copy;
// the suite is free to write to it because nothing else ever reads it.
const webDir = fileURLToPath(new URL('..', import.meta.url));
const sourceState = join(webDir, '.wrangler', 'state', 'v3');

const port = process.env.POKEDEX_E2E_PORT ?? '7751';
const inspectorPort = process.env.POKEDEX_E2E_INSPECTOR_PORT ?? '9251';

if (!existsSync(sourceState)) {
  throw new Error(
    `${sourceState} does not exist. Run the dev server (./run.sh) at least once first so there is local state to copy.`,
  );
}

const persistRoot = mkdtempSync(join(tmpdir(), 'pokedex-e2e-'));
cpSync(sourceState, join(persistRoot, 'v3'), { recursive: true });
// process.stdout, not console (the .mjs eslint override doesn't declare that global) —
// Playwright surfaces webServer stdout as-is, so this still shows up in its output.
process.stdout.write(`[e2e-server] copied ${sourceState} -> ${persistRoot}\n`);

const viteBin = join(webDir, 'node_modules', '.bin', 'vite');
const child = spawn(viteBin, [], {
  cwd: webDir,
  stdio: 'inherit',
  env: {
    ...process.env,
    POKEDEX_E2E_PORT: port,
    POKEDEX_E2E_INSPECTOR_PORT: inspectorPort,
    POKEDEX_PERSIST_DIR: persistRoot,
    // Every dev-login-created admin needs a distinct label so a rerun against the
    // same copy (or a stale one left by a crashed prior run) is easy to spot in logs.
    POKEDEX_E2E_RUN_ID: randomUUID(),
  },
});

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try {
    rmSync(persistRoot, { recursive: true, force: true });
  } catch {
    // Best-effort: a locked file (Windows, or a lingering miniflare handle) just
    // leaves one temp directory behind under the OS temp root, never under the repo.
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill(signal);
  });
}
child.on('exit', (code, signal) => {
  cleanup();
  process.exit(signal ? 0 : (code ?? 0));
});
