---
name: update-pokemon-catalogue
description: Refresh Gordon's Pokédex website with the latest English TCGdex card catalogue, cache and verify its artwork, and record when it was refreshed. Use for requests to update the Pokémon catalogue or add newly released sets on pokedex.gordonbeeming.com, including “update catalogue”.
---

# Update Pokémon catalogue

Refresh the real production data at `https://pokedex.gordonbeeming.com`. A request to update this catalogue authorizes its normal backup, import, artwork-cache, and refresh-record writes. A status-only request is read-only.

Use the `1password` skill for credentials and the `wrangler` skill for Cloudflare commands. Run `op whoami` before secret access; stop if it fails. No GUI or application login is needed.

## Scope and preflight

Work from this repository with its dependencies installed. Inspect `apps/web/wrangler.jsonc` and current workflow code before using the command reference. Expected production resources are Worker `pokedex-web`, D1 binding `DB` / database `pokedex`, and R2 bucket `pokedex-art` in Gordon's personal Cloudflare account. Do not change Cloudflare account configuration or deploy application code merely to refresh data.

English is the default because this catalogue currently tracks English printings. Preserve collection quantities, notes, binder layouts, representative choices, custom cards, and existing uploaded artwork.

1. Compare the provider's current set list at `https://api.tcgdex.net/v2/en/sets` with active sets in D1. If the user names a new release, verify its provider set detail and release date; use official Pokémon announcements when necessary. An announced set is not evidence that the provider has its card data or images.
2. Record active card/set counts, the last successful **full** English sync, and artwork coverage by variant. `complete_source = 1` distinguishes a full refresh from individual-card imports.
3. Cross-check D1 run rows with live Workflow instance status. A deployment can reset the fetch Durable Object while Cloudflare resumes the same workflow, leaving a stale failed D1 row. Look for an already-running full sync and resume monitoring it instead of starting another. Use a unique run ID and a persistent local run directory for logs and resume checkpoints.

Commands, database queries, and report fields are in [references/operations.md](references/operations.md).

## Refresh and verify

Finish planned application deployments before starting the sync: deployments can interrupt the shared catalogue fetch Durable Object. Coordinate any newly requested deployment with the active refresh.

1. Run `pokedex-backup` for owner `owner`; require completion and save its backup ID.
2. Trigger the deployed `pokedex-catalogue-sync` workflow with language `en` and actor `owner`. Monitor it through completion. It retrieves all source records, stages them, and applies them together. Leave the existing destructive-drop protection enabled.
3. Verify the corresponding `sync_runs` row is complete with `complete_source = 1`, and check the requested new sets and counts against the provider. Record imported/inactive counts and `completed_at`. A successful upload, queued workflow, or partial card import is not a completed catalogue refresh.
4. Run the artwork helper for both `low` and `high` variants. It uses the site's normal authenticated artwork route, which fills R2 and `art_manifest`. It retains existing uploaded/cached artwork and verifies the bytes served from storage. Use an expiring `art:read` credential in `ai-secrets`, then revoke and archive it after verification or when abandoning a run.
5. The helper's `verify` step must account for every active English source card and both variants, including cards newly added by this refresh. Preserve its checkpoint/log files for retry. Investigate failed, unvisited, or mismatched images; do not call incomplete coverage complete. Missing upstream images must be reported as unavailable, never replaced with fabricated art or silently ignored.
6. Save a dated JSON refresh report in R2 and update the latest-report object only with an accurate outcome. Record catalogue and artwork completion separately. Add the corresponding audit event. Keep the local report and verification file until remote storage is confirmed.

## Failure handling

- A failed catalogue workflow must not be replaced with a partial set list labelled as a full import. Never set `allowDestructiveDrop: true` just to make it pass.
- Provider errors, missing new-set data, or missing artwork are limitations to surface promptly. Retry transient failures within the helper's bounds; ask before adopting another source or approximation.
- Do not start a second full sync to work around a running one. Inspect its failed step and preserve its identifiers. For contradictory Workflow/D1 status, use the guarded reconciliation checks in the operations reference.
- If token cleanup fails, report that fact and its expiry. Do not print tokens or place them in reports, shell arguments, or source-controlled files.

## Completion report

Give the site link, UTC completion times, card/set changes, requested new-set coverage, and verified artwork counts for both sizes. State any remaining unavailable images or failed steps. Include the durable refresh-report key and backup/workflow IDs when useful for recovery. Keep code releases separate from catalogue refresh dates.
