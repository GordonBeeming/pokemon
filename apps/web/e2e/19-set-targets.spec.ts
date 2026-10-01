import type { Page } from '@playwright/test';
import { z } from 'zod';
import * as api from './support/api';
import { expect, test } from './support/fixtures';
import { isPhoneProject } from './support/layout';
import { chooseSegment } from './support/nav';

// Binders this spec makes are deleted afterwards, so fixtures in other specs that pick
// "a binder with room" never land in one of them.
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

const createdSchema = z
  .object({
    binder: z
      .object({ version: z.object({ id: z.string(), binderId: z.string() }).passthrough() })
      .passthrough(),
  })
  .passthrough();
const setsSchema = z
  .object({
    sets: z.array(
      z
        .object({ setId: z.string(), setName: z.string(), language: z.string(), total: z.number() })
        .passthrough(),
    ),
  })
  .passthrough();

type TestSet = z.infer<typeof setsSchema>['sets'][number];

async function press(page: Page, phone: boolean, target: ReturnType<Page['locator']>) {
  if (phone) await target.tap();
  else await target.click();
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** A small English set whose name no other set shares, so a search finds one button. */
async function smallSet(page: Page): Promise<TestSet> {
  const sets = setsSchema.parse(
    await (await page.request.get('/api/catalogue/facets/sets')).json(),
  );
  const set = sets.sets.find(
    (item) =>
      item.language === 'en' &&
      item.total >= 6 &&
      item.total <= 30 &&
      sets.sets.filter((other) => other.setName.includes(item.setName)).length === 1,
  );
  if (!set) throw new Error('no small English set in this database copy');
  return set;
}

async function newBinder(page: Page, label: string) {
  const name = `${label} ${Date.now()}`;
  const created = createdSchema.parse(
    await (
      await page.request.post('/api/binders', {
        data: { name, layout: { kind: '3x3', rows: 3, columns: 3 }, capacity: 36 },
      })
    ).json(),
  );
  made.push({ id: created.binder.version.binderId, name });
  return created.binder.version;
}

async function openPageMenu(page: Page, phone: boolean): Promise<void> {
  if (phone) await page.locator('.binder-tools-trigger').tap();
  else await page.locator('.page-menu .menu-button-trigger').click();
}

test('Insert targets can add pockets that take any card from a set', async ({ page }, testInfo) => {
  const phone = isPhoneProject(testInfo);
  const set = await smallSet(page);
  const { binderId, id: versionId } = await newBinder(page, 'Any from set');

  await page.goto(`/binders/${binderId}?page=1&q=`);
  await press(page, phone, page.locator('[data-pocket="0:0:0"]'));
  await press(page, phone, page.getByRole('button', { name: 'Insert targets here' }));
  const panel = page.getByRole('dialog', { name: /^Insert/ });
  await chooseSegment(panel, 'Set');
  await panel.getByLabel('How many pockets').fill('4');
  await panel.getByLabel('Search sets').fill(set.setName);
  await press(
    page,
    phone,
    panel.getByRole('button', { name: new RegExp(`^${escape(set.setName)}`) }),
  );
  await expect(panel.getByRole('status')).toContainText(
    `4 pockets for any card from ${set.setName}.`,
  );
  await press(page, phone, panel.getByRole('button', { name: 'Insert 4 selected targets' }));
  await expect(page.getByRole('dialog')).toHaveCount(0);

  const window = await api.binderPage(page.request, versionId, 0);
  const kinds = (window.pages[0]?.slots ?? []).map((slot) => slot.entryKind);
  expect(kinds.slice(0, 5)).toEqual(['set', 'set', 'set', 'set', 'empty']);
  const pocket = page.locator('[data-pocket="0:0:1"]');
  await expect(pocket).toContainText(set.setName);
  await expect(pocket).toContainText('Any');

  // Find cards on a set target offers that set's cards to add and place.
  await press(page, phone, pocket);
  await press(page, phone, page.getByRole('button', { name: 'Find cards' }));
  const find = page.getByRole('dialog', { name: /^Find cards/ });
  const first = find
    .locator('.find-cards-item')
    .filter({ hasText: 'Add a copy and place' })
    .first();
  await press(page, phone, first);
  await expect(page.getByRole('dialog', { name: /^Find cards/ })).toHaveCount(0);
  let placedCardId: string | null = null;
  await expect
    .poll(async () => {
      const after = await api.binderPage(page.request, versionId, 0);
      const slot = after.pages[0]?.slots[1];
      placedCardId = slot?.assignedCardId ?? null;
      return [slot?.entryKind, placedCardId !== null];
    })
    .toEqual(['set', true]);
  // Hand the added copy back, so the shared database keeps its counts.
  const pageId = (await api.binderPage(page.request, versionId, 0)).pages[0]?.id;
  if (!placedCardId || !pageId) throw new Error('the set target was not filled');
  const removed = await api.removeCollectionCopy(page.request, placedCardId, {
    source: 'pocket',
    slotId: `${pageId}:0:1`,
  });
  expect(removed.ok()).toBe(true);
});

test('Reserve page for fills the page’s empty pockets with a set target', async ({
  page,
}, testInfo) => {
  const phone = isPhoneProject(testInfo);
  const set = await smallSet(page);
  const { binderId, id: versionId } = await newBinder(page, 'Reserve page for');

  await page.goto(`/binders/${binderId}?page=2&q=`);
  await openPageMenu(page, phone);
  await press(
    page,
    phone,
    page.getByRole(phone ? 'button' : 'menuitem', { name: 'Reserve page for…' }),
  );
  const panel = page.getByRole('dialog', { name: 'Reserve page for' });
  await panel.getByLabel('Search sets').fill(set.setName);
  await press(
    page,
    phone,
    panel.getByRole('button', { name: new RegExp(`^${escape(set.setName)}`) }),
  );
  await press(page, phone, panel.getByRole('button', { name: 'Reserve 9 empty pockets' }));
  await expect(page.getByRole('dialog')).toHaveCount(0);

  const reserved = await api.binderPage(page.request, versionId, 1);
  expect((reserved.pages[0]?.slots ?? []).map((slot) => slot.entryKind)).toEqual(
    Array.from({ length: 9 }, () => 'set'),
  );
  // The pages either side are untouched.
  for (const index of [0, 2]) {
    const other = await api.binderPage(page.request, versionId, index);
    expect((other.pages[0]?.slots ?? []).every((slot) => slot.entryKind === 'empty')).toBe(true);
  }
});
