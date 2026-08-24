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
pnpm install --frozen-lockfile
pnpm dev
```

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

Local Worker state uses placeholder resource identifiers from `apps/web/wrangler.jsonc`. Put development secrets in `apps/web/.dev.vars`; production secrets belong in Wrangler. Do not commit either value.
