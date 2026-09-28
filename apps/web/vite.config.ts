import { cloudflare } from '@cloudflare/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The e2e suite runs its own server on its own port against a disposable copy of the
// local state directory, so it never shares the dev server on :7741 or writes into
// .wrangler/state. Outside e2e these env vars are unset and the defaults apply.
const port = Number(process.env.POKEDEX_E2E_PORT ?? 7741);
const inspectorPort = Number(process.env.POKEDEX_E2E_INSPECTOR_PORT ?? 9241);
const persistDir = process.env.POKEDEX_PERSIST_DIR;

export default defineConfig({
  plugins: [
    react(),
    cloudflare({
      configPath: './wrangler.jsonc',
      inspectorPort,
      ...(persistDir ? { persistState: { path: persistDir } } : {}),
    }),
  ],
  server: {
    host: '127.0.0.1',
    port,
    strictPort: true,
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
