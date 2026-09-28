import { test as base, expect, type Page } from '@playwright/test';
import { devLoginAs } from './api';
import { expectLayoutSound, isPhoneProject } from './layout';

/**
 * Every test needs a signed-in browser: sign in as the first active admin (creating
 * one on the spot on a completely fresh disposable copy, exactly like the worker's
 * dev-login route does) through the page's own request context, so the session
 * cookie lands in the browser context before any navigation. `page.goto` still
 * chooses the actual first route a test needs.
 *
 * On every phone project the screen each test finishes on is also checked for
 * sideways scrolling and for overlays past the screen edge, so a layout regression
 * anywhere in the suite fails the test that reached it.
 */
export const test = base.extend<{ page: Page }>({
  page: async ({ page }, use, testInfo) => {
    await devLoginAs(page.request);
    await use(page);
    if (
      isPhoneProject(testInfo) &&
      testInfo.status === testInfo.expectedStatus &&
      !page.isClosed() &&
      page.url().startsWith('http')
    )
      await expectLayoutSound(page, `The screen "${testInfo.title}" ends on`);
  },
});

export { expect };
