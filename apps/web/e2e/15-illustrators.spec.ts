import { illustratorsResponseSchema, type Illustrator } from '@pokedex/shared';
import type { APIRequestContext } from '@playwright/test';
import { z } from 'zod';
import { expect, test } from './support/fixtures';
import { isPhoneProject } from './support/layout';
import { goToNav } from './support/nav';

const catalogueTotalSchema = z.object({ total: z.number().int().nonnegative() }).passthrough();
// illustratorsResponseSchema (packages/shared) is `.strict()` and describes only the
// `illustrators` payload; the route wraps it in `{ ok: true, ... }`.
const illustratorsWireResponseSchema = z
  .object({ ok: z.literal(true) })
  .merge(illustratorsResponseSchema)
  .passthrough();

/** The first illustrator with at least one card — every entry the API returns has
 * one by construction, but picking explicitly keeps the assumption visible here
 * rather than relying on it silently. */
async function firstIllustrator(request: APIRequestContext): Promise<Illustrator> {
  const response = await request.get('/api/illustrators');
  expect(response.ok(), 'GET /api/illustrators').toBe(true);
  const body = illustratorsWireResponseSchema.parse(await response.json());
  const illustrator = body.illustrators.find((entry) => entry.cardCount > 0);
  if (!illustrator) throw new Error('No illustrator with any cards in this database copy.');
  return illustrator;
}

test('desktop reaches Illustrators from the rail; a phone reaches it from Sets', async ({
  page,
}, testInfo) => {
  if (isPhoneProject(testInfo)) {
    await page.goto('/sets');
    await page.getByRole('link', { name: 'Illustrators' }).click();
  } else {
    await page.goto('/');
    await goToNav(page, 'Illustrators');
  }
  await expect(page).toHaveURL(/\/illustrators/u);
  await expect(page.getByRole('heading', { name: 'Illustrators' })).toBeVisible();
});

test('tiles render as real card frames', async ({ page }) => {
  await page.goto('/illustrators');
  await expect(page.locator('.illustrator-tile .card-frame').first()).toBeVisible();
});

test('tapping a tile filters the catalogue to that illustrator', async ({ page }) => {
  const target = await firstIllustrator(page.request);

  // Worker plumbing: the artist param actually narrows the catalogue search, not
  // just the illustrator listing's own count.
  const search = await page.request.get(
    `/api/catalogue/search?artist=${encodeURIComponent(target.name)}&limit=1`,
  );
  expect(catalogueTotalSchema.parse(await search.json()).total).toBe(target.cardCount);

  await page.goto('/illustrators');
  await page.getByLabel('Find an illustrator').fill(target.name);
  const tile = page
    .locator('.illustrator-tile')
    .filter({ has: page.getByText(target.name, { exact: true }) })
    .first();
  await expect(tile).toBeVisible();
  await tile.click();

  await expect(page.getByRole('heading', { level: 1, name: target.name })).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get('artist')).toBe(target.name);
  // Phones keep the chips behind the summary pill, which names the illustrator instead.
  const indicator = isPhoneProject(test.info())
    ? page.locator('.catalogue-summary-pill', { hasText: target.name })
    : page.locator('.filter-chip', { hasText: target.name });
  await expect(indicator).toBeVisible();
});

test('the inspector artist link filters the catalogue and closes the inspector', async ({
  page,
}) => {
  const target = await firstIllustrator(page.request);

  await page.goto(`/catalogue?card=${encodeURIComponent(target.representative.id)}`);
  const dialog = page.getByRole('dialog', { name: 'Card' });
  await expect(dialog).toBeVisible();

  const artistLink = page.locator('.card-inspector-artist-link', { hasText: target.name });
  await expect(artistLink).toBeVisible();
  await artistLink.click();

  await expect.poll(() => new URL(page.url()).searchParams.get('artist')).toBe(target.name);
  await expect(dialog).toHaveCount(0);
});

/** The e2e database is shared by every project in a run, so each star test starts and
 * ends with the illustrator unstarred. */
async function unstar(request: APIRequestContext, name: string): Promise<void> {
  const response = await request.put('/api/illustrators/favorites', {
    data: { name, favorite: false },
  });
  expect(response.ok(), 'unstar illustrator').toBe(true);
}

test('a starred illustrator moves into Favourites at the top and stays there after a reload', async ({
  page,
}) => {
  const target = await firstIllustrator(page.request);
  await unstar(page.request, target.name);
  await page.goto('/illustrators');
  await page.getByLabel('Find an illustrator').fill(target.name);

  await page.getByRole('button', { name: `Favourite ${target.name}`, exact: true }).click();
  const favorites = page.getByRole('region', { name: 'Favourites' });
  await expect(favorites.locator('.illustrator-name', { hasText: target.name })).toBeVisible();

  await page.reload();
  await page.getByLabel('Find an illustrator').fill(target.name);
  await expect(favorites.locator('.illustrator-name', { hasText: target.name })).toBeVisible();

  await page.getByRole('button', { name: `Unfavourite ${target.name}`, exact: true }).click();
  await expect(favorites).toHaveCount(0);
});

test("an illustrator's catalogue page is titled with their name and can star them", async ({
  page,
}) => {
  const target = await firstIllustrator(page.request);
  await unstar(page.request, target.name);
  await page.goto(`/catalogue?artist=${encodeURIComponent(target.name)}`);
  await expect(page.getByRole('heading', { level: 1, name: target.name })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to Illustrators' })).toBeVisible();

  await page.getByRole('button', { name: `Favourite ${target.name}`, exact: true }).click();
  await expect(
    page.getByRole('button', { name: `Unfavourite ${target.name}`, exact: true }),
  ).toBeVisible();

  await page.getByRole('link', { name: 'Back to Illustrators' }).click();
  await expect(
    page
      .getByRole('region', { name: 'Favourites' })
      .locator('.illustrator-name', { hasText: target.name }),
  ).toBeVisible();
  await unstar(page.request, target.name);
});
