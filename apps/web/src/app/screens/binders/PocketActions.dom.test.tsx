// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BinderSlotView } from '../../api/queries/binders';
import { PocketActions, pocketActionItems, type PocketActionKey } from './PocketActions';

async function step(action: () => unknown): Promise<void> {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await step(() => root.unmount());
  container.remove();
});

const handlers = (): Record<
  Exclude<PocketActionKey, 'ordered' | 'received' | 'rotate'>,
  () => void
> => ({
  view: vi.fn(),
  find: vi.fn(),
  move: vi.fn(),
  change: vi.fn(),
  insert: vi.fn(),
  reserve: vi.fn(),
  paste: vi.fn(),
  bookmark: vi.fn(),
  'move-card': vi.fn(),
  remove: vi.fn(),
});

function slot(overrides: Partial<BinderSlotView>): BinderSlotView {
  return {
    pageId: 'page_1',
    row: 0,
    column: 0,
    cardId: null,
    entryKind: 'empty',
    label: null,
    pokemonNumber: null,
    assignedCardId: null,
    startsNewPage: false,
    ...overrides,
  };
}

const exactTarget = slot({ entryKind: 'exact-card', cardId: 'card_1' });

describe('pocketActionItems', () => {
  it('offers Move card immediately before Remove only for a placed copy', () => {
    for (const entryKind of ['set', 'pokemon', 'exact-card'] as const) {
      const items = pocketActionItems({
        slot: slot({ entryKind, assignedCardId: 'physical-copy' }),
        editable: true,
        hasCard: true,
        hasClipboard: false,
        on: handlers(),
      });
      expect(items.slice(-2).map((item) => item.label)).toEqual(['Move card', 'Remove']);
    }
    for (const editable of [true, false]) {
      const items = pocketActionItems({
        slot: exactTarget,
        editable,
        hasCard: true,
        hasClipboard: false,
        on: handlers(),
      });
      expect(items.some((item) => item.key === 'move-card')).toBe(false);
    }
    const archived = pocketActionItems({
      slot: slot({ entryKind: 'pokemon', assignedCardId: 'physical-copy' }),
      editable: false,
      hasCard: true,
      hasClipboard: false,
      on: handlers(),
    });
    expect(archived.some((item) => item.key === 'move-card')).toBe(false);
  });
  it('offers every action for a filled target, in the board order', () => {
    const items = pocketActionItems({
      slot: exactTarget,
      editable: true,
      hasCard: true,
      hasClipboard: true,
      on: handlers(),
    });
    expect(items.map((item) => item.label)).toEqual([
      'View card',
      'Find cards',
      'Move',
      'Change target',
      'Insert / shift',
      'Paste here',
      'Bookmark',
      'Remove',
    ]);
    expect(items.map((item) => item.icon)).toEqual([
      'eye',
      'magnifier',
      'move',
      'swap',
      'insert',
      'paste',
      'bookmark',
      'bin',
    ]);
    expect(items.find((item) => item.key === 'move')?.shortcut).toBe('M');
    expect(items.find((item) => item.key === 'remove')?.tone).toBe('danger');
  });

  it('offers insert and reserve for an empty pocket, and paste only with a clipboard', () => {
    const withoutClipboard = pocketActionItems({
      slot: slot({}),
      editable: true,
      hasCard: false,
      hasClipboard: false,
      on: handlers(),
    });
    expect(withoutClipboard.map((item) => item.label)).toEqual([
      'Insert targets here',
      'Reserve sleeve',
      'Bookmark',
    ]);
  });

  it('says Unreserve for a reserved sleeve', () => {
    const items = pocketActionItems({
      slot: slot({ entryKind: 'reserved', label: 'Promos' }),
      editable: true,
      hasCard: false,
      hasClipboard: false,
      on: handlers(),
    });
    expect(items.map((item) => item.label)).toEqual([
      'Move',
      'Insert / shift',
      'Bookmark',
      'Unreserve',
    ]);
  });

  it('leaves only non-changing actions on an archived binder', () => {
    const items = pocketActionItems({
      slot: exactTarget,
      editable: false,
      hasCard: true,
      hasClipboard: true,
      on: handlers(),
    });
    expect(items.map((item) => item.label)).toEqual(['View card', 'Bookmark']);
  });
});

describe('PocketActions', () => {
  it('renders every action as an icon plus a visible label, with the move shortcut shown', async () => {
    const on = handlers();
    const items = pocketActionItems({
      slot: exactTarget,
      editable: true,
      hasCard: true,
      hasClipboard: true,
      on,
    });
    await step(() =>
      root.render(
        <PocketActions
          phone={false}
          items={items}
          onClose={vi.fn()}
          summary={{
            imageUrl: null,
            faded: true,
            title: '#0025 Pikachu',
            where: 'Page 1 · row 1, pocket 1',
            status: 'Nothing placed',
          }}
        />,
      ),
    );
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('.action-bar-item')];
    expect(buttons).toHaveLength(8);
    for (const button of buttons) {
      expect(button.querySelector('svg')).not.toBeNull();
      expect(button.querySelector('span')?.textContent?.trim()).not.toBe('');
    }
    const move = buttons.find((button) => button.textContent?.startsWith('Move'));
    expect(move?.querySelector('kbd')?.textContent).toBe('M');
    expect(container.textContent).toContain('#0025 Pikachu');
    expect(container.textContent).toContain('Page 1 · row 1, pocket 1 · Nothing placed');

    await step(() => move?.click());
    expect(on.move).toHaveBeenCalledTimes(1);
  });
});

it('offers received for an ordered target and ordered for a received target', () => {
  const on = { ...handlers(), ordered: vi.fn(), received: vi.fn() };
  const ordered = pocketActionItems({
    slot: slot({ entryKind: 'pokemon', pokemonNumber: 7, orderedCardId: 'card' }),
    editable: true,
    hasCard: true,
    hasClipboard: false,
    on,
  });
  expect(ordered.some((a) => a.key === 'received')).toBe(true);
  expect(ordered.some((a) => a.key === 'ordered')).toBe(false);
  const received = pocketActionItems({
    slot: slot({ entryKind: 'pokemon', pokemonNumber: 7, assignedCardId: 'card' }),
    editable: true,
    hasCard: true,
    hasClipboard: false,
    on,
  });
  expect(received.some((a) => a.key === 'ordered')).toBe(true);
  expect(received.some((a) => a.key === 'received')).toBe(false);
});

it.each([
  { entryKind: 'pokemon' as const, pokemonNumber: 7 },
  { entryKind: 'exact-card' as const, cardId: 'card' },
])('does not offer Mark ordered for an unfilled $entryKind target', (target) => {
  const items = pocketActionItems({
    slot: slot(target),
    editable: true,
    hasCard: target.entryKind === 'exact-card',
    hasClipboard: false,
    on: { ...handlers(), ordered: vi.fn(), received: vi.fn() },
  });
  expect(items.some((item) => item.key === 'ordered')).toBe(false);
  expect(items.some((item) => item.key === 'find')).toBe(true);
});

it('offers display rotation only for editable pockets with a printing', () => {
  const rotate = vi.fn();
  for (const [editable, hasCard, expected] of [
    [true, true, true],
    [false, true, false],
    [true, false, false],
  ] as const) {
    const items = pocketActionItems({
      slot: exactTarget,
      editable,
      hasCard,
      hasClipboard: false,
      on: { ...handlers(), rotate },
    });
    expect(items.some((i) => i.key === 'rotate')).toBe(expected);
  }
});
