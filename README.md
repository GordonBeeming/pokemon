# Pokédex

Pokédex is a private catalogue for Pokémon cards, collection quantities, and digital-twin binder plans. It is a desktop-first web app with a small Tauri companion for home scanning.

## Development

Requirements: Node.js 22 or newer and pnpm 10.

```sh
pnpm install
pnpm dev
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm --dir apps/web exec wrangler types ./cloudflare-env.d.ts --check
pnpm --dir apps/web exec wrangler deploy --dry-run
```

The web Worker runs with local D1, KV, R2, and Workers Assets bindings. Resource identifiers in `apps/web/wrangler.jsonc` are placeholders for local and future environment setup. Secrets belong in Wrangler or `.dev.vars`, never in source.

The first local device can use the localhost-only development login. Production authentication uses named passkeys, with `ENROLL_SECRET` reserved for the first device bootstrap.

## Repository shape

- `apps/web`: Hono Worker and React SPA
- `packages/shared`: zod schemas and wire types shared by the web and desktop apps
- `apps/desktop`: reserved for the Tauri companion
- `packages/ui`: reserved for the shared interface package

The catalogue ingestion source is TCGdex. It is used by backend synchronisation jobs and is not a browser runtime dependency.

# pokemon
