import { expect, test } from './support/fixtures';

for (const dismissal of ['Escape', 'Close button']) {
  test(`closing a card with ${dismissal} preserves the gallery scroll position`, async ({
    page,
  }) => {
    await page.goto('/catalogue');
    const card = page.locator('.catalogue-grid button.card-frame').nth(40);
    await card.scrollIntoViewIfNeeded();
    const originalY = await page.evaluate(() => window.scrollY);
    expect(originalY).toBeGreaterThan(300);
    await page.screenshot({ path: test.info().outputPath('before-opening.png') });

    await card.click();
    const dialog = page.getByRole('dialog', { name: 'Card', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.card-inspector')).toBeVisible();
    const originalCard = new URL(page.url()).searchParams.get('card');
    await dialog.getByRole('button', { name: 'Next card', exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('card')).not.toBe(originalCard);

    if (dismissal === 'Escape') await page.keyboard.press('Escape');
    else await dialog.getByRole('button', { name: 'Close', exact: true }).click();

    await expect(dialog).toBeHidden();
    await expect.poll(() => new URL(page.url()).searchParams.get('card')).toBeNull();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(originalY);
    await page.screenshot({ path: test.info().outputPath('after-closing.png') });
  });
}
