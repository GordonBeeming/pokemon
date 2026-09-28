import type { Page } from '@playwright/test';
import * as api from './support/api';
import { expect, test } from './support/fixtures';
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
  await page.getByRole('button', { name: /Filters/ }).tap();
  const sheet = page.getByRole('dialog', { name: 'Filters' });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('.sheet-handle')).toBeVisible();
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
