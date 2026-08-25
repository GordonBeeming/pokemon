import { describe, expect, it } from 'vitest';
import { apiRoutes } from './index';

const sharedPaths = [
  ['/catalogue/search', '/desktop/catalogue/search'],
  ['/catalogue/card-1', '/desktop/catalogue/card-1'],
  ['/collection/card-1', '/desktop/collection/card-1'],
  ['/collection/card-1/increment', '/desktop/collection/card-1/increment'],
  ['/collection/card-1/notes', '/desktop/collection/card-1/notes'],
  ['/binders', '/desktop/binders'],
  ['/binders/versions/version-1', '/desktop/binders/versions/version-1'],
  ['/binders/versions/version-1/shortages', '/desktop/binders/versions/version-1/shortages'],
  ['/binders/versions/version-1/slot', '/desktop/binders/versions/version-1/slot'],
  ['/binders/versions/version-1/swap', '/desktop/binders/versions/version-1/swap'],
  ['/art/manifest', '/desktop/art/manifest'],
  ['/art/card-1/high', '/desktop/art/card-1/high'],
] as const;

describe('browser and desktop route parity', () => {
  it.each(sharedPaths)(
    'preserves authentication boundaries for %s and %s',
    async (browser, desktop) => {
      const env = {} as CloudflareEnv;
      const browserResponse = await apiRoutes.request(browser, undefined, env);
      const desktopResponse = await apiRoutes.request(desktop, undefined, env);
      expect(browserResponse.status).toBe(401);
      expect(desktopResponse.status).toBe(401);
    },
  );
});
