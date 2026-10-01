import type { APIRequestContext, Page } from '@playwright/test';
import { z } from 'zod';
import * as api from './support/api';
import { expect, test } from './support/fixtures';
import { expectLayoutSound, expectNoToastOverOverlay, isPhoneProject } from './support/layout';
import { chooseSegment } from './support/nav';
import { findMissingCard } from './support/scenarios';

// Playwright only accepts an object pattern as the fixtures argument, even when no
// fixture is used, so the empty pattern is required here.
// eslint-disable-next-line no-empty-pattern
test.beforeEach(({}, testInfo) => {
  test.skip(!isPhoneProject(testInfo), 'phone interaction rules');
});

// Binders these tests make are deleted afterwards, so fixtures in other specs that
// pick "a binder with room" never land in one of them.
const made: Array<{ id: string; name: string }> = [];
test.afterEach(async ({ page }) => {
  for (const binder of made.splice(0)) {
    const response = await page.request.delete(`/api/binders/${binder.id}`, {
      data: { confirmationName: binder.name },
    });
    if (!response.ok() && response.status() !== 404)
      throw new Error(`Could not delete test binder ${binder.name}: ${response.status()}`);
  }
});

const mutationSchema = z
  .object({
    ok: z.literal(true),
    binder: z
      .object({
        version: z
          .object({ id: z.string(), binderId: z.string(), revision: z.number() })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

type Entry = { kind: 'pokemon'; pokemonNumber: number };

interface TestBinder {
  binderId: string;
  versionId: string;
  revision: number;
}

/** A small 3×3 binder of its own per test, so these writes never touch the binders
 * other specs read. */
async function createBinder(
  request: APIRequestContext,
  pages: number,
  entries: Entry[],
): Promise<TestBinder> {
  const name = `Phone rules ${Date.now()}`;
  const created = mutationSchema.parse(
    await (
      await request.post('/api/binders', {
        data: {
          name,
          layout: { kind: '3x3', rows: 3, columns: 3 },
          capacity: pages * 9,
        },
      })
    ).json(),
  );
  made.push({ id: created.binder.version.binderId, name });
  let binder: TestBinder = {
    binderId: created.binder.version.binderId,
    versionId: created.binder.version.id,
    revision: created.binder.version.revision,
  };
  if (entries.length > 0) binder = await insertEntries(request, binder, 0, entries);
  return binder;
}

async function insertEntries(
  request: APIRequestContext,
  binder: TestBinder,
  page: number,
  entries: Entry[],
): Promise<TestBinder> {
  const response = await request.post(`/api/binders/versions/${binder.versionId}/entries/insert`, {
    data: { at: { page, row: 0, column: 0 }, entries, expectedRevision: binder.revision },
  });
  const body = mutationSchema.parse(await response.json());
  return { ...binder, revision: body.binder.version.revision };
}

const species = (from: number, count: number): Entry[] =>
  Array.from({ length: count }, (_, index) => ({ kind: 'pokemon', pokemonNumber: from + index }));

async function openBinder(page: Page, binder: TestBinder, pageNumber = 1): Promise<void> {
  await page.goto(`/binders/${binder.binderId}?page=${pageNumber}&q=`);
  await expect(page.locator('.phone-page-number')).toBeVisible();
}

async function openPocket(page: Page, at: string) {
  await page.locator(`[data-pocket="${at}"]`).tap();
  const sheet = page.locator('.sheet[role="dialog"]');
  await expect(sheet).toBeVisible();
  await expectLayoutSound(page, `The pocket sheet for ${at}`);
  return sheet;
}

/** Rule 1 and 2: the surface has closed, the confirmation is showing, and it isn't
 * drawn over anything. */
async function expectDoneAndClosed(page: Page, message: string | RegExp): Promise<void> {
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.toast-viewport .toast').filter({ hasText: message })).toBeVisible();
  await expectNoToastOverOverlay(page);
  await expectLayoutSound(page, 'The page after the action');
}

test.describe('done means closed', () => {
  test('Change target closes the panel and the pocket sheet, then confirms', async ({ page }) => {
    const binder = await createBinder(page.request, 2, species(1, 3));
    await openBinder(page, binder);
    const sheet = await openPocket(page, '0:0:0');
    await sheet.getByRole('button', { name: 'Change target' }).tap();
    const panel = page.getByRole('dialog', { name: /^Change target/ });
    await expect(panel).toBeVisible();
    await panel.locator('.card-picker-item').first().tap();
    await panel.getByRole('button', { name: 'Set as target' }).tap();
    await expectDoneAndClosed(page, /is now the target for this pocket\./);
  });

  test('Move closes the pocket sheet, then the drop confirms', async ({ page }) => {
    const binder = await createBinder(page.request, 2, species(1, 2));
    await openBinder(page, binder);
    const sheet = await openPocket(page, '0:0:0');
    await sheet.getByRole('button', { name: 'Move', exact: true }).tap();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.locator('[data-pocket="0:1:1"]').tap();
    await expectDoneAndClosed(page, 'Moved to page 1, row 2, pocket 2.');
  });

  test('Remove closes and confirms', async ({ page }) => {
    const binder = await createBinder(page.request, 2, species(1, 2));
    await openBinder(page, binder);
    const sheet = await openPocket(page, '0:0:1');
    await sheet.getByRole('button', { name: 'Remove' }).tap();
    await page.getByRole('button', { name: 'Remove card and leave gap' }).tap();
    await expectDoneAndClosed(page, 'Card removed. The sleeve is now empty.');
  });

  test('Bookmark closes and confirms', async ({ page }) => {
    const binder = await createBinder(page.request, 2, species(4, 2));
    await openBinder(page, binder);
    const sheet = await openPocket(page, '0:0:0');
    await sheet.getByRole('button', { name: 'Bookmark' }).tap();
    await page.getByRole('button', { name: 'Save bookmark' }).tap();
    await expectDoneAndClosed(page, 'Bookmark saved.');
  });

  test('Insert closes and confirms', async ({ page }) => {
    const binder = await createBinder(page.request, 2, species(1, 1));
    await openBinder(page, binder);
    const sheet = await openPocket(page, '0:1:0');
    await sheet.getByRole('button', { name: 'Insert targets here' }).tap();
    const panel = page.getByRole('dialog', { name: /Insert/ });
    await panel
      .getByRole('button', { name: /Bulbasaur/ })
      .first()
      .tap();
    await panel.getByRole('button', { name: 'Insert 1 selected target' }).tap();
    await expectDoneAndClosed(page, '1 target inserted.');
  });

  test('Paste closes and confirms', async ({ page }) => {
    const binder = await createBinder(page.request, 2, species(1, 1));
    const card = await findMissingCard(page.request);
    await page.addInitScript(
      (copied) => {
        localStorage.setItem('pokedex.binder-card-clipboard.v1', JSON.stringify(copied));
      },
      {
        version: 1,
        cards: [{ id: card.id, name: card.name, setName: card.setName, number: card.number }],
      },
    );
    await openBinder(page, binder);
    const sheet = await openPocket(page, '0:2:0');
    await sheet.getByRole('button', { name: 'Paste here' }).tap();
    await page.getByRole('button', { name: 'Paste 1 card' }).tap();
    await expectDoneAndClosed(page, '1 card pasted.');
  });

  test('add first copy updates the card in place, with nothing drawn over it', async ({ page }) => {
    const card = await findMissingCard(page.request);
    await page.goto(`/catalogue?q=${encodeURIComponent(card.name)}&card=${card.id}`);
    const inspector = page.getByRole('dialog', { name: 'Card' });
    // The catalogue's art requests go first; on WebKit a write can queue behind them
    // for seconds against the local dev server.
    await page.waitForLoadState('networkidle');
    await inspector.getByRole('button', { name: 'Add first copy' }).tap();
    // The inspector is where the copy count lives, so it stays open and shows it.
    await expect(inspector.locator('output')).toHaveText('1');
    await expectNoToastOverOverlay(page);
    await expectLayoutSound(page, 'The card inspector');
    // One close control, in the header.
    await expect(inspector.getByRole('button', { name: 'Close' })).toHaveCount(1);
  });

  test('removing a copy closes the where-from dialog and confirms', async ({ page }) => {
    const card = await findMissingCard(page.request);
    await api.incrementCollection(page.request, card.id, 1);
    await page.goto(`/catalogue?q=${encodeURIComponent(card.name)}&card=${card.id}`);
    const inspector = page.getByRole('dialog', { name: 'Card' });
    // The catalogue's art requests go first; on WebKit a write can queue behind them
    // for seconds against the local dev server.
    await page.waitForLoadState('networkidle');
    await inspector.getByRole('button', { name: 'Remove a copy' }).tap();
    const dialog = page.getByRole('dialog', { name: 'Where is this copy coming from?' });
    await dialog.getByRole('radio').nth(0).check();
    await dialog.getByRole('button', { name: 'Remove 1 copy' }).tap();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.toast').filter({ hasText: 'Copy removed.' })).toBeVisible();
    await expectNoToastOverOverlay(page);
  });

  test('editing a set code closes the dialog and confirms', async ({ page }) => {
    await page.goto('/sets');
    // A set that already has a code, saved back unchanged: the rule under test is the
    // dialog's close-then-confirm, not the code itself.
    const edit = page
      .locator('.sets-list li')
      .filter({ has: page.locator('.set-code:not(.set-code-suggested)') })
      .first()
      .locator('.set-code-edit-button');
    const setName = ((await edit.getAttribute('aria-label')) ?? '').replace(/^Edit code for /, '');
    await edit.tap();
    const dialog = page.getByRole('dialog', { name: /^Edit code/ });
    const field = dialog.getByRole('textbox');
    const code = await field.inputValue();
    expect(code).not.toBe('');
    await field.fill(code);
    await expectLayoutSound(page, 'The set code dialog');
    await dialog.getByRole('button', { name: 'Save code' }).tap();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(
      page.locator('.toast').filter({ hasText: `${setName}'s code is now ${code.toUpperCase()}.` }),
    ).toBeVisible();
  });

  test('creating a binder leaves the form and opens the new binder', async ({ page }) => {
    await page.goto('/binders');
    await page.getByRole('button', { name: 'New binder' }).first().tap();
    const name = `Created on a phone ${Date.now()}`;
    await page.getByLabel('Name').fill(name);
    await page.getByRole('button', { name: 'Create binder' }).tap();
    await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
    await expect(page.locator('.toast').filter({ hasText: `${name} was created.` })).toBeVisible();
    await expect(page.locator('.create-binder')).toHaveCount(0);
    const binderId = /\/binders\/([^?]+)/u.exec(page.url())?.[1];
    if (binderId) made.push({ id: decodeURIComponent(binderId), name });
  });
});

test.describe('binder pages from anywhere', () => {
  test('a bookmark jump after inserting blank pages lands on the reserved page', async ({
    page,
  }) => {
    // Pages 1–3 hold targets, page 4 is reserved, page 5 holds more targets.
    let binder = await createBinder(page.request, 6, species(1, 27));
    binder = await insertEntries(page.request, binder, 4, species(28, 9));
    const reserved = await page.request.put(
      `/api/binders/versions/${binder.versionId}/reserved-page`,
      { data: { page: 3, reserved: true, label: 'Alola', expectedRevision: binder.revision } },
    );
    expect(reserved.ok()).toBe(true);

    // Visit the reserved page and its neighbours first, so they're cached.
    await openBinder(page, binder, 4);
    await expect(page.locator('.binder-page:not(.binder-page-peek)')).toHaveClass(
      /binder-page-reserved/,
    );
    await openBinder(page, binder, 2);

    await page.locator('.binder-tools-trigger').tap();
    await page.getByRole('button', { name: 'Add blank pages here…' }).tap();
    const panel = page.getByRole('dialog', { name: 'Add blank pages' });
    await chooseSegment(panel, 'Before page 2');
    await panel.getByRole('button', { name: 'Increase blank pages' }).tap();
    await panel.getByRole('button', { name: 'Add 2 blank pages' }).tap();
    await expectDoneAndClosed(page, '2 blank pages were added before page 2.');

    await page.locator('.phone-page-number').tap();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /Jump to bookmark/ })
      .tap();
    await page.getByRole('option', { name: 'Alola · page 6' }).tap();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page).toHaveURL(/[?&]page=6(&|$)/u);
    const current = page.locator('.binder-page:not(.binder-page-peek)');
    await expect(current).toHaveClass(/binder-page-reserved/);
    await expect(current).toContainText('Reserved page: Alola');
  });

  test('any page, reserved included, moves straight to page N', async ({ page }) => {
    let binder = await createBinder(page.request, 5, species(1, 9));
    const reserved = await page.request.put(
      `/api/binders/versions/${binder.versionId}/reserved-page`,
      { data: { page: 3, reserved: true, label: 'Art', expectedRevision: binder.revision } },
    );
    expect(reserved.ok()).toBe(true);
    binder = { ...binder, revision: binder.revision + 1 };

    await openBinder(page, binder, 4);
    await page.locator('.binder-tools-trigger').tap();
    await page.getByRole('button', { name: 'Move this page to…' }).tap();
    const panel = page.getByRole('dialog', { name: 'Move page 4' });
    await panel.getByLabel(/Move to page/).fill('2');
    await panel.getByRole('button', { name: 'Move page' }).tap();
    await expectDoneAndClosed(page, 'Page 4 moved to page 2.');
    await expect(page).toHaveURL(/[?&]page=2(&|$)/u);
    await expect(page.locator('.binder-page:not(.binder-page-peek)')).toContainText(
      'Reserved page: Art',
    );
  });
});

test.describe('basic controls', () => {
  test('find in this binder: always on screen, the list fits the field, and a pick clears it', async ({
    page,
  }) => {
    const binder = await createBinder(page.request, 2, species(1, 9));
    await openBinder(page, binder);
    // On a phone, find and jump-to-bookmark sit under the title, not in Tools.
    const field = page.getByRole('combobox', { name: 'Find in this binder' });
    await expect(field).toBeVisible();
    await expect(
      page.getByRole('button', { name: /Jump to bookmark|No bookmarks yet/ }),
    ).toBeVisible();
    await field.fill('Charmander');
    const list = page.getByRole('listbox');
    const match = list.getByRole('option', { name: /Charmander/ }).first();
    await expect(match).toBeVisible();
    const fieldBox = await field.boundingBox();
    const listBox = await page.locator('.space-search-popover').boundingBox();
    if (!fieldBox || !listBox) throw new Error('find field or results list has no box');
    expect(listBox.width).toBeLessThanOrEqual(fieldBox.width + 1);
    await expectLayoutSound(page, 'The find results');

    await match.tap();
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await expect(field).toHaveValue('');
    await expect.poll(() => new URL(page.url()).searchParams.get('q') ?? '').toBe('');
    // One layer: just the found pocket's own sheet.
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await expect(page.locator('.sheet[role="dialog"]')).toContainText('Charmander');
  });

  test('closing an overlay returns focus to its trigger and leaves the page where it was', async ({
    page,
  }) => {
    const binder = await createBinder(page.request, 2, species(1, 9));
    await page.setViewportSize({ width: page.viewportSize()?.width ?? 390, height: 560 });
    await openBinder(page, binder);
    // Opening a binder focuses its first pocket (scrolling it into view if needed);
    // let that land first so it can't undo the scroll this test sets up.
    await expect(page.locator('[data-pocket="0:0:0"]')).toBeFocused();
    const trigger = page.locator('.binder-tools-trigger');
    // Scrolled, but not so far that the header's Tools button leaves the screen: a
    // tap on an off-screen button would scroll the page itself.
    await trigger.evaluate((element) => {
      const top = element.getBoundingClientRect().top + window.scrollY;
      window.scrollTo(0, Math.max(1, Math.floor(top) - 8));
    });
    const before = await page.evaluate(() => window.scrollY);
    expect(before).toBeGreaterThan(0);
    await trigger.tap();
    const sheet = page.getByRole('dialog', { name: 'Binder tools' });
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button', { name: 'Close' }).tap();
    await expect(sheet).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(await page.evaluate(() => window.scrollY)).toBe(before);

    await trigger.tap();
    await expect(sheet).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
  });
});

test('every page and its main overlays fit every common phone width', async ({ page }) => {
  test.skip(test.info().project.name !== 'phone', 'the width sweep runs once, in Chromium');
  test.setTimeout(240_000);
  const binder = await createBinder(page.request, 2, species(1, 9));
  const card = await findMissingCard(page.request);
  for (const width of [320, 360, 375, 390, 393, 414, 430]) {
    await page.setViewportSize({ width, height: 800 });
    for (const path of [
      '/',
      '/catalogue',
      `/card/${encodeURIComponent(card.id)}`,
      '/pokedex',
      '/sets',
      '/binders',
      '/settings?tab=passkeys',
      '/settings?tab=frame-colours',
      '/settings?tab=api-tokens',
      '/settings?tab=catalogue-sync',
      '/settings?tab=people',
    ]) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await expectLayoutSound(page, `${path} at ${width}px`);
    }
    await page.goto(`/catalogue?q=${encodeURIComponent(card.name)}`);
    await page.locator('.catalogue-summary-pill').tap();
    await page.getByRole('button', { name: /Filters/ }).tap();
    await expectLayoutSound(page, `The filters sheet at ${width}px`);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Copy', exact: true }).tap();
    await expectLayoutSound(page, `The copy menu at ${width}px`);
    await page.keyboard.press('Escape');

    await openBinder(page, binder);
    await openPocket(page, '0:0:0');
    await page.keyboard.press('Escape');
    await page.locator('.binder-tools-trigger').tap();
    await expectLayoutSound(page, `The binder tools sheet at ${width}px`);
    await page.keyboard.press('Escape');
    await page.locator('.phone-page-number').tap();
    await expectLayoutSound(page, `The jump sheet at ${width}px`);
    await page.keyboard.press('Escape');
  }
});
