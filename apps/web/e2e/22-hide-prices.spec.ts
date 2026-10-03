import type { Page } from '@playwright/test';
import { z } from 'zod';
import { expect, test } from './support/fixtures';
import { isPhoneProject } from './support/layout';

const meSchema = z
  .object({ person: z.object({ id: z.string(), showPrices: z.boolean() }).passthrough() })
  .passthrough();

async function me(page: Page) {
  return meSchema.parse(await (await page.request.get('/api/people/me')).json()).person;
}

async function setShowPrices(page: Page, id: string, showPrices: boolean) {
  const response = await page.request.patch(`/api/people/${encodeURIComponent(id)}`, {
    data: { showPrices },
  });
  expect(response.ok()).toBe(true);
}

async function firstCardId(page: Page): Promise<string> {
  const body = z
    .object({ cards: z.array(z.object({ id: z.string() }).passthrough()).min(1) })
    .passthrough()
    .parse(await (await page.request.get('/api/catalogue/search?set=swshp&limit=1')).json());
  const [first] = body.cards;
  if (!first) throw new Error('no card in the priced set');
  return first.id;
}

// A set whose cards carry prices in the e2e database copy.
const PRICED_SET = '/catalogue?set=%5B%22swshp%22%5D';

test('an admin can hide every price for a person, and show them again', async ({
  page,
}, testInfo) => {
  const phone = isPhoneProject(testInfo);
  const person = await me(page);
  try {
    await setShowPrices(page, person.id, true);
    await page.goto(PRICED_SET);
    await expect(page.locator('.card-frame-price').first()).toBeVisible();

    // The switch lives on the person's row in Settings → People.
    await page.goto('/settings?tab=people');
    const hide = page
      .getByRole('group', { name: /^Prices for / })
      .first()
      .getByRole('button', { name: 'Prices hidden' });
    if (phone) await hide.tap();
    else await hide.click();
    await expect.poll(async () => (await me(page)).showPrices).toBe(false);

    await page.goto(PRICED_SET);
    await expect(page.locator('.card-frame').first()).toBeVisible();
    await expect(page.locator('.card-frame-price')).toHaveCount(0);
    await expect(page.locator('main')).not.toContainText('A$');
    // The card panel's estimate goes too.
    await page.goto(`${PRICED_SET}&card=${encodeURIComponent(await firstCardId(page))}`);
    await expect(page.getByText(/^Owned ×|^Not owned$/u).first()).toBeVisible();
    await expect(page.locator('body')).not.toContainText('A$');

    await page.goto('/');
    await expect(page.locator('main')).not.toContainText('Estimated value');
    await expect(page.locator('main')).not.toContainText('A$');
  } finally {
    await setShowPrices(page, person.id, true);
  }
  await page.goto(PRICED_SET);
  await expect(page.locator('.card-frame-price').first()).toBeVisible();
});
