import type { Page } from '@playwright/test';
import { z } from 'zod';
import * as api from './support/api';
import { expect, test } from './support/fixtures';
import { isPhoneProject } from './support/layout';
import { chooseSegment } from './support/nav';

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
const cardsSchema = z
  .object({ cards: z.array(z.object({ id: z.string() }).passthrough()), total: z.number() })
  .passthrough();

async function press(page: Page, phone: boolean, target: ReturnType<Page['locator']>) {
  if (phone) await target.tap();
  else await target.click();
}

async function newBinder(page: Page, label: string, capacity: number) {
  const name = `${label} ${Date.now()}`;
  const created = createdSchema.parse(
    await (
      await page.request.post('/api/binders', {
        data: { name, layout: { kind: '3x3', rows: 3, columns: 3 }, capacity },
      })
    ).json(),
  );
  made.push({ id: created.binder.version.binderId, name });
  return created.binder.version;
}

test('Reserve page for Fire Energy makes every pocket a Fire Energy target', async ({
  page,
}, testInfo) => {
  const phone = isPhoneProject(testInfo);
  const { binderId, id: versionId } = await newBinder(page, 'Energy page', 18);
  await page.goto(`/binders/${binderId}?page=1&q=`);
  if (phone) await page.locator('.binder-tools-trigger').tap();
  else await page.locator('.page-menu .menu-button-trigger').click();
  await press(
    page,
    phone,
    page.getByRole(phone ? 'button' : 'menuitem', { name: 'Reserve page for…' }),
  );
  const panel = page.getByRole('dialog', { name: 'Reserve page for' });
  await chooseSegment(panel, 'Energy');
  await press(page, phone, panel.getByRole('button', { name: 'Fire Energy', exact: true }));
  await press(page, phone, panel.getByRole('button', { name: 'Reserve 9 empty pockets' }));
  await expect(page.getByRole('dialog')).toHaveCount(0);

  const window = await api.binderPage(page.request, versionId, 0);
  const slots = window.pages[0]?.slots ?? [];
  expect(slots.map((slot) => slot.entryKind)).toEqual(Array.from({ length: 9 }, () => 'energy'));
  await expect(page.locator('[data-pocket="0:0:0"]')).toContainText('Fire Energy');
});

test('Insert targets can add every Fire Energy in release order', async ({ page }, testInfo) => {
  const phone = isPhoneProject(testInfo);
  const expected = cardsSchema.parse(
    await (
      await page.request.get('/api/catalogue/search?energy=fire&sort=release&limit=100')
    ).json(),
  );
  expect(expected.total).toBeGreaterThan(1);
  const { binderId, id: versionId } = await newBinder(page, 'Energy order', 9 * 12);

  await page.goto(`/binders/${binderId}?page=1&q=`);
  await press(page, phone, page.locator('[data-pocket="0:0:0"]'));
  await press(page, phone, page.getByRole('button', { name: 'Insert targets here' }));
  const panel = page.getByRole('dialog', { name: /^Insert/ });
  await chooseSegment(panel, 'Energy');
  await chooseSegment(panel, 'Every card, release order');
  await press(page, phone, panel.getByRole('button', { name: 'Fire Energy', exact: true }));
  await expect(panel.getByRole('status')).toContainText('in release order');
  await press(
    page,
    phone,
    panel.getByRole('button', { name: `Insert ${expected.total} selected targets` }),
  );
  await expect(page.getByRole('dialog')).toHaveCount(0);

  const placed: string[] = [];
  for (let index = 0; placed.length < expected.total && index < 12; index += 1) {
    const window = await api.binderPage(page.request, versionId, index);
    for (const slot of window.pages[0]?.slots ?? [])
      if (slot.entryKind === 'exact-card' && slot.cardId) placed.push(slot.cardId);
  }
  expect(placed).toEqual(expected.cards.map((card) => card.id));
});

test('Mega Pokémon are a trainer', async ({ page }) => {
  await page.goto('/trainers?q=mega');
  await expect(page.locator('.illustrator-tile')).toHaveCount(1);
  await expect(page.locator('.illustrator-name')).toHaveText('Mega');
});
