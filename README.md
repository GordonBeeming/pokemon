# Pokédex

Pokédex is a private catalogue for Pokémon cards, collection quantities, prices, and digital binder plans. The web app runs on Cloudflare Workers.

## Architecture

- `apps/web`: React app and Hono Worker backed by D1, R2, Durable Objects, Workers Assets, and Workflows
- `packages/shared`: Zod schemas and wire types used by the web client and Worker
- `packages/ui`: small shared class-name helpers

Production sign-in uses passkeys with required user verification. `ENROLL_SECRET` is accepted only for the first passkey. Browser sessions are revocable. High- and low-resolution WebP card art stays in private R2 storage.

TCGdex supplies catalogue metadata and source art. Prices retain their source currency and timestamp, then use dated FX rates for conservative A$ estimates.

Release dates are stored once per set and language in `catalogue_sets`. Catalogue ordering, chronological copying, National Pokédex defaults, and binder arrangement all read that shared date. Partial card/species refreshes cannot erase or replace a known set date; a full catalogue sync can update it from set metadata. Backups retain compatible date fields in their export format and restore those values into the set table.

Owned catalogue printings sort by their latest copy addition. Notes and quantity reductions do not change that order. Other printings sort by set release date, oldest first, then set and collector number; unknown release dates come last. Historical copies with no recorded addition order use that same release-date order. The dashboard shows up to 50 recent owned printings. Its Active shortages button lists missing copies for unfilled targets in active binder plans, including Pokémon placeholders; copies placed elsewhere are unavailable to those targets.

Use **Copy displayed order** on any catalogue search or filter to copy up to 2,000 results in their current order, including later result pages. **Copy release-date order** copies those same results oldest first, regardless of ownership, without reordering the gallery. **Copy this page** copies only the visible page. The list stays in this browser's local storage across refreshes and tabs until cleared or replaced. In a binder, select a pocket and choose **Paste cards here**. Choose a paste method, then press **Paste cards** at the bottom to apply it. The default fills consecutive existing pockets without shifting later targets; **Insert and shift later targets** moves targets and their assignments along instead. Both modes show a preview, respect reserved-page boundaries, and reject changes if the binder revision is stale. Replacing occupied targets requires confirmation and releases their slot assignments; owned quantities remain unchanged.

Card artwork requires an explicit display context. Binder pockets show full-opacity art only when a physical copy is assigned to that pocket; other targets stay at 50% opacity, even if a copy is owned elsewhere. Collection summaries use ownership. Catalogue results, inspection views and card pickers are neutral previews at full opacity. Clicking outside a binder card, its tools or an open dialog dismisses the selected-pocket menu.

### Backfill missing artwork

`pnpm --dir apps/web art:backfill --out /absolute/run-directory` inventories all active English TCGdex-backed cards missing either artwork size and prepares verified source images without uploading them. It requires authenticated Wrangler access, `ffprobe`, and `cwebp`. Add `--source mfb-25,2021swsh-17` or `--limit 10` for a small trial.

For uploads, add `--apply` and inject `POKEDEX_ART_TOKEN` through `op run` using a temporary `art:read`/`art:write` credential. Revoke it after the run. The importer tries TCGdex, product-linked TCGplayer images, the published Pokémon TCG dataset, and TCGCSV metadata. It requires an unambiguous set/card match, caches TCGCSV metadata daily, and never replaces existing artwork. Uploaded WebP bytes are read back and checksum-verified. Re-running inventories only remaining gaps.

Each run writes `progress.jsonl` and `report.json`, including source URLs, unresolved matches, and errors. Applied runs also save their report under `maintenance/art-fallback/` in private R2. A successful run does not mean every card has an available source image; inspect unresolved entries before claiming complete coverage.

## Development

Requirements: Node.js 22 or newer and pnpm 10.

```sh
./run.sh
```

The launcher installs dependencies when needed, creates local-only development secrets, applies pending D1 migrations, and starts the Cloudflare web app at `http://localhost:7741`. Its Worker inspector uses `9241`; neither uses a framework default port.

Once the Worker is live, the launcher warms a small set of missing TCGdex images through the authenticated upload API; other card art is cached on demand while browsing. Set `POKEDEX_SKIP_ART_SEED=1` to skip it or `POKEDEX_LOCAL_ART_LIMIT` to change the default 12-card startup cap.

Run the complete repository gate with:

```sh
pnpm check
```

The gate checks formatting, TypeScript and Rust linting, type checking, unit tests, local D1/R2 integrations, builds, generated Wrangler types, and a Worker dry run. Individual commands remain available:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
pnpm wrangler:types:check
pnpm wrangler:dry-run
```

Local Worker state is isolated by Wrangler despite sharing the production binding names in `apps/web/wrangler.jsonc`. Put development secrets and the local `PUBLIC_ORIGIN` override in `apps/web/.dev.vars`; production secrets belong in Wrangler. Do not commit either secret value.

## Production catalogue

The production Worker exposes catalogue, pricing, FX, and backup Workflows without paid-plan schedules. Start the initial English catalogue import with:

```sh
pnpm --dir apps/web exec wrangler workflows trigger pokedex-catalogue-sync \
  --params '{"language":"en"}' --config wrangler.jsonc
```

Monitor it with:

```sh
pnpm --dir apps/web exec wrangler workflows instances list pokedex-catalogue-sync \
  --config wrangler.jsonc
```

Cloudflare requires a paid Workers plan before schedules can be attached directly to these Workflows; on-demand imports remain available without those schedule declarations.
