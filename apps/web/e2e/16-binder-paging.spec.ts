import type { APIRequestContext, Page } from '@playwright/test';
import * as api from './support/api';
import { expect, test } from './support/fixtures';
import { isPhoneProject } from './support/layout';
import { openPageJump } from './support/nav';
import { activeVersionId } from './support/scenarios';

interface PagedBinder {
  id: string;
  pageCount: number;
}

// "Collections" is small (3x3) and mostly untouched by the other specs, so its pages
// load quickly and it always has more than a couple of them.
async function pagedBinder(request: APIRequestContext, name = 'Collections'): Promise<PagedBinder> {
  const binders = await api.listBinders(request);
  const binder = binders.find((item) => item.name === name) ?? binders[0];
  if (!binder) throw new Error('No binders exist in this database copy.');
  const versionId = await activeVersionId(request, binder.id);
  const window = await api.binderPage(request, versionId, 0);
  const pageCount = window.version.pageCount;
  if (pageCount < 3) throw new Error(`${binder.name} needs at least 3 pages, has ${pageCount}.`);
  return { id: binder.id, pageCount };
}

const edge = (page: Page, label: 'Previous page' | 'Next page') =>
  page.locator('.page-edge').and(page.getByRole('button', { name: label }));

async function openAt(page: Page, binder: PagedBinder, pageNumber: number): Promise<void> {
  await page.goto(`/binders/${binder.id}?page=${pageNumber}&q=`);
  await expect(
    page.locator('.binder-page:not(.binder-page-peek) [data-pocket]').first(),
  ).toBeVisible();
}

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(overflow.scrollWidth, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.innerWidth);
}

test('every pocket on the current and neighbouring pages is one size, and none is cut off', async ({
  page,
}) => {
  // Page 2 of the National Pokedex mixes placed cards, ANY targets and empty
  // sleeves, next to neighbouring pages with different mixes.
  const binder = await pagedBinder(page.request, 'National Pokedex');
  await openAt(page, binder, 2);
  await page.waitForLoadState('networkidle');
  const report = await page.evaluate(() => {
    const viewport = document.querySelector('.page-track-viewport')?.getBoundingClientRect();
    const pockets = [...document.querySelectorAll<HTMLElement>('.binder-page [data-pocket]')].map(
      (pocket) => {
        const box = pocket.getBoundingClientRect();
        return {
          at: pocket.dataset.pocket ?? '',
          width: box.width,
          height: box.height,
          bottom: box.bottom,
        };
      },
    );
    return { viewportBottom: viewport?.bottom ?? 0, pockets };
  });
  expect(report.pockets.length).toBeGreaterThan(0);
  const [first] = report.pockets;
  if (!first) throw new Error('no pockets');
  for (const pocket of report.pockets) {
    expect(Math.abs(pocket.width - first.width), `${pocket.at} width`).toBeLessThanOrEqual(1);
    expect(Math.abs(pocket.height - first.height), `${pocket.at} height`).toBeLessThanOrEqual(1);
    expect(pocket.bottom, `${pocket.at} is cut off by the page track`).toBeLessThanOrEqual(
      report.viewportBottom + 0.5,
    );
  }
});

test('View card opens the one card flyout, and closing it goes back to the pocket', async ({
  page,
}, testInfo) => {
  const phone = isPhoneProject(testInfo);
  const binder = await pagedBinder(page.request, 'National Pokedex');
  await openAt(page, binder, 2);
  // Page 2's first pocket holds a placed Bulbasaur in the seed data.
  const pocket = page.locator('[data-pocket="1:0:0"]');
  if (phone) await pocket.tap();
  else await pocket.click();
  const url = page.url();
  const viewCard = page.getByRole('button', { name: 'View card' });
  if (phone) await viewCard.tap();
  else await viewCard.click();

  const flyout = page.getByRole('dialog', { name: 'Card', exact: true });
  await expect(flyout).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'View card' })).toHaveCount(0);
  // The binder page behind it is still drawn.
  await expect(
    page.locator('.binder-page:not(.binder-page-peek) [data-pocket]').first(),
  ).toBeAttached();
  expect(
    await page.locator('.binder-page:not(.binder-page-peek) [data-pocket]').count(),
  ).toBeGreaterThan(0);

  const close = flyout.getByRole('button', { name: 'Close' }).first();
  if (phone) await close.tap();
  else await close.click();
  await expect(flyout).toHaveCount(0);
  expect(page.url()).toBe(url);
  if (!phone) await expect(pocket).toBeFocused();
});

test.describe('desktop', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, testInfo) => {
    test.skip(isPhoneProject(testInfo), 'desktop layout');
  });

  test('the buttons beside the binder turn the page both ways and stop at the ends', async ({
    page,
  }) => {
    const binder = await pagedBinder(page.request);
    await openAt(page, binder, 1);
    await expect(edge(page, 'Previous page')).toBeDisabled();
    await expect(edge(page, 'Next page')).toBeEnabled();

    // Beside the stage: the buttons sit outside the page track, left and right of it.
    const viewport = await page.locator('.page-track-viewport').boundingBox();
    const prevBox = await edge(page, 'Previous page').boundingBox();
    const nextBox = await edge(page, 'Next page').boundingBox();
    if (!viewport || !prevBox || !nextBox) throw new Error('edge buttons or track have no box');
    expect(prevBox.x + prevBox.width).toBeLessThanOrEqual(viewport.x);
    expect(nextBox.x).toBeGreaterThanOrEqual(viewport.x + viewport.width);
    expect(prevBox.width).toBeGreaterThanOrEqual(44);

    await edge(page, 'Next page').click();
    await expect(page).toHaveURL(/[?&]page=2(&|$)/u);
    await edge(page, 'Next page').click();
    await expect(page).toHaveURL(/[?&]page=3(&|$)/u);
    await edge(page, 'Previous page').click();
    await expect(page).toHaveURL(/[?&]page=2(&|$)/u);

    await openAt(page, binder, binder.pageCount);
    await expect(edge(page, 'Next page')).toBeDisabled();
    await expect(edge(page, 'Previous page')).toBeEnabled();
  });

  test('the pager sits under the binder and its page jump works', async ({ page }) => {
    const binder = await pagedBinder(page.request);
    await openAt(page, binder, 1);
    const pager = page.locator('.binder-pager');
    const stage = await page.locator('.binder-stage').boundingBox();
    const pagerBox = await pager.boundingBox();
    if (!stage || !pagerBox) throw new Error('stage or pager has no box');
    expect(pagerBox.y).toBeGreaterThanOrEqual(stage.y + stage.height);

    await pager.getByRole('spinbutton', { name: 'Go to page' }).fill('3');
    await pager.getByRole('button', { name: 'Go' }).click();
    await expect(page).toHaveURL(/[?&]page=3(&|$)/u);
    await expect(page.locator('.binder-page-indicator')).toHaveText(`Page 3 / ${binder.pageCount}`);
  });

  test('a selected pocket gets a one-row action bar with Close beside the actions', async ({
    page,
  }) => {
    // A species target offers nearly every action, so this is the widest the bar gets.
    const binder = await pagedBinder(page.request, 'National Pokedex');
    await openAt(page, binder, 1);
    await page.locator('[data-pocket="0:0:0"]').click();
    const bar = page.getByRole('toolbar', { name: 'Pocket actions' });
    await expect(bar).toBeVisible();

    const close = bar.getByRole('button', { name: 'Close', exact: true });
    const first = bar.locator('.action-bar-item').first();
    const closeBox = await close.boundingBox();
    const firstBox = await first.boundingBox();
    const barBox = await bar.boundingBox();
    if (!closeBox || !firstBox || !barBox) throw new Error('action bar parts have no box');
    // One row: Close shares the first action's row, and the bar is no taller than one
    // row of 44px buttons plus its padding.
    expect(Math.abs(closeBox.y - firstBox.y)).toBeLessThanOrEqual(1);
    expect(closeBox.height).toBeCloseTo(firstBox.height, 0);
    expect(barBox.height).toBeLessThanOrEqual(firstBox.height + 20);
    expect(closeBox.x).toBeGreaterThan(firstBox.x);

    // Scrolled to the end, neither the binder's last row nor the pager is under the bar.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const pager = await page.locator('.binder-pager').boundingBox();
    const barAtEnd = await bar.boundingBox();
    if (!pager || !barAtEnd) throw new Error('pager or bar has no box');
    expect(pager.y + pager.height).toBeLessThanOrEqual(barAtEnd.y);

    await close.click();
    await expect(bar).toHaveCount(0);
  });

  test('on a narrower desktop the action bar drops to icons and stays one row', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    const binder = await pagedBinder(page.request, 'National Pokedex');
    await openAt(page, binder, 1);
    await page.locator('[data-pocket="0:0:0"]').click();
    const bar = page.getByRole('toolbar', { name: 'Pocket actions' });
    await expect(bar).toBeVisible();

    const items = bar.locator('.action-bar-item');
    const first = await items.first().boundingBox();
    const close = await bar.getByRole('button', { name: 'Close', exact: true }).boundingBox();
    if (!first || !close) throw new Error('action bar parts have no box');
    for (const box of await items.evaluateAll((buttons) =>
      buttons.map((button) => button.getBoundingClientRect().top),
    ))
      expect(Math.abs(box - first.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(close.y - first.y)).toBeLessThanOrEqual(1);
    // Icon-only, but still named by its label and showing it on hover.
    const label = (await items.first().locator('span').first().textContent()) ?? '';
    expect(label.length).toBeGreaterThan(0);
    await expect(items.first()).toHaveAttribute('title', label);
    await expect(items.first()).toHaveAccessibleName(label);
    expect(first.width).toBeLessThanOrEqual(45);
  });
});

test.describe('phone', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, testInfo) => {
    test.skip(!isPhoneProject(testInfo), 'phone layout');
  });

  test('the chevrons over the page edges turn it, and nothing scrolls sideways', async ({
    page,
  }) => {
    const binder = await pagedBinder(page.request);
    await openAt(page, binder, 1);
    await expect(edge(page, 'Previous page')).toBeHidden();
    await expectNoSidewaysScroll(page);

    await edge(page, 'Next page').tap();
    await expect(page).toHaveURL(/[?&]page=2(&|$)/u);
    await expect(page.locator('.phone-page-number')).toContainText('2 /');
    await expectNoSidewaysScroll(page);

    await edge(page, 'Previous page').tap();
    await expect(page).toHaveURL(/[?&]page=1(&|$)/u);

    // The chevrons sit inside the page track, so they never widen the page.
    const viewport = await page.locator('.page-track-viewport').boundingBox();
    const next = await edge(page, 'Next page').boundingBox();
    if (!viewport || !next) throw new Error('track or chevron has no box');
    expect(next.x + next.width).toBeLessThanOrEqual(viewport.x + viewport.width + 0.5);
    expect(next.height).toBeGreaterThanOrEqual(44);
  });

  test('the pager under the binder opens the page jump', async ({ page }) => {
    const binder = await pagedBinder(page.request);
    await openAt(page, binder, 1);
    const stage = await page.locator('.binder-stage').boundingBox();
    const pager = await page.locator('.binder-pager').boundingBox();
    if (!stage || !pager) throw new Error('stage or pager has no box');
    expect(pager.y).toBeGreaterThanOrEqual(stage.y + stage.height);

    await openPageJump(page);
    const sheet = page.getByRole('dialog', { name: 'Go to a page' });
    await sheet.getByRole('spinbutton', { name: 'Go to page' }).fill('3');
    await sheet.getByRole('button', { name: 'Go' }).tap();
    await expect(page).toHaveURL(/[?&]page=3(&|$)/u);
    await expect(page.locator('.phone-page-number')).toContainText('3 /');
  });
});
