import * as api from './support/api';
import { expect, test } from './support/fixtures';
import {
  activeVersionId,
  binderWithNoMatch,
  findCardWithOpenPokemonTarget,
  findMissingCard,
} from './support/scenarios';

async function nationalPokedexBinderName(request: import('@playwright/test').APIRequestContext) {
  const binders = await api.listBinders(request);
  const binder = binders.find((item) => /pok[eé]dex/iu.test(item.name));
  if (!binder) throw new Error('No binder with "Pokédex" in its name was found.');
  return binder.name;
}

// The row collapsing (its "Add a copy and place" button disappearing) is driven by
// local component state, not by the write itself — waiting on it alone can resolve
// on a transient render before the POST /api/cards/:id/place round-trip actually
// lands. Waiting on the response directly is the only way to know the write is done
// before checking server state.
function waitForPlaceResponse(page: import('@playwright/test').Page) {
  return page.waitForResponse(
    (response) => response.url().includes('/place') && response.request().method() === 'POST',
  );
}

test('placing a card into a matching any-Pokémon target keeps the target, not rewriting it to exact', async ({
  page,
}) => {
  const binderName = await nationalPokedexBinderName(page.request);
  const { card, match } = await findCardWithOpenPokemonTarget(page.request, binderName);
  const target = match.nextTarget;
  if (!target) throw new Error('Expected an open pokemon target for the chosen card.');

  await page.goto(`/catalogue?card=${card.id}`);
  const inspector = page.getByRole('dialog', { name: 'Card' });
  const row = inspector.locator('.binder-row', { hasText: binderName });
  await expect(row).toBeVisible();
  await expect(row.locator('.binder-row-tag')).toHaveText('Target waiting');
  await row.getByRole('button').first().click();
  const placeResponse = waitForPlaceResponse(page);
  await row.getByRole('button', { name: 'Add a copy and place' }).click();
  expect((await placeResponse).ok()).toBe(true);

  const detail = await api.cardDetail(page.request, card.id);
  expect(detail.collection?.quantity).toBe(1);

  const versionId = await activeVersionId(page.request, match.binderId);
  const pageWindow = await api.binderPage(page.request, versionId, target.page);
  const slot = pageWindow.pages[0]?.slots.find(
    (item) => item.row === target.row && item.column === target.col,
  );
  expect(slot?.entryKind).toBe('pokemon');
  expect(slot?.assignedCardId).toBe(card.id);
});

test('"Add at the end" fills an empty pocket for a card with no existing target', async ({
  page,
}) => {
  const card = await findMissingCard(page.request);
  const matches = await api.binderMatches(page.request, card.id);
  const noMatch = binderWithNoMatch(matches);
  if (!noMatch || !noMatch.endDestination)
    throw new Error('Expected at least one binder with no target for a fresh missing card.');
  const destination = noMatch.endDestination;

  await page.goto(`/catalogue?card=${card.id}`);
  const inspector = page.getByRole('dialog', { name: 'Card' });
  const row = inspector.locator('.binder-row', { hasText: noMatch.name });
  await expect(row).toBeVisible();
  await expect(row.locator('.binder-row-tag')).toHaveText('Not in binder');
  await row.getByRole('button').first().click();
  await expect(row.getByText('Add at the end', { exact: false })).toBeVisible();
  const placeResponse = waitForPlaceResponse(page);
  await row.getByRole('button', { name: 'Add a copy and place' }).click();
  expect((await placeResponse).ok()).toBe(true);

  const versionId = await activeVersionId(page.request, noMatch.binderId);
  const pageWindow = await api.binderPage(page.request, versionId, destination.page);
  const slot = pageWindow.pages[0]?.slots.find(
    (item) => item.row === destination.row && item.column === destination.col,
  );
  expect(slot?.entryKind).toBe('exact-card');
  expect(slot?.cardId).toBe(card.id);
  expect(slot?.assignedCardId).toBe(card.id);
});
