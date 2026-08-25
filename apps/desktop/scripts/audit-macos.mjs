import { spawnSync } from 'node:child_process';

const manifest = 'src-tauri/Cargo.toml';
const lockfile = 'src-tauri/Cargo.lock';
const targets = ['aarch64-apple-darwin', 'x86_64-apple-darwin'];
const initializeDatabase = process.argv.includes('--initialize-db');

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !result.stdout.trim()) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result.stdout;
}

if (initializeDatabase) {
  JSON.parse(run('cargo', ['audit', '--json', '--file', lockfile]));
  process.stdout.write('RustSec advisory database initialized for the offline macOS audit.\n');
  process.exit(0);
}

const supportedPackages = new Set();
for (const target of targets) {
  const tree = run('cargo', [
    'tree',
    '--manifest-path',
    manifest,
    '--target',
    target,
    '--prefix',
    'none',
  ]);
  for (const line of tree.split('\n')) {
    const matched = line.match(/^(\S+) v(\S+)/u);
    if (matched) supportedPackages.add(`${matched[1]}@${matched[2]}`);
  }
}

const report = JSON.parse(run('cargo', ['audit', '--json', '--no-fetch', '--file', lockfile]));
const issues = [
  ...report.vulnerabilities.list.map((issue) => ({ ...issue, kind: 'vulnerability' })),
  ...Object.entries(report.warnings).flatMap(([kind, warnings]) =>
    warnings.map((issue) => ({ ...issue, kind })),
  ),
];
const applies = (issue) => supportedPackages.has(`${issue.package.name}@${issue.package.version}`);
const applicable = issues.filter(applies);
const excluded = issues.filter((issue) => !applies(issue));

if (excluded.length) {
  const ids = excluded
    .map((issue) => issue.advisory.id)
    .sort()
    .join(', ');
  process.stdout.write(
    `Excluded ${excluded.length} advisories absent from both supported macOS trees: ${ids}\n`,
  );
}
for (const issue of applicable) {
  process.stderr.write(
    `${issue.kind}: ${issue.advisory.id} affects ${issue.package.name} ${issue.package.version}: ${issue.advisory.title}\n`,
  );
}

const failures = applicable.filter(
  (issue) => issue.kind === 'vulnerability' || issue.kind === 'unsound' || issue.kind === 'yanked',
);
if (failures.length) process.exit(1);
process.stdout.write(
  `macOS audit passed for ${targets.join(' and ')}; ${applicable.length} applicable unmaintained warnings remain visible.\n`,
);
