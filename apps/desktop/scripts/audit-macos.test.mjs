import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

describe('macOS Rust advisory audit', () => {
  it('initializes an empty Cargo home before the offline target-aware audit', () => {
    const root = mkdtempSync(join(tmpdir(), 'pokedex-audit-'));
    temporaryDirectories.push(root);
    const binaryDirectory = join(root, 'bin');
    const cargoHome = join(root, 'cargo-home');
    const callLog = join(root, 'cargo-calls.log');
    mkdirSync(binaryDirectory);
    mkdirSync(cargoHome);
    const cargo = join(binaryDirectory, 'cargo');
    writeFileSync(
      cargo,
      `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$AUDIT_CALL_LOG"
if [ "$1" = "tree" ]; then
  printf 'pokedex-desktop v0.1.0\\n'
  exit 0
fi
if [ "$1" = "audit" ]; then
  case " $* " in
    *" --no-fetch "*)
      if [ ! -d "$CARGO_HOME/advisory-db/crates" ]; then
        printf 'advisory database is missing\\n' >&2
        exit 1
      fi
      ;;
    *) mkdir -p "$CARGO_HOME/advisory-db/crates" ;;
  esac
  printf '{"vulnerabilities":{"list":[]},"warnings":{}}\\n'
  exit 0
fi
printf 'unexpected cargo command: %s\\n' "$*" >&2
exit 2
`,
    );
    chmodSync(cargo, 0o755);
    const script = fileURLToPath(new URL('./audit-macos.mjs', import.meta.url));
    const environment = {
      ...process.env,
      AUDIT_CALL_LOG: callLog,
      CARGO_HOME: cargoHome,
      PATH: `${binaryDirectory}:${process.env.PATH ?? ''}`,
    };

    const beforeInitialization = spawnSync(process.execPath, [script], {
      cwd: dirname(script),
      encoding: 'utf8',
      env: environment,
    });
    expect(beforeInitialization.status).toBe(1);
    expect(beforeInitialization.stderr).toContain('advisory database is missing');

    const initialization = spawnSync(process.execPath, [script, '--initialize-db'], {
      cwd: dirname(script),
      encoding: 'utf8',
      env: environment,
    });
    expect(initialization.status).toBe(0);
    expect(initialization.stdout).toContain('advisory database initialized');

    const audit = spawnSync(process.execPath, [script], {
      cwd: dirname(script),
      encoding: 'utf8',
      env: environment,
    });
    expect(audit.status).toBe(0);
    expect(audit.stdout).toContain('macOS audit passed');
    expect(readFileSync(callLog, 'utf8')).toContain(
      'audit --json --no-fetch --file src-tauri/Cargo.lock',
    );
  });
});
