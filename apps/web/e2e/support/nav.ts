import type { Page } from '@playwright/test';

// The shell breakpoint AppShell/shell.css switches on — matches useIsDesktop's own
// `(min-width: 768px)` query, so "which nav is visible" always agrees with the app.
const DESKTOP_BREAKPOINT = 768;

/**
 * AppShell renders the same nav links twice — `.app-rail` (desktop) and
 * `.app-tabbar` (phone) — and only one is visible per breakpoint via CSS. Playwright
 * strict mode would otherwise fail on "2 elements match" for every nav click, so
 * every navigation goes through here instead of a bare `getByRole('link')`.
 */
export function navScope(page: Page): string {
  const width = page.viewportSize()?.width ?? 0;
  return width >= DESKTOP_BREAKPOINT ? '.app-rail' : '.app-tabbar';
}

export async function goToNav(page: Page, label: string): Promise<void> {
  await page.locator(navScope(page)).getByRole('link', { name: label }).click();
}

/**
 * The binder page's "Display" (peek/frame) controls sit inside a native
 * `<details open={!phone}>` — collapsed by default on a phone viewport, so its
 * radios aren't in the interactive tree at all until the `<summary>` is opened.
 * Clicking an already-open `<summary>` would toggle it shut, so this only acts
 * when it's actually closed.
 */
export async function ensureDisplayPanelOpen(page: Page): Promise<void> {
  const details = page.locator('.binder-display');
  const isOpen = await details.evaluate((element) => (element as HTMLDetailsElement).open);
  if (!isOpen) await details.locator('summary').click();
}
