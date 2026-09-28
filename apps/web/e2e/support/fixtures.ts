import { test as base, expect, type Page } from '@playwright/test';
import { devLoginAs } from './api';

/**
 * Every test needs a signed-in browser: sign in as the first active admin (creating
 * one on the spot on a completely fresh disposable copy, exactly like the worker's
 * dev-login route does) through the page's own request context, so the session
 * cookie lands in the browser context before any navigation. `page.goto` still
 * chooses the actual first route a test needs.
 */
export const test = base.extend<{ page: Page }>({
  page: async ({ page }, use) => {
    await devLoginAs(page.request);
    await use(page);
  },
});

export { expect };
