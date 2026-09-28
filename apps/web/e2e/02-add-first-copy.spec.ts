import { cardDetail } from './support/api';
import { expect, test } from './support/fixtures';
import { findMissingCard } from './support/scenarios';
import { escapeRegExp } from './support/text';

test('a card with 0 copies offers Add first copy, and adding one shows the stepper and solid art', async ({
  page,
}) => {
  const card = await findMissingCard(page.request);

  // Searching by name (rather than the owned=missing filter) keeps the tile on
  // screen after the mutation, so the "gallery frame turns solid" part of this can
  // actually be observed instead of the tile disappearing out of a missing-only list.
  await page.goto(`/catalogue?q=${encodeURIComponent(card.name)}&card=${card.id}`);

  const inspector = page.getByRole('dialog', { name: 'Card' });
  await expect(inspector).toBeVisible();
  await expect(inspector.getByRole('heading', { name: card.name })).toBeVisible();
  await expect(inspector.getByText('Not owned')).toBeVisible();

  const addFirst = inspector.getByRole('button', { name: 'Add first copy' });
  await expect(addFirst).toBeVisible();
  await expect(inspector.locator('output')).toHaveCount(0);

  const tile = page
    .locator('.catalogue-grid')
    .getByRole('button', { name: new RegExp(`^${escapeRegExp(card.name)},`) })
    .first();
  await expect(tile).toBeVisible();
  const tileArt = tile.locator('.card-frame-art');
  await expect(tileArt).toHaveCSS('opacity', '0.45');

  await addFirst.click();

  await expect(inspector.locator('output')).toHaveText('1');
  await expect(inspector.getByText('Owned ×1')).toBeVisible();
  await expect(tileArt).toHaveCSS('opacity', '1');
  await expect(tile).toHaveCSS('border-style', 'solid');

  const detail = await cardDetail(page.request, card.id);
  expect(detail.collection?.quantity).toBe(1);
});
