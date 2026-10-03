#!/usr/bin/env node --experimental-strip-types
// Writes the SQL that fills catalogue_cards.artist_key and trainer_key (migration 028)
// for rows imported before the importer set them. The keys come from the same shared
// functions the importer uses, so a backfilled row matches a freshly synced one.
//
// Usage: node --experimental-strip-types scripts/backfill-group-keys.mts <--local|--remote> <out.sql>
// Then:   wrangler d1 execute <db> <--local|--remote> --file <out.sql>
//
// Each statement only fills a key that is still NULL, so running it twice changes nothing.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { artistKey } from '../../../packages/shared/src/artists.ts';
import { trainerOf } from '../../../packages/shared/src/trainers.ts';

const [target, out] = process.argv.slice(2);
if ((target !== '--local' && target !== '--remote') || !out) {
  process.stderr.write('usage: backfill-group-keys.mts <--local|--remote> <out.sql>\n');
  process.exit(1);
}
const database = target === '--local' ? 'DB' : 'pokedex';

const wranglerOutput = z.array(
  z.object({
    results: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        artist: z.string().nullable(),
        category: z.string(),
      }),
    ),
  }),
);

const text = execFileSync(
  'pnpm',
  [
    'exec',
    'wrangler',
    'd1',
    'execute',
    database,
    target,
    '--config',
    'wrangler.jsonc',
    '--json',
    '--command',
    // Only rows that could still need a key: an unkeyed artist, or an unkeyed Pokémon
    // whose name could name a trainer.
    `SELECT id, name, artist, category FROM catalogue_cards
     WHERE (artist_key IS NULL AND trim(COALESCE(artist, '')) <> '')
        OR (trainer_key IS NULL AND category = 'pokemon'
          AND (name LIKE '%''s %' OR name LIKE '%’s %' OR name LIKE 'Dark %'))`,
  ],
  { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] },
);
const [first] = wranglerOutput.parse(JSON.parse(text.slice(text.indexOf('['))));
if (!first) throw new Error('wrangler returned no result set');
const rows = first.results;

const artists: Array<{ id: string; k: string }> = [];
const trainers: Array<{ id: string; k: string }> = [];
for (const row of rows) {
  const artist = row.artist?.trim() ? artistKey(row.artist) : '';
  if (artist) artists.push({ id: row.id, k: artist });
  const trainer = row.category === 'pokemon' ? trainerOf(row.name)?.key : undefined;
  if (trainer) trainers.push({ id: row.id, k: trainer });
}

const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
// D1 refuses a statement over 100 KB; 600 rows of id + key stay well under it.
const CHUNK = 600;
const statements: string[] = [];
for (const [column, list] of [
  ['artist_key', artists],
  ['trainer_key', trainers],
] as const)
  for (let index = 0; index < list.length; index += CHUNK)
    statements.push(
      `UPDATE catalogue_cards SET ${column} = json_extract(j.value, '$.k')
       FROM json_each(${quote(JSON.stringify(list.slice(index, index + CHUNK)))}) j
       WHERE catalogue_cards.id = json_extract(j.value, '$.id') AND catalogue_cards.${column} IS NULL;`,
    );
writeFileSync(out, `${statements.join('\n')}\n`);
process.stdout.write(
  `rows read: ${rows.length}, artist keys: ${artists.length}, trainer keys: ${trainers.length}, statements: ${statements.length}\n`,
);
