# Pokédex

Pokédex is a private catalogue for Pokémon cards, collection quantities, prices, and digital binder plans. The web app runs on Cloudflare Workers. A Tauri desktop app handles local card captures, synchronises card art, and exposes an authenticated loopback MCP server.

## Architecture

- `apps/web`: React app and Hono Worker backed by D1, R2, Durable Objects, Workers Assets, and Workflows
- `apps/desktop`: Tauri scanner, local art library, Keychain pairing token, and MCP tools
- `packages/shared`: Zod schemas and wire types used by web and desktop clients
- `packages/ui`: small shared class-name helpers

Production sign-in uses passkeys with required user verification. `ENROLL_SECRET` is accepted only for the first passkey. Browser sessions are revocable and desktop tokens are scoped and time limited. High- and low-resolution WebP card art stays in private R2 storage.

TCGdex supplies catalogue metadata and source art. Prices retain their source currency and timestamp, then use dated FX rates for conservative A$ estimates.

## Development

Requirements: Node.js 22 or newer, pnpm 10, the stable Rust toolchain, and the platform prerequisites listed by Tauri.

```sh
./run.sh
```

The launcher installs dependencies when needed, creates local-only development secrets, applies pending D1 migrations, and starts both the Cloudflare web app and a separately identified `Pokédex Scanner Dev.app`. The web app runs at `http://localhost:7741`, its Worker inspector uses `9241`, and the scanner MCP bridge uses `47837`; none uses a framework default port. The debug scanner is bundled and ad-hoc signed so macOS can associate camera permission with its development bundle ID, then pointed at the local web origin without overwriting its saved production configuration.

Once the Worker is live, the launcher warms a small set of missing TCGdex images through the same authenticated upload API used by the desktop app; other card art is cached on demand while browsing. Set `POKEDEX_SKIP_ART_SEED=1` to skip it, `POKEDEX_LOCAL_ART_LIMIT` to change the default 12-card startup cap, or `POKEDEX_SKIP_DESKTOP=1` for a web-only run.

The repository includes a project-scoped Codex MCP connection in `.codex/config.toml`. Its bearer token is stored in the `ai-secrets` 1Password vault rather than source control. Start a Codex CLI session with the injected token using:

```sh
./codex.sh
```

The scanner must be running because its authenticated MCP endpoint is bound to `127.0.0.1:47837`.

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

## Scanner configuration and releases

The scanner defaults to `https://pokedex.gordonbeeming.com`. Its **Pokédex server URL** setting is persisted in the private desktop config, so another deployment can use its own HTTPS origin; loopback HTTP remains available for local development.

Publishing a `v{major}.{minor}` or `v{major}.{minor}-beta.{n}` GitHub release builds an Apple Developer ID-signed scanner, notarizes and staples the app and DMG, validates a quarantined consumer installation, uploads the DMG, and updates the `pokedex-scanner` Homebrew cask. Release credentials live in the protected `prod` GitHub environment.
