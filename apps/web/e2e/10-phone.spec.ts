import type { Page } from '@playwright/test';
import * as api from './support/api';
import { expect, test } from './support/fixtures';
import { ensureCatalogueControlsOpen } from './support/nav';
import { activeVersionId } from './support/scenarios';

// Playwright only accepts an object pattern as the fixtures argument, even when no
// fixture is used, so the empty pattern is required here.
// eslint-disable-next-line no-empty-pattern
test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'phone-only flow');
});

async function assertNoHorizontalScroll(page: Page, screen: string): Promise<void> {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(
    overflow.scrollWidth,
    `${screen} overflows horizontally: ${JSON.stringify(overflow)}`,
  ).toBeLessThanOrEqual(overflow.innerWidth + 1);
}

test('no screen scrolls horizontally on a 390px phone viewport', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.app-tabbar')).toBeVisible();
  await assertNoHorizontalScroll(page, 'Home');

  await page.goto('/catalogue');
  await expect(page.getByRole('heading', { name: 'Find a physical card.' })).toBeVisible();
  await assertNoHorizontalScroll(page, 'Catalogue');

  await page.goto('/pokedex');
  await assertNoHorizontalScroll(page, 'National Pokédex');

  await page.goto('/sets');
  await assertNoHorizontalScroll(page, 'Sets');

  await page.goto('/binders');
  await assertNoHorizontalScroll(page, 'Binders library');

  const binders = await api.listBinders(page.request);
  const binder = binders[0];
  if (binder) {
    await page.goto(`/binders/${binder.id}?page=1&q=`);
    await expect(page.locator('.binder-view')).toBeVisible();
    await assertNoHorizontalScroll(page, 'Binder page');
  }

  await page.goto('/settings');
  await assertNoHorizontalScroll(page, 'Settings');
});

test('the catalogue filters trigger opens the phone sheet, not the desktop side panel', async ({
  page,
}) => {
  await page.goto('/catalogue');
  await ensureCatalogueControlsOpen(page);
  await page.getByRole('button', { name: /Filters/ }).tap();
  const sheet = page.getByRole('dialog', { name: 'Filters' });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('.sheet-handle')).toBeVisible();
});

test('the catalogue opens to its cards with search and filters behind a summary pill', async ({
  page,
}) => {
  await page.goto('/catalogue?q=pikachu&owned=missing');
  const pill = page.locator('.catalogue-summary-pill');
  await expect(pill).toBeVisible();
  await expect(pill).toHaveAttribute('aria-expanded', 'false');
  await expect(pill).toContainText('“pikachu” · Missing');
  await expect(page.getByLabel('Search')).toHaveCount(0);
  await expect(page.locator('.catalogue-grid button.card-frame').first()).toBeVisible();

  await pill.tap();
  await expect(page.getByLabel('Search')).toHaveValue('pikachu');
  await page.getByRole('button', { name: /^Show / }).tap();
  await expect(page.getByLabel('Search')).toHaveCount(0);
});

test('tapping a binder pocket opens the phone action sheet', async ({ page }) => {
  const binders = await api.listBinders(page.request);
  const binder = binders[0];
  if (!binder) throw new Error('No binders exist in this database copy.');
  const versionId = await activeVersionId(page.request, binder.id);
  const firstPage = await api.binderPage(page.request, versionId, 0);
  const slot = firstPage.pages[0]?.slots.find(
    (item) => item.entryKind && item.entryKind !== 'empty',
  );
  if (!slot) throw new Error(`Binder "${binder.name}" has no occupied pocket on its first page.`);

  await page.goto(`/binders/${binder.id}?page=1&q=`);
  const pocket = page.locator(`[data-pocket="0:${slot.row}:${slot.column}"]`);
  await expect(pocket).toBeVisible();
  await pocket.tap();

  const sheet = page.locator('.sheet[role="dialog"]');
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('.pocket-sheet-actions .action-bar')).toBeVisible();
});

test('swiping to the next binder page keeps the window where it was', async ({ page }) => {
  const binders = await api.listBinders(page.request);
  const binder = binders.find((item) => item.name === 'National Pokedex') ?? binders[0];
  if (!binder) throw new Error('No binders exist in this database copy.');

  // A short screen (browser chrome, a banner) so the binder page has to scroll.
  await page.setViewportSize({ width: 390, height: 560 });
  await page.goto(`/binders/${binder.id}?page=1&q=`);
  const viewport = page.locator('.page-track-viewport');
  await expect(viewport).toBeVisible();
  // Mid-screen: scroll as far as the page allows, up to just above the binder.
  await page.evaluate(() => {
    const stage = document.querySelector('.binder-stage');
    const target = stage ? stage.getBoundingClientRect().top + window.scrollY - 40 : 200;
    window.scrollTo(0, Math.min(target, document.documentElement.scrollHeight - innerHeight));
  });
  const before = await page.evaluate(() => window.scrollY);
  expect(before, 'the binder page should be tall enough to scroll on a phone').toBeGreaterThan(0);

  // A real right-to-left touch swipe across the page track, sent through CDP so the
  // app sees touch pointer events rather than a mouse drag.
  const box = await viewport.boundingBox();
  if (!box) throw new Error('page track has no box');
  const y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
    });
  await touch('touchStart', box.x + box.width * 0.8);
  for (const fraction of [0.65, 0.5, 0.35, 0.2])
    await touch('touchMove', box.x + box.width * fraction);
  await touch('touchEnd', box.x + box.width * 0.2);

  await expect(page).toHaveURL(/[?&]page=2(&|$)/u);
  await expect(page.locator('.phone-page-number')).toContainText('2 /');
  expect(await page.evaluate(() => window.scrollY)).toBe(before);
});

test.describe('bottom sheets', () => {
  async function openFiltersSheet(page: Page) {
    await page.goto('/catalogue');
    await ensureCatalogueControlsOpen(page);
    await page.getByRole('button', { name: /Filters/ }).tap();
    const sheet = page.getByRole('dialog', { name: 'Filters' });
    await expect(sheet).toBeVisible();
    return sheet;
  }

  test('a tap on the backdrop closes the sheet', async ({ page }) => {
    const sheet = await openFiltersSheet(page);
    // The strip above the sheet is backdrop (the sheet tops out at 85% of the screen).
    await page.touchscreen.tap(195, 20);
    await expect(sheet).toHaveCount(0);
  });

  test('the × in the header closes the sheet', async ({ page }) => {
    const sheet = await openFiltersSheet(page);
    await sheet.getByRole('button', { name: 'Close' }).tap();
    await expect(sheet).toHaveCount(0);
  });

  test('dragging the sheet body down neither dismisses it nor moves the page', async ({ page }) => {
    const sheet = await openFiltersSheet(page);
    const scrollBefore = await page.evaluate(() => window.scrollY);
    const body = sheet.locator('.sheet-body');
    const box = await body.boundingBox();
    if (!box) throw new Error('sheet body has no box');
    const x = box.x + box.width / 2;
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', y: number) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
      });
    // A long downward pull from the top of the body: the kind that would pull-to-refresh.
    const start = box.y + 10;
    await touch('touchStart', start);
    for (let step = 1; step <= 8; step++) await touch('touchMove', start + step * 40);
    await touch('touchEnd', start + 320);

    await expect(sheet).toBeVisible();
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
  });
});
