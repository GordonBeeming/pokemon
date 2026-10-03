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
const trainersSchema = z
  .object({
    trainers: z.array(
      z.object({ key: z.string(), name: z.string(), favorite: z.boolean() }).passthrough(),
    ),
  })
  .passthrough();

async function press(page: Page, phone: boolean, target: ReturnType<Page['locator']>) {
  if (phone) await target.tap();
  else await target.click();
}

async function lillie(page: Page) {
  const trainers = trainersSchema.parse(await (await page.request.get('/api/trainers')).json());
  const trainer = trainers.trainers.find((entry) => entry.key === 'lillie');
  if (!trainer) throw new Error('no Lillie cards in this database copy');
  return trainer;
}

async function setTrainerFavorite(page: Page, key: string, favorite: boolean) {
  const response = await page.request.put('/api/trainers/favorites', { data: { key, favorite } });
  expect(response.ok()).toBe(true);
}

test('Reserve page for a trainer fills the page with that trainer’s Pokémon', async ({
  page,
}, testInfo) => {
  const phone = isPhoneProject(testInfo);
  const trainer = await lillie(page);
  const name = `Trainer page ${Date.now()}`;
  const created = createdSchema.parse(
    await (
      await page.request.post('/api/binders', {
        data: { name, layout: { kind: '3x3', rows: 3, columns: 3 }, capacity: 18 },
      })
    ).json(),
  );
  const { binderId, id: versionId } = created.binder.version;
  made.push({ id: binderId, name });

  await page.goto(`/binders/${binderId}?page=1&q=`);
  if (phone) await page.locator('.binder-tools-trigger').tap();
  else await page.locator('.page-menu .menu-button-trigger').click();
  await press(
    page,
    phone,
    page.getByRole(phone ? 'button' : 'menuitem', { name: 'Reserve page for…' }),
  );
  const panel = page.getByRole('dialog', { name: 'Reserve page for' });
  await chooseSegment(panel, 'A trainer');
  await panel.getByLabel('Search trainers').fill(trainer.name);
  await press(page, phone, panel.getByRole('button', { name: new RegExp(`${trainer.name}`) }));
  await press(page, phone, panel.getByRole('button', { name: 'Reserve 9 empty pockets' }));
  await expect(page.getByRole('dialog')).toHaveCount(0);

  const window = await api.binderPage(page.request, versionId, 0);
  expect((window.pages[0]?.slots ?? []).map((slot) => slot.entryKind)).toEqual(
    Array.from({ length: 9 }, () => 'trainer'),
  );
  const pocket = page.locator('[data-pocket="0:0:0"]');
  await expect(pocket).toContainText(trainer.name);

  // Find cards offers that trainer's Pokémon.
  await press(page, phone, pocket);
  await press(page, phone, page.getByRole('button', { name: 'Find cards' }));
  const find = page.getByRole('dialog', { name: /^Find cards/ });
  await expect(find.locator('.find-cards-item').first()).toContainText(trainer.name);
});

test('starring a trainer moves it into Favourites', async ({ page }, testInfo) => {
  const phone = isPhoneProject(testInfo);
  const trainer = await lillie(page);
  await setTrainerFavorite(page, trainer.key, false);
  try {
    await page.goto('/trainers');
    const star = page.getByRole('button', { name: `Favourite ${trainer.name}` });
    await press(page, phone, star);
    const favourites = page.getByRole('region', { name: /Favourites/ });
    await expect(
      favourites.getByRole('button', { name: `Unfavourite ${trainer.name}` }),
    ).toBeVisible();

    // The trainer's tile opens their cards in the catalogue, starred there too.
    await press(page, phone, favourites.locator('.illustrator-open').first());
    await expect(page).toHaveURL(/[?&]trainer=lillie/u);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(trainer.name);
    await expect(page.getByRole('button', { name: `Unfavourite ${trainer.name}` })).toBeVisible();
  } finally {
    await setTrainerFavorite(page, trainer.key, false);
  }
});

test('starring a set moves it to the top of Sets', async ({ page }, testInfo) => {
  const phone = isPhoneProject(testInfo);
  await page.goto('/sets');
  const rows = page.locator('.set-card');
  await expect(rows.first()).toBeVisible();
  const last = rows.last();
  const setName = (await last.locator('.set-name').textContent()) ?? '';
  const star = last.getByRole('button', { name: `Favourite ${setName}` });
  await press(page, phone, star);
  try {
    await expect(rows.first().locator('.set-name')).toHaveText(setName);
    await expect(rows.first()).toHaveClass(/set-card-favorite/u);
  } finally {
    await press(page, phone, page.getByRole('button', { name: `Unfavourite ${setName}` }).first());
    await expect(page.getByRole('button', { name: `Unfavourite ${setName}` })).toHaveCount(0);
  }
});
