// @vitest-environment happy-dom
import { act, type ReactNode } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders, flush } from '../test-harness';
import { MovePagePanel } from './PagePanels';
import { MoveCardPanel } from './PocketPanels';

let container: HTMLDivElement;
let root: Root | undefined;
async function step(action: () => unknown) {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}
function button(text: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll('button')).find(
    (el) => el.textContent?.trim() === text,
  );
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}
async function render(node: ReactNode) {
  const result = await renderWithProviders(container, () => node);
  root = result.root;
  await flush();
}
async function count(value: string) {
  const input = document.querySelector<HTMLInputElement>('input[type="number"]');
  if (!input) throw new Error('Missing page-count field');
  await step(() => {
    Reflect.set(HTMLInputElement.prototype, 'value', value, input);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(async () => {
  await step(() => root?.unmount());
  root = undefined;
  container.remove();
});

describe('Move card confirmation', () => {
  it('states the preserved target and waits for confirmation', async () => {
    const onMove = vi.fn().mockResolvedValue(true);
    const onClose = vi.fn();
    await render(
      <MoveCardPanel
        target="Any card · 30th Celebration"
        pending={false}
        error={null}
        onMove={onMove}
        onClose={onClose}
      />,
    );
    expect(document.body.textContent).toContain('Are you sure you want to move this card?');
    expect(document.body.textContent).toContain('without removing your owned copy');
    expect(document.body.textContent).toContain('Any card · 30th Celebration');
    expect(onMove).not.toHaveBeenCalled();
    await step(() => button('Cancel').click());
    expect(onClose).toHaveBeenCalledOnce();
    expect(onMove).not.toHaveBeenCalled();
    await step(() => button('Move card').click());
    expect(onMove).toHaveBeenCalledOnce();
  });

  it('displays errors and disables pending writes', async () => {
    const onMove = vi.fn();
    await render(
      <MoveCardPanel
        target="#025 Pikachu (any printing)"
        pending
        error="The binder changed. Reload and try again."
        onMove={onMove}
        onClose={vi.fn()}
      />,
    );
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Reload and try again');
    expect(button('Moving…').disabled).toBe(true);
    await step(() => button('Moving…').click());
    expect(onMove).not.toHaveBeenCalled();
  });
});

describe('relative page movement', () => {
  it('disables direction changes while a page is moving', async () => {
    await render(
      <MovePagePanel
        pageIndex={2}
        pageCount={6}
        lastPagePartial={false}
        pending
        error={null}
        onMove={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const radios = [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios).toHaveLength(2);
    expect(radios.every((input) => input.disabled)).toBe(true);
    expect(button('Moving…').disabled).toBe(true);
  });
  it.each(['left', 'right'] as const)('moves a whole page two pages %s', async (direction) => {
    const onMove = vi.fn().mockResolvedValue(false);
    await render(
      <MovePagePanel
        pageIndex={2}
        pageCount={6}
        lastPagePartial={false}
        pending={false}
        error={null}
        onMove={onMove}
        onClose={vi.fn()}
      />,
    );
    const radio = document.querySelector<HTMLInputElement>(
      `input[type="radio"][value="${direction}"]`,
    );
    if (!radio) throw new Error('Missing direction choice');
    await step(() => radio.click());
    await count('2');
    expect(document.body.textContent).toContain(`will move 2 pages ${direction}`);
    await step(() => button('Move page').click());
    expect(onMove).toHaveBeenCalledWith(direction === 'left' ? 0 : 4);
  });

  it.each(['0', '-1', '1.5', '5', ''])('rejects an invalid distance of %s', async (value) => {
    const onMove = vi.fn();
    await render(
      <MovePagePanel
        pageIndex={2}
        pageCount={6}
        lastPagePartial={false}
        pending={false}
        error={null}
        onMove={onMove}
        onClose={vi.fn()}
      />,
    );
    await count(value);
    expect(button('Move page').disabled).toBe(true);
    await step(() => button('Move page').click());
    expect(onMove).not.toHaveBeenCalled();
  });

  it('keeps the partial last page at the end of the binder', async () => {
    await render(
      <MovePagePanel
        pageIndex={2}
        pageCount={3}
        lastPagePartial
        pending={false}
        error={null}
        onMove={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(document.body.textContent).toContain('has to stay last');
    expect(document.querySelector('input[type="number"]')).toBeNull();
  });

  it('does not move a full page into the partial final position', async () => {
    const onMove = vi.fn();
    await render(
      <MovePagePanel
        pageIndex={0}
        pageCount={4}
        lastPagePartial
        pending={false}
        error={null}
        onMove={onMove}
        onClose={vi.fn()}
      />,
    );
    await count('3');
    expect(document.body.textContent).toContain('up to 2 pages right');
    expect(button('Move page').disabled).toBe(true);
    await step(() => button('Move page').click());
    expect(onMove).not.toHaveBeenCalled();
  });
});
