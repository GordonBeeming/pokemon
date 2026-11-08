import { mkdir } from 'node:fs/promises';
import { z } from 'zod';
import { expect, test } from './support/fixtures';
import { chooseSegment } from './support/nav';
import { binderPage } from './support/api';

const resultSchema = z.object({
  binder: z.object({
    version: z.object({
      id: z.string(),
      binderId: z.string(),
      revision: z.number(),
      capacity: z.number(),
      pageCount: z.number(),
    }),
  }),
});
const made: Array<{ id: string; name: string }> = [];
test.afterEach(async ({ page }) => {
  for (const binder of made.splice(0))
    expect(
      (
        await page.request.delete(`/api/binders/${binder.id}`, {
          data: { confirmationName: binder.name },
        })
      ).ok(),
    ).toBe(true);
});

test('removes a page containing placeholders through Manage page', async ({ page }, testInfo) => {
  const name = `Page removal ${Date.now()}`;
  const created = resultSchema.parse(
    await (
      await page.request.post('/api/binders', {
        data: { name, layout: { kind: '3x3', rows: 3, columns: 3 }, capacity: 18 },
      })
    ).json(),
  ).binder.version;
  made.push({ id: created.binderId, name });
  expect(
    (
      await page.request.post(`/api/binders/versions/${created.id}/pages/fill`, {
        data: {
          page: 0,
          pages: 1,
          target: { kind: 'pokemon', pokemonNumber: 25 },
          expectedRevision: created.revision,
        },
      })
    ).ok(),
  ).toBe(true);
  await page.goto(`/binders/${created.binderId}?page=1&q=`);
  if (testInfo.project.name === 'desktop')
    await page.getByRole('button', { name: 'Manage page', exact: true }).click();
  else await page.locator('.binder-tools-trigger').tap();
  const dir = process.env.POKEDEX_EVIDENCE_DIR ?? testInfo.outputPath('evidence');
  await mkdir(dir, { recursive: true });
  await page
    .getByRole(testInfo.project.name === 'desktop' ? 'menuitem' : 'button', {
      name: 'Remove page or placeholders…',
      exact: true,
    })
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Remove from page 1' })).toBeVisible();
  await chooseSegment(dialog, 'Remove entire page');
  if (testInfo.project.name === 'desktop')
    await page.screenshot({ path: `${dir}/after.png`, fullPage: true });
  await dialog.getByRole('button', { name: 'Remove page and 9 pockets', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText('Page 1 / 1', { exact: false })).toBeVisible();
});

test('clears placeholders while keeping the page and a placed card', async ({ page }, testInfo) => {
  const name = `Clear placeholders ${Date.now()}`;
  const created = resultSchema.parse(
    await (
      await page.request.post('/api/binders', {
        data: { name, layout: { kind: '3x3', rows: 3, columns: 3 }, capacity: 18 },
      })
    ).json(),
  ).binder.version;
  made.push({ id: created.binderId, name });
  const filled = resultSchema.parse(
    await (
      await page.request.post(`/api/binders/versions/${created.id}/pages/fill`, {
        data: {
          page: 0,
          pages: 1,
          target: { kind: 'pokemon', pokemonNumber: 25 },
          expectedRevision: created.revision,
        },
      })
    ).json(),
  ).binder.version;
  const card = z.object({ id: z.string() }).parse(
    await (
      await page.request.post('/api/catalogue/custom', {
        data: {
          name: 'Pikachu',
          language: 'en',
          category: 'pokemon',
          setId: 'test',
          setName: 'Test',
          number: '1',
        },
      })
    ).json(),
  );
  expect(
    (
      await page.request.put(`/api/binders/versions/${created.id}/slot`, {
        data: {
          page: 0,
          row: 0,
          column: 0,
          cardId: card.id,
          expectedRevision: filled.revision,
          copyChoice: { action: 'add', expectedCollectionRevision: 0 },
        },
      })
    ).ok(),
  ).toBe(true);
  await page.goto(`/binders/${created.binderId}?page=1&q=`);
  if (testInfo.project.name === 'desktop')
    await page.getByRole('button', { name: 'Manage page', exact: true }).click();
  else await page.locator('.binder-tools-trigger').tap();
  await page
    .getByRole(testInfo.project.name === 'desktop' ? 'menuitem' : 'button', {
      name: 'Remove page or placeholders…',
      exact: true,
    })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Clear 8 placeholders', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const after = await binderPage(page.request, created.id, 0);
  expect(after.version.pageCount).toBe(2);
  expect(after.pages[0]?.slots[0]?.assignedCardId).toBe(card.id);
  expect(after.pages[0]?.slots.slice(1).every((s) => s.entryKind === 'empty')).toBe(true);
});
