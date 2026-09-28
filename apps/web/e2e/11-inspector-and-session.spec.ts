import { randomUUID } from 'node:crypto';
import * as api from './support/api';
import { expect, test } from './support/fixtures';
import { goToNav } from './support/nav';
import { findMissingCard } from './support/scenarios';

// Playwright only accepts an object pattern as the fixtures argument, even when no
// fixture is used, so the empty pattern is required here.
// eslint-disable-next-line no-empty-pattern
test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'desktop keyboard and overlay flows');
});

test('a card with a saved note opens showing the note and closes with Escape', async ({ page }) => {
  const card = await findMissingCard(page.request);
  const state = await api.incrementCollection(page.request, card.id, 1);
  const patched = await page.request.patch(`/api/collection/${encodeURIComponent(card.id)}/notes`, {
    data: {
      mutationId: randomUUID(),
      expectedRevision: state.revision,
      notes: 'From the Sydney league',
    },
  });
  expect(patched.ok()).toBe(true);

  await page.goto(`/catalogue?q=${encodeURIComponent(card.name)}&card=${card.id}`);
  const dialog = page.getByRole('dialog', { name: 'Card' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('#card-inspector-notes')).toHaveValue('From the Sydney league');

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Notes are still saving')).toHaveCount(0);
});

test('the first ArrowRight after opening a card moves to the next card', async ({ page }) => {
  await page.goto('/catalogue?q=pikachu');
  const firstCard = page.locator('.catalogue-grid button.card-frame').first();
  await expect(firstCard).toBeVisible();
  await firstCard.click();
  await expect(page.getByRole('dialog', { name: 'Card' })).toBeVisible();
  const opened = new URL(page.url()).searchParams.get('card');

  await page.keyboard.press('ArrowRight');
  await expect.poll(() => new URL(page.url()).searchParams.get('card')).not.toBe(opened);
});

test('a session revoked on the server sends the next action to sign-in', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.app-rail')).toBeVisible();

  await api.logout(page.request);
  await goToNav(page, 'Catalogue');

  await expect(page.getByRole('button', { name: 'Continue with passkey' })).toBeVisible();
  await expect(page.locator('.app-rail')).toHaveCount(0);
});
