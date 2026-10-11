# Operational reference

Run commands from the repository root. All remote commands explicitly use `apps/web/wrangler.jsonc` and `--env-file /dev/null` to avoid unrelated local environment files. Confirm current CLI syntax with `--help` when it differs.

The production D1 database ID is `5e955d9c-188b-476a-80e9-8b1908f20f54`; the artwork helper refuses a checkout configured for another database or Worker.

## Inventory and freshness

```sh
pnpm --dir apps/web exec wrangler d1 execute DB --remote --config wrangler.jsonc --env-file /dev/null --json --command "SELECT language,COUNT(*) AS cards,MAX(release_date) AS newest_release FROM catalogue_cards WHERE is_active=1 GROUP BY language; SELECT id,status,started_at,completed_at,source_count,imported_count,inactive_count,refusal_reason FROM sync_runs WHERE provider='tcgdex' AND language='en' AND complete_source=1 ORDER BY started_at DESC LIMIT 5; SELECT variant,COUNT(*) AS stored_images,SUM(bytes) AS stored_bytes FROM art_manifest GROUP BY variant; SELECT id,label,role FROM users WHERE disabled_at IS NULL ORDER BY id;"
```

`/api/health` reports dependency and freshness state. A pre-existing missing pricing feed is separate from a catalogue refresh. Compare before and after instead of treating every non-200 response as a new deployment failure.

The set catalogue is `https://api.tcgdex.net/v2/en/sets`; set details are `/v2/en/sets/{id}`. TCGdex card detail image fields are image bases; append `/low.webp` or `/high.webp`. The production workflow owns card transformation and identity preservation.

## Backup and catalogue workflow

Use a distinct `<run-id>` per requested refresh. Check existing instances and D1 running full-sync rows first.

Back up each active user from the inventory query, one instance per user. The workflow refuses an id that isn't a real user.

```sh
pnpm --dir apps/web exec wrangler workflows trigger pokedex-backup '{"ownerId":"<user-id>","operation":"create"}' --id '<run-id>-backup-<user-id>' --config wrangler.jsonc --env-file /dev/null
pnpm --dir apps/web exec wrangler workflows instances describe pokedex-backup '<run-id>-backup-<user-id>' --config wrangler.jsonc --env-file /dev/null --no-step-output

pnpm --dir apps/web exec wrangler workflows trigger pokedex-catalogue-sync '{"language":"en","actorId":"<admin-id>","requestId":"<run-id>"}' --id '<run-id>' --config wrangler.jsonc --env-file /dev/null
pnpm --dir apps/web exec wrangler workflows instances describe pokedex-catalogue-sync '<run-id>' --config wrangler.jsonc --env-file /dev/null --no-step-output
```

The full-sync D1 row is `sync_<run-id>`. Poll at a sensible interval and keep progress visible. The command can produce many step rows; redirect to a log and summarize status and the last successful step. Use server start/end timestamps if the CLI's displayed duration is inconsistent.

Each backup protects one user's collection/binder/custom-card state; provider catalogue data is rebuildable. Do not describe it as a full database export.

## Replayed workflow tracking

A code deployment can reset `CatalogueFetcher` during a request. The workflow may resume and advance its steps while `sync_runs` remains marked failed by the interrupted execution. Always compare both before reporting failure or triggering another import.

For this specific mismatch, first verify that the same live instance is running and has completed steps after the recorded failure, that no newer full English sync exists, and that nothing has yet been applied. Preserve the failed row's status, timestamp, and reason in the run report/audit trail. A guarded update of that exact row from `failed` to `running`, clearing its failed-at timestamp and refusal reason, can reconcile the replay. Guard on the observed values and zero source/import counts; require exactly one changed row. Add a `catalogue.sync_tracking_reconciled` audit event. If these checks do not hold, stop to investigate instead of resetting status.

Never mark the row complete yourself. The workflow's successful apply must set its true completion timestamp.

## Artwork pass

The helper takes the repository path (`.` from the root) and persistent run directory. `provision` looks up the active admin (set `POKEDEX_ADMIN_ID=<admin-id>` when there are several; it refuses an id that isn't an active admin) and creates a 24-hour `art:read` credential owned by that admin, generates and stores it in 1Password, and registers only its hash in D1. It prints a secret reference, never the credential. `access.json` contains the reference and hash, not plaintext.

```sh
node .agents/skills/update-pokemon-catalogue/scripts/artwork-refresh.mjs provision . '<run-dir>'
POKEDEX_ART_TOKEN='op://ai-secrets/<returned-item-id>/password' op run -- node .agents/skills/update-pokemon-catalogue/scripts/artwork-refresh.mjs warm . '<run-dir>'
POKEDEX_ART_TOKEN='op://ai-secrets/<returned-item-id>/password' op run -- node .agents/skills/update-pokemon-catalogue/scripts/artwork-refresh.mjs verify . '<run-dir>'
node .agents/skills/update-pokemon-catalogue/scripts/artwork-refresh.mjs revoke . '<run-dir>'
```

The helper defaults to eight concurrent artwork requests. `POKEDEX_ART_CONCURRENCY` accepts 1–24 for measured tuning of a large initial backfill; lower it if throttling or transient failures rise. An optional final positive integer on `warm` limits a smoke test. Such a run is not full coverage; `verify` must still check all expected variants. If an initial artwork pass overlaps the metadata import, repeat `warm` after the catalogue finishes before final verification so newly inserted cards are included. Re-running `warm` uses its JSONL log to resume and revisits checksum mismatches from the previous verification. Check `progress.json`, `artwork.jsonl`, and `verification.json`; never infer completion from a process being alive.

For remaining 404s, distinguish missing card-detail image metadata from an image URL whose asset is unavailable. Query the exact English source card and check the relevant `low.webp` or `high.webp` URL. Supported gallery prints can use the deployed, identity-checked parent-set asset mapping; do not guess another printing or language. Record diagnostics with the run. A provider URL returning 200 warrants a bounded retry of that specific variant through the site's normal authenticated art route. If manually retrying a small known list, append a success to `artwork.jsonl` only after downloading and validating the actual WebP response, with `id`, `variant`, `ok: true`, `sha256`, `bytes`, and `checkedAt`; then run the helper's complete `verify` again. A successful HEAD request alone is not a cached or verified image.

The normal art route only fetches from TCGdex if its manifest entry is absent. Existing images are preserved. A manifest entry whose R2 object is missing needs investigation; do not delete or overwrite user artwork blindly.

## Durable refresh record

Build a JSON report with:

- run ID, provider, language, and site;
- start time, catalogue completion time, artwork verification time;
- the admin id it ran as, each user's backup ID, and the catalogue workflow ID;
- before/after card counts and newly present sets;
- low/high manifest counts and bytes, verified/failed/unvisited/mismatched image counts;
- unavailable source images and any other unresolved failure;
- an accurate overall outcome (`complete` only when verification is complete).

Store the dated report at `pokedex-art/maintenance/catalogue-refresh/<run-id>.json` and its latest outcome at `pokedex-art/maintenance/catalogue-refresh/latest.json` using `wrangler r2 object put --remote --file ... --content-type application/json`. Download the report again to verify it. Add an `audit` row for the chosen admin as actor, action `catalogue.refresh_completed` or `catalogue.refresh_incomplete`, target run ID, and the report summary in `meta`. Escape SQL values; never interpolate raw provider strings into SQL.

Do not invent or overwrite a successful `sync_runs.completed_at`. It records the actual successful workflow apply time, independently of artwork verification and the report timestamp.

When changing the helper, run `node .agents/skills/update-pokemon-catalogue/scripts/artwork-refresh.test.cjs`. Its fake CLI and HTTP fixtures test partial coverage, resume, changed checksums, empty inventory, auth failure, credential handling, and cleanup without accessing production.
