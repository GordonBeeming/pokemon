// @vitest-environment happy-dom
import { DEFAULT_FRAME_PALETTE, type PeekColumns } from '@pokedex/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BinderPageView } from '../../api/queries/binders';
import { trackGeometry } from './model';
import { PageTrack } from './PageTrack';

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

function page(index: number): BinderPageView {
  return {
    id: `page_${index}`,
    position: index,
    kind: 'slots',
    label: null,
    slots: Array.from({ length: 9 }, (_unused, cell) => ({
      pageId: `page_${index}`,
      row: Math.floor(cell / 3),
      column: cell % 3,
      cardId: null,
      entryKind: 'pokemon' as const,
      label: null,
      pokemonNumber: index * 9 + cell + 1,
      assignedCardId: null,
      startsNewPage: false,
    })),
  };
}

async function renderTrack(peek: PeekColumns): Promise<void> {
  await step(() =>
    root.render(
      <PageTrack
        pages={[0, 1, 2].map((index) => ({ index, page: page(index) }))}
        currentIndex={1}
        pageCount={3}
        rows={3}
        columns={3}
        peek={peek}
        showFrame
        cards={new Map()}
        palette={DEFAULT_FRAME_PALETTE}
        selected={null}
        moveSource={null}
        moveCursor={null}
        inactive={new Set()}
        editable
        reducedMotion
        onPocketClick={vi.fn()}
        onPocketKeyDown={vi.fn()}
        onDrop={vi.fn()}
        onFlip={vi.fn()}
      />,
    ),
  );
}

function peekEdges(): { left: string[]; right: string[] } {
  const collect = (className: string) =>
    [...container.querySelectorAll(`.${className}`)].map(
      (frame) => frame.closest('[data-pocket]')?.getAttribute('data-pocket') ?? '',
    );
  return { left: collect('card-frame-peek-left'), right: collect('card-frame-peek-right') };
}

describe('PageTrack peek', () => {
  it('shows no neighbouring columns at peek 0', async () => {
    await renderTrack(0);
    const neighbours = [...container.querySelectorAll('.binder-page-peek')];
    expect(neighbours).toHaveLength(2);
    for (const neighbour of neighbours) expect(neighbour.getAttribute('aria-hidden')).toBe('true');
    expect(peekEdges()).toEqual({ left: [], right: [] });
    const viewport = container.querySelector<HTMLElement>('.page-track-viewport');
    expect(viewport?.style.width).toBe(`${trackGeometry(960, 3, 0).viewportWidth}px`);
  });

  it('cuts the nearest column of each neighbour flat at peek 1', async () => {
    await renderTrack(1);
    // Previous page: its last column shows at the left edge; next page: its first column at the right.
    expect(peekEdges()).toEqual({
      left: ['0:0:2', '0:1:2', '0:2:2'],
      right: ['2:0:0', '2:1:0', '2:2:0'],
    });
    for (const neighbour of container.querySelectorAll('.binder-page-peek'))
      expect(neighbour.getAttribute('aria-hidden')).toBeNull();
  });

  it('shows two columns and cuts only the outermost at peek 2', async () => {
    await renderTrack(2);
    expect(peekEdges()).toEqual({
      left: ['0:0:1', '0:1:1', '0:2:1'],
      right: ['2:0:1', '2:1:1', '2:2:1'],
    });
    const one = trackGeometry(960, 3, 1);
    const two = trackGeometry(960, 3, 2);
    expect(two.offset).toBeGreaterThan(one.offset);
    expect(two.pocketWidth).toBeLessThan(one.pocketWidth);
  });
});
