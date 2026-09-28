import { configDefaults, defineConfig } from 'vitest/config';

// apps/web/e2e/** holds the Playwright suite, not vitest specs — Playwright
// has its own runner (`pnpm e2e`) and its files would otherwise fail to load here.
export default defineConfig({
  test: { environment: 'node', exclude: [...configDefaults.exclude, 'e2e/**'] },
});
