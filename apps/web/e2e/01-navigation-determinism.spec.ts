import { z } from 'zod';
import { getJson } from './support/api';
import { expect, test } from './support/fixtures';
import {
  ensureCatalogueControlsOpen,
  expectActiveFilterCount,
  expectCatalogueQuery,
  goToNav,
} from './support/nav';

test('navigation is deterministic across leave/return, back, and reload', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  await page.goto('/catalogue');
  await expect(page.getByRole('heading', { name: 'Find a physical card.' })).toBeVisible();
  const status = page.locator('.catalogue-gallery .live-status');

  // Query + a filter. "Common" is the rarity most of the catalogue actually has a
  // computed rarity for (unlike a card-type filter, which this real dataset only has
  // for a small minority of cards), so "e" + Common reliably clears 50 results.
  // The exact total comes from the API directly rather than the UI's own status
  // text: `keepPreviousData` keeps the *previous* query's "Showing 1 to 50 of N"
  // on screen while the next one loads, and a generic `\d+` pattern can't tell that
  // stale text apart from the real thing — only the precise number can.
  const { total } = await getJson(
    page.request,
    '/api/catalogue/search?q=e&rarity=C&limit=1&offset=0',
    z.object({ total: z.number() }).passthrough(),
  );
  expect(total).toBeGreaterThan(50);

  await ensureCatalogueControlsOpen(page);
  await page.getByLabel('Search').fill('e');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: /Filters/ }).click();
  await page.getByRole('checkbox', { name: 'Common', exact: true }).check();
  // Escape, not a "Close" button click: desktop's SidePanel has an icon button
  // labelled "Close", but phone's Sheet for the same Filters panel has no close
  // button at all (only its drag handle) — Escape is the one dismissal both
  // primitives' shared focus-trap hook actually implements.
  await page.keyboard.press('Escape');
  await expectActiveFilterCount(page, 1);
  await expect(status).toHaveText(new RegExp(`^Showing 1 to 50 of ${total} cards\\.$`));

  // Page 2.
  const nextPage = page.getByRole('navigation', { name: 'Catalogue pages' }).getByRole('button', {
    name: '2',
    exact: true,
  });
  await expect(nextPage).toBeVisible({ timeout: 10_000 });
  const firstCard = page.locator('.catalogue-grid button.card-frame').first();
  const page1FirstLabel = await firstCard.getAttribute('aria-label');
  await nextPage.click();
  await expect(status).toHaveText(new RegExp(`^Showing 51 to 100 of ${total} cards\\.$`));
  await expect(nextPage).toHaveAttribute('aria-current', 'page');
  // See "pagination text updates before the grid" below (test.fail()): the position
  // text above can say page 2 for a moment while the grid still shows page 1's
  // cards, so the card this flow opens is the one PROVEN to belong to page 2 — the
  // first one whose label actually differs from page 1's — not just "whatever's
  // first once the text looks right".
  await expect(firstCard).not.toHaveAttribute('aria-label', page1FirstLabel ?? '');

  // Open a card.
  await expect(firstCard).toBeVisible();
  const openedCardLabel = await firstCard.getAttribute('aria-label');
  await firstCard.click();
  await expect(page.getByRole('dialog', { name: 'Card' })).toBeVisible();

  const catalogueUrl = page.url();
  // The router serialises array search params as JSON, not a plain comma list, so
  // read the query back out rather than pattern-matching the raw string.
  const query = new URL(catalogueUrl).searchParams;
  expect(query.get('q')).toBe('e');
  expect(JSON.parse(query.get('rarity') ?? '[]')).toEqual(['C']);
  expect(query.get('page')).toBe('2');
  expect(query.get('card')).toBeTruthy();

  // The inspector is a modal (aria-modal="true"): a real person closes it before the
  // nav rail underneath is reachable at all, so Escape first, then leave to Binders,
  // then back to Catalogue via the nav — a clean start, not the state left behind.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Card' })).toBeHidden();
  await goToNav(page, 'Binders');
  await expect(page).toHaveURL(/\/binders$/);
  await goToNav(page, 'Catalogue');
  // TanStack Router always writes the full search object (defaults included), so a
  // "clean" catalogue is q=/page=1/no filters, not a bare path with no query at all.
  await expect(page).toHaveURL(/\/catalogue\?/);
  expect(new URL(page.url()).searchParams.get('q')).toBe('');
  expect(new URL(page.url()).searchParams.get('page')).toBe('1');
  await expectActiveFilterCount(page, 0);
  await expectCatalogueQuery(page, '');
  await expect(status).toHaveText(/^Showing 1 to 50 of \d+ cards\.$/);

  // Back returns to the exact previous URL and state, one history entry at a time:
  // the blank catalogue, then Binders, then the card-closed catalogue (page 2, same
  // filters), then finally the exact state this test left (the card open). Each
  // step waits for its own exact settled content (not `networkidle`, which this
  // app's own background query activity can leave pending indefinitely) before the
  // next fires.
  await page.goBack();
  await expect(page).toHaveURL(/\/binders$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/catalogue\?/);
  await expect(page.getByRole('dialog', { name: 'Card' })).toBeHidden();
  await expect(status).toHaveText(new RegExp(`^Showing 51 to 100 of ${total} cards\\.$`));
  await page.goBack();
  await expect(page).toHaveURL(catalogueUrl);
  await expectCatalogueQuery(page, 'e');
  await expectActiveFilterCount(page, 1);
  await expect(page.getByRole('dialog', { name: 'Card' })).toBeVisible();
  // Three history pops in a row is faster than any real person clicks Back; give
  // this specific re-settle more room than the suite's default 8s.
  await expect(status).toHaveText(new RegExp(`^Showing 51 to 100 of ${total} cards\\.$`), {
    timeout: 20_000,
  });
  await expect(page.locator('.catalogue-grid button.card-frame').first()).toHaveAttribute(
    'aria-label',
    openedCardLabel ?? '',
  );

  // Reload keeps the same state, because it all lives in the URL.
  await page.reload();
  await expect(page).toHaveURL(catalogueUrl);
  await expectCatalogueQuery(page, 'e');
  await expect(page.getByRole('dialog', { name: 'Card' })).toBeVisible();
  await expect(status).toHaveText(new RegExp(`^Showing 51 to 100 of ${total} cards\\.$`));
  await expect(page.locator('.catalogue-grid button.card-frame').first()).toHaveAttribute(
    'aria-label',
    openedCardLabel ?? '',
  );

  // No stale "Loading…" text lingers once navigation settles.
  await expect(page.getByText('Loading…', { exact: false })).toHaveCount(0);

  expect(consoleErrors, `unexpected console errors: ${consoleErrors.join('; ')}`).toEqual([]);
});

// While the next page loads, TanStack keeps the previous page's cards as placeholder
// data; the grid must show its skeleton rather than those cards under the new page's
// "Showing X to Y" line.
test('pagination text and the grid agree on which page is showing', async ({ page }) => {
  await page.goto('/catalogue?q=e&rarity=%5B%22C%22%5D');
  const status = page.locator('.catalogue-gallery .live-status');
  await expect(status).toHaveText(/^Showing 1 to 50 of \d+ cards\.$/);
  const firstCard = page.locator('.catalogue-grid button.card-frame').first();
  const page1Label = await firstCard.getAttribute('aria-label');

  await page
    .getByRole('navigation', { name: 'Catalogue pages' })
    .getByRole('button', { name: '2', exact: true })
    .click();
  // The status line stays blank while page 2 loads (the grid shows its skeleton), and a
  // cold server can take a while on this filtered query, hence the longer wait. Once it
  // reads page 2's range, the first tile must already be a page 2 card.
  await expect(status).toHaveText(/^Showing 51 to 100 of \d+ cards\.$/, { timeout: 20_000 });
  expect(await firstCard.getAttribute('aria-label')).not.toBe(page1Label);
});
