import * as api from './support/api';
import { expect, test } from './support/fixtures';
import { openPageJump } from './support/nav';
import { findMissingCard, placeLooseCopy } from './support/scenarios';

test('a picked-up card does not carry over when another binder opens', async ({ page }) => {
  const binders = await api.listBinders(page.request);
  const binderA = binders[0];
  const binderB = binders[1];
  if (!binderA || !binderB) throw new Error('Need at least two binders for this scenario.');

  // The real seed data starts every binder with zero placed pockets (only
  // targets), so this fixture makes its own placed pocket to pick up.
  const card = await findMissingCard(page.request);
  await api.incrementCollection(page.request, card.id, 1);
  const placement = await placeLooseCopy(page.request, card.id);
  const placedBinder = binders.find((item) => item.id === placement.binderId) ?? binderA;
  const otherBinder = binders.find((item) => item.id !== placement.binderId) ?? binderB;

  await page.goto(`/binders/${placedBinder.id}?page=${placement.page + 1}&q=`);
  const pocket = page.locator(
    `[data-pocket="${placement.page}:${placement.row}:${placement.column}"]`,
  );
  await pocket.click();
  await pocket.press('m');
  await expect(page.locator('.binder-banner-accent')).toContainText('Moving');

  // On a phone the jump field sits in a sheet; close it to reach the breadcrumb.
  if ((await page.locator('.phone-page-number').count()) > 0) await page.keyboard.press('Escape');
  await page.getByRole('link', { name: 'Back to all binders' }).click();
  await expect(page).toHaveURL(/\/binders$/);
  await page.locator('.binder-tile', { hasText: otherBinder.name }).click();
  await expect(page).toHaveURL(new RegExp(`/binders/${otherBinder.id}`));
  await expect(page.locator('.binder-view')).toBeVisible();
  await expect(page.locator('.binder-banner-accent')).toHaveCount(0);
});

test('an unsubmitted page-jump value resets when another binder opens', async ({ page }) => {
  const binders = await api.listBinders(page.request);
  const binderA = binders[0];
  const binderB = binders[1];
  if (!binderA || !binderB) throw new Error('Need at least two binders for this scenario.');

  await page.goto(`/binders/${binderA.id}?page=1&q=`);
  await openPageJump(page);
  const jumpInput = page.getByRole('spinbutton', { name: 'Go to page' });
  await jumpInput.fill('3');
  await expect(jumpInput).toHaveValue('3');

  // On a phone the jump field sits in a sheet; close it to reach the breadcrumb.
  if ((await page.locator('.phone-page-number').count()) > 0) await page.keyboard.press('Escape');
  await page.getByRole('link', { name: 'Back to all binders' }).click();
  await page.locator('.binder-tile', { hasText: binderB.name }).click();
  await expect(page).toHaveURL(new RegExp(`/binders/${binderB.id}`));
  await openPageJump(page);
  await expect(page.getByRole('spinbutton', { name: 'Go to page' })).toHaveValue('');
});
