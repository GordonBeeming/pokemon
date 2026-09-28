import { z } from 'zod';
import { getJson } from './support/api';
import { expect, test } from './support/fixtures';

// Gordon: "if you click on a recent card you want to see it... not as if you're
// browsing the other full pages" — desktop opens the card inspector over Home
// (Home's own `?card=` URL state), phone goes to the standalone card route instead
// of a panel that would cover the whole screen anyway.

const dashboardShelfSchema = z
  .object({ ok: z.literal(true), cards: z.array(z.object({ id: z.string(), name: z.string() })) })
  .passthrough();

test('desktop: clicking a recently added shelf card opens the card inspector over Home, not the catalogue', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop side-panel flow');
  const { cards } = await getJson(page.request, '/api/dashboard', dashboardShelfSchema);
  test.skip(cards.length === 0, 'nothing on the shelf in this dataset');
  const first = cards[0];
  if (!first) return;

  await page.goto('/');
  await page.locator('.shelf-cards button').first().click();

  const dialog = page.getByRole('dialog', { name: 'Card' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(first.name);
  await expect.poll(() => new URL(page.url()).searchParams.get('card')).toBe(first.id);

  // Back closes it and returns to Home rather than leaving the app entirely — the
  // open card lives in Home's own URL state, not a separate route.
  await page.goBack();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/$/);
});

test('phone: clicking a recently added shelf card goes to the standalone card route, not a panel', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'phone', 'phone standalone-route flow');
  const { cards } = await getJson(page.request, '/api/dashboard', dashboardShelfSchema);
  test.skip(cards.length === 0, 'nothing on the shelf in this dataset');
  const first = cards[0];
  if (!first) return;

  await page.goto('/');
  await page.locator('.shelf-cards button').first().tap();

  await expect(page).toHaveURL(new RegExp(`/card/${first.id}$`));
  await expect(page.getByRole('dialog', { name: 'Card' })).toHaveCount(0);
  await expect(page.locator('.card-page')).toContainText(first.name);
});
