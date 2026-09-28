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

async function renderTrack(
  peek: PeekColumns,
  edges: { edgeButtons?: 'beside' | 'overlay'; currentIndex?: number; onFlip?: () => void } = {},
): Promise<void> {
  await step(() =>
    root.render(
      <PageTrack
        edgeButtons={edges.edgeButtons}
        pages={[0, 1, 2].map((index) => ({ index, page: page(index) }))}
        currentIndex={edges.currentIndex ?? 1}
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
        onFlip={edges.onFlip ?? vi.fn()}
      />,
    ),
  );
}

describe('PageTrack peek', () => {
  it('shows no neighbouring columns at peek 0', async () => {
    await renderTrack(0);
    const neighbours = [...container.querySelectorAll('.binder-page-peek')];
    expect(neighbours).toHaveLength(2);
    for (const neighbour of neighbours) expect(neighbour.getAttribute('aria-hidden')).toBe('true');
    const viewport = container.querySelector<HTMLElement>('.page-track-viewport');
    expect(viewport?.style.width).toBe(`${trackGeometry(960, 3, 0).viewportWidth}px`);
  });

  it('shows neighbouring cards whole, with every corner rounded, at peek 1', async () => {
    await renderTrack(1);
    for (const neighbour of container.querySelectorAll('.binder-page-peek'))
      expect(neighbour.getAttribute('aria-hidden')).toBeNull();
    const peekFrames = container.querySelectorAll('.binder-page-peek .pocket-face .card-frame');
    expect(peekFrames.length).toBeGreaterThan(0);
    for (const frame of peekFrames) expect(frame.className).not.toMatch(/peek/u);
  });

  it('sizes every pocket from the same full-frame sizer, whatever it holds', async () => {
    await renderTrack(1);
    const pockets = [...container.querySelectorAll('[data-pocket]')];
    expect(pockets).toHaveLength(27);
    for (const pocket of pockets) {
      expect(pocket.querySelectorAll(':scope > .pocket-sizer .card-frame')).toHaveLength(1);
      expect(pocket.querySelectorAll(':scope > .pocket-face')).toHaveLength(1);
    }
  });

  it('shows two neighbouring columns at peek 2', async () => {
    await renderTrack(2);
    const one = trackGeometry(960, 3, 1);
    const two = trackGeometry(960, 3, 2);
    expect(two.offset).toBeGreaterThan(one.offset);
    expect(two.pocketWidth).toBeLessThan(one.pocketWidth);
  });
});

describe('PageTrack edge buttons', () => {
  function edge(label: string): HTMLButtonElement {
    const found = container.querySelector<HTMLButtonElement>(`.page-edge[aria-label="${label}"]`);
    if (!found) throw new Error(`${label} edge button missing`);
    return found;
  }

  it('sits beside the page, turns it both ways and leaves room for itself', async () => {
    const onFlip = vi.fn();
    await renderTrack(1, { edgeButtons: 'beside', onFlip });
    const viewport = container.querySelector('.page-track-viewport');
    expect(edge('Previous page').nextElementSibling).toBe(viewport);
    expect(edge('Next page').previousElementSibling).toBe(viewport);
    expect(container.querySelector<HTMLElement>('.page-track-viewport')?.style.width).toBe(
      `${trackGeometry(960 - 112, 3, 1).viewportWidth}px`,
    );
    await step(() => edge('Previous page').click());
    await step(() => edge('Next page').click());
    expect(onFlip.mock.calls).toEqual([[-1], [1]]);
  });

  it('is disabled at the first page and drawn over the page as an overlay', async () => {
    await renderTrack(1, { edgeButtons: 'overlay', currentIndex: 0 });
    const viewport = container.querySelector('.page-track-viewport');
    expect(edge('Previous page').parentElement).toBe(viewport);
    expect(edge('Previous page').disabled).toBe(true);
    expect(edge('Next page').disabled).toBe(false);
  });

  it('draws no edge buttons unless asked', async () => {
    await renderTrack(0);
    expect(container.querySelector('.page-edge')).toBeNull();
  });
});
