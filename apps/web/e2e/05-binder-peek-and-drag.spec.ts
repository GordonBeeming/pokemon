import type { APIRequestContext, Locator, Page } from '@playwright/test';
import * as api from './support/api';
import { expect, test } from './support/fixtures';
import { ensureDisplayPanelOpen, chooseSegment } from './support/nav';
import { activeVersionId, findMissingCard, placeLooseCopy } from './support/scenarios';

interface SlotFacts {
  row: number;
  column: number;
  entryKind: string | undefined;
  cardId: string | null | undefined;
  assignedCardId: string | null | undefined;
}

function isEmpty(slot: SlotFacts): boolean {
  return !slot.assignedCardId && (!slot.entryKind || slot.entryKind === 'empty');
}

// "Collections" is a small (3x3, 360-pocket) binder that's mostly untouched in the
// real seed data — plenty of genuinely empty pockets to drop onto, unlike the
// 1,380-slot National Pokedex binder, where almost every slot is an unfilled
// species *target* (not empty) and loading is far slower.
async function collectionsBinderId(request: APIRequestContext): Promise<string> {
  const binders = await api.listBinders(request);
  const binder = binders.find((item) => item.name === 'Collections') ?? binders[0];
  if (!binder) throw new Error('No binders exist in this database copy.');
  return binder.id;
}

/** Places a fresh loose copy, then returns its placement plus a genuinely empty
 * pocket within the next few pages (fixture data in "Collections" starts with
 * zero pre-existing placements — every placed pocket here is one this suite just
 * made). Retries with a different card a few times: which page a placement lands
 * on (and so whether a same-page empty pocket exists) depends on how many other
 * fixtures earlier tests in the same run have already placed, so one attempt
 * isn't always enough when the whole suite runs together. */
async function placedAndNearbyEmpty(
  request: APIRequestContext,
  binderId: string,
  options: {
    /** Search starts here — pass `placement.page + 1` to force the empty pocket
     * onto a different page than the placed one (for the cross-page drag test). */
    searchFromOffset?: 0 | 1;
    /** Restrict the match to one column — with peek=1, only column 0 of the next
     * page is actually revealed (see trackGeometry's peekFraction), so the drag
     * test needs its drop target there specifically. */
    column?: number;
    /** Only accept a match on this exact page offset from the placement (0 = same
     * page, 1 = the very next page). Retries with a fresh card when unmet. */
    requireOffset?: number;
  } = {},
): Promise<{
  versionId: string;
  placedAt: { page: number; row: number; column: number };
  emptyAt: { page: number; row: number; column: number };
}> {
  const versionId = await activeVersionId(request, binderId);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const card = await findMissingCard(request);
    await api.incrementCollection(request, card.id, 1);
    const placement = await placeLooseCopy(request, card.id);
    if (placement.binderId !== binderId)
      throw new Error(
        `Expected the fixture card to land in ${binderId}, landed in ${placement.binderId}.`,
      );
    const searchFrom = placement.page + (options.searchFromOffset ?? 0);
    for (let pageIndex = searchFrom; pageIndex < searchFrom + 10; pageIndex += 1) {
      if (options.requireOffset !== undefined && pageIndex - placement.page > options.requireOffset)
        break;
      const pageWindow = await api.binderPage(request, versionId, pageIndex);
      const slots = pageWindow.pages[0]?.slots ?? [];
      const empty = slots.find(
        (slot) =>
          isEmpty(slot) &&
          (options.column === undefined || slot.column === options.column) &&
          !(
            pageIndex === placement.page &&
            slot.row === placement.row &&
            slot.column === placement.column
          ),
      );
      if (empty)
        return {
          versionId,
          placedAt: { page: placement.page, row: placement.row, column: placement.column },
          emptyAt: { page: pageIndex, row: empty.row, column: empty.column },
        };
    }
  }
  throw new Error('Could not find a matching empty pocket near a placed card after 5 attempts.');
}

async function pocketDrag(page: Page, source: Locator, target: Locator): Promise<void> {
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error('Could not measure the pockets to drag between.');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  // Playwright interpolates real intermediate mousemove events along the path
  // itself (steps: 20) — smoother and much closer to a physical drag than
  // hand-rolled teleport jumps, which this app's own pointermove-based hit-test
  // (elementFromPoint at each move) turned out to be sensitive to.
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 20 });
  await page.mouse.up();
}

test('peek columns 0/1/2 control whether a neighbouring page is exposed', async ({ page }) => {
  const binderId = await collectionsBinderId(page.request);
  await page.goto(`/binders/${binderId}?page=1&q=`);
  await expect(page.locator('.binder-view')).toBeVisible();

  const neighbour = page.locator('[aria-label="Page 2, neighbouring"]');
  const display = page.locator('.binder-display');
  await ensureDisplayPanelOpen(page);
  // SegmentedControl renders an ARIA radio group, not plain buttons.
  await chooseSegment(display, 'None');
  await expect(neighbour).toHaveAttribute('aria-hidden', 'true');

  await chooseSegment(display, '1 column');
  await expect(neighbour).not.toHaveAttribute('aria-hidden', 'true');

  await chooseSegment(display, '2 columns');
  await expect(neighbour).not.toHaveAttribute('aria-hidden', 'true');
});

// Not run — see the report's "Skipped" section. A mouse-based drag onto another
// pocket (same page or, per FEATURES.md, across the peek edge) reliably arms
// (the "Drop on a pocket to move" ghost appears) but the drop's own hit-test
// intermittently resolves to nothing: the browser tab stops responding to further
// CDP commands for the rest of the test's timeout budget mid-drag, on some runs,
// and on others the drop silently no-ops (no request, no status text, no state
// change) even though the target pocket's own boundingBox() and visibility both
// checked out immediately beforehand. Tried: teleporting between a handful of
// manual waypoints, Playwright's own steps-interpolated single move, and shorter
// vs. longer paths — all three shapes reproduced one or the other symptom on
// different runs against identical fixture data, which points at something
// timing-sensitive in the page's own pointermove/elementFromPoint handling
// (PageTrack.tsx) rather than a mistake in one particular drag shape. Left as
// `test.fixme()` rather than `test.fail()` because it isn't a clean, repeatable
// repro of one specific wrong behaviour — it's inconsistent in a way this
// workstream's "don't fix app code, don't guess" rule says to flag, not chase
// further. The keyboard-move test below exercises the same underlying
// revision-checked swap end to end (arm, choose a destination, commit, verify via
// the API) without going through native mouse events.
test.fixme('dragging a card between two pockets on the same page moves it', async ({ page }) => {
  const binderId = await collectionsBinderId(page.request);
  const { versionId, placedAt, emptyAt } = await placedAndNearbyEmpty(page.request, binderId, {
    requireOffset: 0,
  });

  await page.goto(`/binders/${binderId}?page=${placedAt.page + 1}&q=`);
  const sourceLocator = page.locator(
    `[data-pocket="${placedAt.page}:${placedAt.row}:${placedAt.column}"]`,
  );
  const targetLocator = page.locator(
    `[data-pocket="${emptyAt.page}:${emptyAt.row}:${emptyAt.column}"]`,
  );
  await expect(sourceLocator).toBeVisible();
  await expect(targetLocator).toBeVisible();
  await pocketDrag(page, sourceLocator, targetLocator);

  await expect(page.locator('p.sr-only[role="status"]')).toHaveText(/^Moved to page \d+/);
  const after = await api.binderPage(page.request, versionId, placedAt.page);
  const targetSlotAfter = after.pages[0]?.slots.find(
    (slot) => slot.row === emptyAt.row && slot.column === emptyAt.column,
  );
  expect(targetSlotAfter?.assignedCardId).toBeTruthy();
});

test('keyboard move: m, arrow keys, Enter', async ({ page }) => {
  // On a phone a tapped pocket opens its modal action sheet, which holds focus; the
  // phone's Move is the sheet's button (covered in 14-mobile-interactions).
  test.skip(test.info().project.name !== 'desktop', 'a hardware-keyboard flow');
  const binderId = await collectionsBinderId(page.request);
  const { versionId, placedAt, emptyAt } = await placedAndNearbyEmpty(page.request, binderId, {
    requireOffset: 0,
  });

  await page.goto(`/binders/${binderId}?page=${placedAt.page + 1}&q=`);
  const sourceLocator = page.locator(
    `[data-pocket="${placedAt.page}:${placedAt.row}:${placedAt.column}"]`,
  );
  await sourceLocator.click();
  await expect(sourceLocator).toHaveAttribute('aria-pressed', 'true');
  await sourceLocator.press('m');
  await expect(page.locator('.binder-banner-accent')).toContainText('Moving', { timeout: 5_000 });

  // Arrow to the empty pocket one step at a time (moveCursorBy clamps to the
  // current page's grid, so this only ever needs to move within it).
  const dRow = emptyAt.row - placedAt.row;
  const dCol = emptyAt.column - placedAt.column;
  for (let i = 0; i < Math.abs(dRow); i += 1)
    await sourceLocator.press(dRow > 0 ? 'ArrowDown' : 'ArrowUp');
  for (let i = 0; i < Math.abs(dCol); i += 1)
    await sourceLocator.press(dCol > 0 ? 'ArrowRight' : 'ArrowLeft');
  await sourceLocator.press('Enter');

  await expect(page.locator('p.sr-only[role="status"]')).toHaveText(
    new RegExp(`^Moved to page ${placedAt.page + 1}`),
  );
  const after = await api.binderPage(page.request, versionId, placedAt.page);
  const targetSlotAfter = after.pages[0]?.slots.find(
    (slot) => slot.row === emptyAt.row && slot.column === emptyAt.column,
  );
  const sourceSlotAfter = after.pages[0]?.slots.find(
    (slot) => slot.row === placedAt.row && slot.column === placedAt.column,
  );
  expect(targetSlotAfter?.assignedCardId).toBeTruthy();
  expect(sourceSlotAfter?.assignedCardId ?? null).toBeNull();
});
