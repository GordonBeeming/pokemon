import type { Locator, Page } from '@playwright/test';
import * as api from './support/api';
import { expect, test } from './support/fixtures';
import { cardFullyPlaced, cardWithMix } from './support/scenarios';

// WhereFromDialog always lists exactly one radio per placed pocket, then loose, then
// miscount, in that order — both fixtures below have exactly one placed pocket, so
// the indices are stable: 0 = the pocket, 1 = loose, 2 = miscount.
const POCKET_RADIO = 0;
const LOOSE_RADIO = 1;
const MISCOUNT_RADIO = 2;

/**
 * `quantity` (useCardDetail) and `placedIn` (useCardBinderMatches) are two
 * independent queries; the "N in a binder · M loose" line renders the instant
 * quantity arrives, defaulting `placedIn` to `[]` until its own query resolves —
 * so a plain "does this text exist" wait can catch that premature 0-placed render
 * and open "Remove a copy" a beat too soon (loose+miscount only, never the pocket
 * radio). Waiting for the *exact* expected counts avoids that window entirely.
 */
async function openInspector(
  page: Page,
  cardId: string,
  expectPlaced: number,
  expectLoose: number,
): Promise<Locator> {
  await page.goto(`/catalogue?card=${cardId}`);
  const inspector = page.getByRole('dialog', { name: 'Card' });
  await expect(inspector).toBeVisible();
  await expect(
    inspector.getByText(new RegExp(`^${expectPlaced} in a binder · ${expectLoose} loose$`)),
  ).toBeVisible();
  return inspector;
}

test.describe('removing a copy always asks where it comes from', () => {
  test('from a pocket: the pocket empties, the count drops', async ({ page }) => {
    const { card, placement } = await cardWithMix(page.request);
    const inspector = await openInspector(page, card.id, 1, 1);
    await inspector.getByRole('button', { name: 'Remove a copy' }).click();

    const dialog = page.getByRole('dialog', { name: 'Where is this copy coming from?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('radio').nth(POCKET_RADIO).check();
    await dialog.getByRole('button', { name: 'Remove 1 copy' }).click();
    await expect(dialog).toBeHidden();

    const detail = await api.cardDetail(page.request, card.id);
    expect(detail.collection?.quantity).toBe(1);
    const matches = await api.binderMatches(page.request, card.id);
    const binder = matches.find((item) => item.binderId === placement.binderId);
    expect(binder?.placed.some((slot) => slot.slotId === placement.slotId)).toBe(false);
  });

  test('from loose: works when something is loose, disabled when nothing is', async ({ page }) => {
    // Mixed fixture: one placed, one loose — "From my loose cards" is enabled here.
    const mixed = await cardWithMix(page.request);
    const inspectorA = await openInspector(page, mixed.card.id, 1, 1);
    await inspectorA.getByRole('button', { name: 'Remove a copy' }).click();
    const dialogA = page.getByRole('dialog', { name: 'Where is this copy coming from?' });
    const looseRadioA = dialogA.getByRole('radio').nth(LOOSE_RADIO);
    await expect(looseRadioA).toBeEnabled();
    await looseRadioA.check();
    await dialogA.getByRole('button', { name: 'Remove 1 copy' }).click();
    await expect(dialogA).toBeHidden();
    const detailA = await api.cardDetail(page.request, mixed.card.id);
    expect(detailA.collection?.quantity).toBe(1);
    const matchesA = await api.binderMatches(page.request, mixed.card.id);
    const binderA = matchesA.find((item) => item.binderId === mixed.placement.binderId);
    // The placed copy is untouched — only the loose one was removed.
    expect(binderA?.placed.some((slot) => slot.slotId === mixed.placement.slotId)).toBe(true);

    // Fully-placed fixture: nothing loose — the same option is disabled.
    const fullyPlaced = await cardFullyPlaced(page.request);
    const inspectorB = await openInspector(page, fullyPlaced.card.id, 1, 0);
    await inspectorB.getByRole('button', { name: 'Remove a copy' }).click();
    const dialogB = page.getByRole('dialog', { name: 'Where is this copy coming from?' });
    await expect(dialogB.getByRole('radio').nth(LOOSE_RADIO)).toBeDisabled();
  });

  test('miscount with nothing loose asks which pocket to empty', async ({ page }) => {
    const { card, placement } = await cardFullyPlaced(page.request);
    const inspector = await openInspector(page, card.id, 1, 0);
    await inspector.getByRole('button', { name: 'Remove a copy' }).click();

    const dialog = page.getByRole('dialog', { name: 'Where is this copy coming from?' });
    await dialog.getByRole('radio').nth(MISCOUNT_RADIO).check();
    await dialog.getByRole('button', { name: 'Remove 1 copy' }).click();

    const miscountGroup = dialog.getByRole('radiogroup', { name: 'Which pocket to empty' });
    await expect(miscountGroup).toBeVisible();
    await miscountGroup.getByRole('radio').first().check();
    await dialog.getByRole('button', { name: 'Remove 1 copy' }).click();
    await expect(dialog).toBeHidden();

    const detail = await api.cardDetail(page.request, card.id);
    expect(detail.collection?.quantity).toBe(0);
    const matches = await api.binderMatches(page.request, card.id);
    const binder = matches.find((item) => item.binderId === placement.binderId);
    expect(binder?.placed.length ?? 0).toBe(0);
  });
});
