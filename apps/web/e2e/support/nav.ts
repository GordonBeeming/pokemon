import { expect, type Page } from '@playwright/test';

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
 * The binder page's "Display" (peek/frame) controls sit in a popover behind the
 * toolbar's Display trigger on every viewport, so its radios aren't in the
 * interactive tree until the trigger is pressed. Pressing an already-open trigger
 * would toggle it shut, so this only acts when it's actually closed.
 */
export async function ensureDisplayPanelOpen(page: Page): Promise<void> {
  const trigger = page.locator('.binder-display .menu-button-trigger');
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
}

/**
 * On a phone the catalogue opens straight to its cards, with search and filters
 * collapsed behind a summary pill. This opens them when they're collapsed, and does
 * nothing on desktop, where the controls are always shown.
 */
export async function ensureCatalogueControlsOpen(page: Page): Promise<void> {
  await page.locator('.catalogue-summary-pill, .catalogue-search-bar').first().waitFor();
  const pill = page.locator('.catalogue-summary-pill');
  if ((await pill.count()) === 0) return;
  if ((await pill.getAttribute('aria-expanded')) !== 'true') await pill.click();
}

/**
 * Asserts the catalogue's current text query. On a phone the search box is collapsed
 * behind the summary pill (and may be under an open card), so the pill's summary is
 * what shows the query there; on desktop it's the search box itself.
 */
export async function expectCatalogueQuery(page: Page, query: string): Promise<void> {
  await page.locator('.catalogue-summary-pill, .catalogue-search-bar').first().waitFor();
  const pill = page.locator('.catalogue-summary-pill');
  if ((await pill.count()) > 0) {
    await expect(pill).toContainText(query ? `“${query}”` : 'Search cards');
    return;
  }
  await expect(page.getByLabel('Search')).toHaveValue(query);
}

/** The active-filter count: the Filters button's badge on desktop, the pill's summary on a phone. */
export async function expectActiveFilterCount(page: Page, count: number): Promise<void> {
  await page.locator('.catalogue-summary-pill, .catalogue-search-bar').first().waitFor();
  const pill = page.locator('.catalogue-summary-pill');
  if ((await pill.count()) > 0) {
    if (count === 0) await expect(pill).not.toContainText('filter');
    else await expect(pill).toContainText(`${count} filter`);
    return;
  }
  if (count === 0) await expect(page.locator('.filter-count-badge')).toHaveCount(0);
  else await expect(page.locator('.filter-count-badge')).toHaveText(String(count));
}
