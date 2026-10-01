import type { Page } from '@playwright/test';
import { z } from 'zod';
import * as api from './support/api';
import { expect, test } from './support/fixtures';
import { isPhoneProject } from './support/layout';
import { chooseSegment } from './support/nav';

// Binders this spec makes are deleted afterwards, so fixtures in other specs that pick
// "a binder with room" never land in one of them.
const made: Array<{ id: string; name: string }> = [];
test.afterEach(async ({ page }) => {
  for (const binder of made.splice(0)) {
    const response = await page.request.delete(`/api/binders/${binder.id}`, {
      data: { confirmationName: binder.name },
    });
    if (!response.ok() && response.status() !== 404)
      throw new Error(`Could not delete test binder ${binder.name}: ${response.status()}`);
  }
});

const createdSchema = z
  .object({
    binder: z
      .object({ version: z.object({ id: z.string(), binderId: z.string() }).passthrough() })
      .passthrough(),
  })
  .passthrough();
const setsSchema = z
  .object({
    sets: z.array(
      z
        .object({ setId: z.string(), setName: z.string(), language: z.string(), total: z.number() })
        .passthrough(),
    ),
  })
  .passthrough();
const cardsSchema = z
  .object({ cards: z.array(z.object({ id: z.string(), number: z.string() }).passthrough()) })
  .passthrough();

async function press(page: Page, phone: boolean, target: ReturnType<Page['locator']>) {
  if (phone) await target.tap();
  else await target.click();
}

test('Insert targets can take a whole set, in set order', async ({ page }, testInfo) => {
  const phone = isPhoneProject(testInfo);
  // A small English set with an unambiguous name keeps the run quick.
  const sets = setsSchema.parse(
    await (await page.request.get('/api/catalogue/facets/sets')).json(),
  );
  const set = sets.sets.find(
    (item) =>
      item.language === 'en' &&
      item.total >= 6 &&
      item.total <= 30 &&
      sets.sets.filter((other) => other.setName === item.setName).length === 1,
  );
  if (!set) throw new Error('no small English set in this database copy');
  const expected = cardsSchema
    .parse(
      await (
        await page.request.get(
          `/api/catalogue/search?set=${encodeURIComponent(set.setId)}&language=en&limit=100`,
        )
      ).json(),
    )
    .cards.sort((a, b) => a.number.localeCompare(b.number, 'en', { numeric: true }));
  expect(expected).toHaveLength(set.total);

  const name = `Set targets ${Date.now()}`;
  const created = createdSchema.parse(
    await (
      await page.request.post('/api/binders', {
        data: { name, layout: { kind: '3x3', rows: 3, columns: 3 }, capacity: 36 },
      })
    ).json(),
  );
  const { binderId, id: versionId } = created.binder.version;
  made.push({ id: binderId, name });

  await page.goto(`/binders/${binderId}?page=1&q=`);
  await press(page, phone, page.locator('[data-pocket="0:0:0"]'));
  await press(page, phone, page.getByRole('button', { name: 'Insert targets here' }));
  const panel = page.getByRole('dialog', { name: /^Insert/ });
  await chooseSegment(panel, 'Set');
  await panel.getByLabel('Search sets').fill(set.setName);
  await press(
    page,
    phone,
    panel.getByRole('button', { name: new RegExp(`^${escape(set.setName)}`) }),
  );
  await expect(panel.getByRole('status')).toContainText(
    `${set.total} cards from ${set.setName} selected, in set order.`,
  );
  await press(
    page,
    phone,
    panel.getByRole('button', { name: `Insert ${set.total} selected targets` }),
  );
  await expect(page.getByRole('dialog')).toHaveCount(0);

  const placed: string[] = [];
  for (let index = 0; placed.length < set.total && index < 4; index += 1) {
    const window = await api.binderPage(page.request, versionId, index);
    for (const slot of window.pages[0]?.slots ?? [])
      if (slot.entryKind === 'exact-card' && slot.cardId) placed.push(slot.cardId);
  }
  expect(placed).toEqual(expected.map((card) => card.id));
});

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
