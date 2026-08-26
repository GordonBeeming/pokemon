import { cloudflare } from '@cloudflare/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), cloudflare({ configPath: './wrangler.jsonc', inspectorPort: 9241 })],
  server: {
    host: '127.0.0.1',
    port: 7741,
    strictPort: true,
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
