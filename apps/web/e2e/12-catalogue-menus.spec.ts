import { expect, test } from './support/fixtures';
import { ensureCatalogueControlsOpen } from './support/nav';

test('the catalogue opens on its bar and cards, with copy and bulk tools behind two triggers', async ({
  page,
}) => {
  await page.goto('/catalogue?q=pikachu');
  await ensureCatalogueControlsOpen(page);
  // Nothing from the copy or bulk tools is laid out until asked for.
  await expect(page.getByRole('menuitem')).toHaveCount(0);
  await expect(page.getByText('Add a card that is not in TCGdex')).toHaveCount(0);

  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  const copyMenu = page.getByRole('menu', { name: 'Copy catalogue cards' });
  await expect(copyMenu).toBeVisible();
  await copyMenu.getByRole('menuitem', { name: /^Displayed order/ }).click();

  await expect(copyMenu).toHaveCount(0);
  const toast = page.locator('.toast').filter({ hasText: /cards copied\./ });
  await expect(toast).toBeVisible();
  await toast.getByRole('button', { name: 'Open binders' }).click();
  await expect(page).toHaveURL(/\/binders$/);
});

test('the More menu opens each rare action in its own dialog, and the copy cap lives in the Copy menu', async ({
  page,
}) => {
  await page.goto('/catalogue');
  await ensureCatalogueControlsOpen(page);

  await page.getByRole('button', { name: 'More catalogue actions' }).click();
  await page.getByRole('menuitem', { name: /^Add a card that is not in TCGdex/ }).click();
  const custom = page.getByRole('dialog', { name: 'Add a card that is not in TCGdex' });
  await expect(custom.getByLabel('Custom card name')).toBeVisible();
  await custom.getByRole('button', { name: 'Cancel' }).click();
  await expect(custom).toHaveCount(0);

  await page.getByRole('button', { name: 'More catalogue actions' }).click();
  await page.getByRole('menuitem', { name: /^Add these results to a binder/ }).click();
  const bulk = page.getByRole('dialog', { name: 'Add these results to a binder' });
  // The full catalogue is over the 2,000 cap, so the dialog says so and won't add.
  await expect(
    bulk.getByText(/Narrow the results to 2,000 cards or fewer to add all\./),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(bulk).toHaveCount(0);

  await expect(
    page.getByText(/Narrow the results to 2,000 cards or fewer to copy all\./),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  const copyMenu = page.getByRole('menu', { name: 'Copy catalogue cards' });
  await expect(
    copyMenu.getByText(/Narrow the results to 2,000 cards or fewer to copy all\./),
  ).toBeVisible();
  await expect(copyMenu.getByRole('menuitem', { name: /^Displayed order/ })).toBeDisabled();
  await expect(copyMenu.getByRole('menuitem', { name: /^This page/ })).toBeEnabled();
});
