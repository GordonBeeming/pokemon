import type { APIRequestContext, Page } from '@playwright/test';
import { z } from 'zod';
import * as api from './support/api';
import { expect, test } from './support/fixtures';
import { isPhoneProject } from './support/layout';

// Binders these tests make are deleted afterwards, so fixtures in other specs that
// pick "a binder with room" never land in one of them.
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

const mutationSchema = z
  .object({
    ok: z.literal(true),
    binder: z
      .object({
        version: z
          .object({ id: z.string(), binderId: z.string(), revision: z.number() })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();
const searchTotalSchema = z.object({ ok: z.literal(true), total: z.number() }).passthrough();

async function printingCount(
  request: APIRequestContext,
  pokedexNumber: number,
  owned?: boolean,
): Promise<number> {
  const params = new URLSearchParams({ pokedexNumber: String(pokedexNumber), limit: '1' });
  if (owned !== undefined) params.set('owned', String(owned));
  const response = await request.get(`/api/catalogue/search?${params}`);
  return searchTotalSchema.parse(await response.json()).total;
}

/** A species with printings in the catalogue and not one of them owned, so Find cards
 * has nothing spare to offer and every printing is an "add a copy". */
async function unownedSpecies(request: APIRequestContext): Promise<number> {
  for (let dex = 1025; dex > 900; dex -= 1) {
    if ((await printingCount(request, dex, true)) > 0) continue;
    if ((await printingCount(request, dex)) > 0) return dex;
  }
  throw new Error('No species between #901 and #1025 has printings and no owned copy.');
}

async function binderWithTarget(
  request: APIRequestContext,
  pokemonNumber: number,
): Promise<{ binderId: string; versionId: string }> {
  const name = `Find cards ${Date.now()}`;
  const created = mutationSchema.parse(
    await (
      await request.post('/api/binders', {
        data: { name, layout: { kind: '3x3', rows: 3, columns: 3 }, capacity: 9 },
      })
    ).json(),
  );
  const { binderId, id: versionId, revision } = created.binder.version;
  made.push({ id: binderId, name });
  const inserted = await request.post(`/api/binders/versions/${versionId}/entries/insert`, {
    data: {
      at: { page: 0, row: 0, column: 0 },
      entries: [{ kind: 'pokemon', pokemonNumber }],
      expectedRevision: revision,
    },
  });
  mutationSchema.parse(await inserted.json());
  return { binderId, versionId };
}

async function press(page: Page, phone: boolean, target: ReturnType<Page['locator']>) {
  if (phone) await target.tap();
  else await target.click();
}

test('Find cards on an any-printing target adds a copy of a printing and places it', async ({
  page,
}, testInfo) => {
  const phone = isPhoneProject(testInfo);
  const dex = await unownedSpecies(page.request);
  const binder = await binderWithTarget(page.request, dex);

  await page.goto(`/binders/${binder.binderId}?page=1&q=`);
  await press(page, phone, page.locator('[data-pocket="0:0:0"]'));
  await press(page, phone, page.getByRole('button', { name: 'Find cards' }));

  const panel = page.getByRole('dialog', { name: /^Find cards/ });
  await expect(panel).toBeVisible();
  await expect(panel.getByText('No spare copy fits this pocket.')).toBeVisible();
  const add = panel.getByRole('button', { name: /Add a copy and place/ });
  await expect(add.first()).toBeVisible();
  await press(page, phone, add.first());

  // Done means closed: the panel (and on a phone the pocket sheet) goes, and a toast
  // confirms.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page
      .locator('.toast-viewport .toast')
      .filter({ hasText: /Added a copy of .+ and placed it\./ }),
  ).toBeVisible();

  const window = await api.binderPage(page.request, binder.versionId, 0);
  const slot = window.pages[0]?.slots.find((item) => item.row === 0 && item.column === 0);
  // The target is untouched: still any printing of the same species, now filled.
  expect(slot?.entryKind).toBe('pokemon');
  expect(slot?.pokemonNumber).toBe(dex);
  const placedId = slot?.assignedCardId;
  if (!placedId) throw new Error('nothing was placed in the pocket');
  const card = await api.cardDetail(page.request, placedId);
  expect(card.collection?.quantity).toBe(1);
});
