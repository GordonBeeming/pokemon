import * as api from './support/api';
import { expect, test } from './support/fixtures';
import { ensureDisplayPanelOpen, chooseSegment } from './support/nav';
import { activeVersionId, findMissingCard } from './support/scenarios';
import { escapeRegExp } from './support/text';

test('owned cards render solid, unowned cards render pale and dashed', async ({ page }) => {
  const owned = await findMissingCard(page.request);
  await api.incrementCollection(page.request, owned.id, 1);
  // Re-queried after the increment above, so it's guaranteed distinct from `owned`.
  const missing = await findMissingCard(page.request);
  expect(missing.id).not.toBe(owned.id);

  // Filtered to owned=missing/owned, not just a name search: a common name (e.g.
  // "Machamp") can have several printings, and elsewhere in the suite may already
  // own a different one — an unfiltered gallery sorts owned printings first, so
  // `.first()` could easily resolve to the wrong printing's ownership state.
  await page.goto(`/catalogue?q=${encodeURIComponent(missing.name)}&owned=missing`);
  const missingTile = page
    .locator('.catalogue-grid')
    .getByRole('button', { name: new RegExp(`^${escapeRegExp(missing.name)},`) })
    .first();
  await expect(missingTile).toBeVisible();
  await expect(missingTile).toHaveCSS('border-style', 'dashed');
  await expect(missingTile.locator('.card-frame-art')).toHaveCSS('opacity', '0.45');

  await page.goto(`/catalogue?q=${encodeURIComponent(owned.name)}&owned=owned`);
  const ownedTile = page
    .locator('.catalogue-grid')
    .getByRole('button', { name: new RegExp(`^${escapeRegExp(owned.name)},`) })
    .first();
  await expect(ownedTile).toBeVisible();
  await expect(ownedTile).toHaveCSS('border-style', 'solid');
  await expect(ownedTile.locator('.card-frame-art')).toHaveCSS('opacity', '1');
});

test('an unfilled any-Pokémon target shows the ANY frame; turning the frame off shows words instead', async ({
  page,
}) => {
  const binders = await api.listBinders(page.request);
  const binder = binders.find((item) => /pok[eé]dex/iu.test(item.name));
  if (!binder) throw new Error('No binder with "Pokédex" in its name was found.');
  const versionId = await activeVersionId(page.request, binder.id);

  let openTarget:
    { pageIndex: number; row: number; column: number; pokemonNumber: number } | undefined;
  for (let pageIndex = 0; pageIndex < 10 && !openTarget; pageIndex += 1) {
    const pageWindow = await api.binderPage(page.request, versionId, pageIndex);
    const slot = pageWindow.pages[0]?.slots.find(
      (item) => item.entryKind === 'pokemon' && !item.assignedCardId && item.pokemonNumber,
    );
    if (slot)
      openTarget = {
        pageIndex,
        row: slot.row,
        column: slot.column,
        pokemonNumber: slot.pokemonNumber as number,
      };
  }
  if (!openTarget) throw new Error('No open any-Pokémon target found in the first 10 pages.');

  await page.goto(`/binders/${binder.id}?page=${openTarget.pageIndex + 1}&q=`);
  const pocket = page.locator(
    `[data-pocket="${openTarget.pageIndex}:${openTarget.row}:${openTarget.column}"]`,
  );
  await expect(pocket).toBeVisible();
  await expect(pocket.getByText('ANY', { exact: true })).toBeVisible();
  // Inside a pocket, CardFrame renders without `onView` (a plain styled <div>, not
  // the button it is in the catalogue gallery) — the border lives there, not on
  // the outer `.pocket` button.
  await expect(pocket.locator('.card-frame')).toHaveCSS('border-style', 'dashed');

  await ensureDisplayPanelOpen(page);
  // SegmentedControl renders an ARIA radio group, not plain buttons.
  await chooseSegment(page.locator('.binder-display'), 'Off');
  await expect(pocket.locator('.pocket-any-pill')).toHaveText('Any');
  await expect(pocket.locator('.card-frame')).toHaveCount(0);

  await chooseSegment(page.locator('.binder-display'), 'On');
  await expect(pocket.getByText('ANY', { exact: true })).toBeVisible();
});
