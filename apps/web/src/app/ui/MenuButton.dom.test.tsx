// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MenuButton, MenuItem } from './MenuButton';

let container: HTMLDivElement, root: Root;
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

function trigger(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('.menu-button-trigger');
  if (!button) throw new Error('expected the menu trigger');
  return button;
}

describe('MenuButton', () => {
  it('stays collapsed until the trigger is pressed, then focuses the first enabled item', async () => {
    await step(() =>
      root.render(
        <MenuButton label="Copy" menuLabel="Copy cards">
          {() => (
            <>
              <MenuItem label="Displayed order" disabled onSelect={vi.fn()} />
              <MenuItem label="This page" onSelect={vi.fn()} />
            </>
          )}
        </MenuButton>,
      ),
    );
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');

    await step(() => trigger().click());
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement?.textContent).toBe('This page');
  });

  it('hands `close` to its items and collapses on Escape, returning focus to the trigger', async () => {
    const onSelect = vi.fn();
    await step(() =>
      root.render(
        <MenuButton label="More" menuLabel="More actions">
          {(close) => (
            <MenuItem
              label="Add a card"
              onSelect={() => {
                close();
                onSelect();
              }}
            />
          )}
        </MenuButton>,
      ),
    );
    await step(() => trigger().click());
    const item = container.querySelector<HTMLButtonElement>('[role="menuitem"]');
    await step(() => item?.click());
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="menu"]')).toBeNull();

    await step(() => trigger().click());
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    await step(() => document.dispatchEvent(escape));
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('as a dialog popover, stays open while its controls change', async () => {
    const onChange = vi.fn();
    await step(() =>
      root.render(
        <MenuButton kind="dialog" label="Display" menuLabel="Display">
          {() => <input aria-label="Peek" onChange={onChange} />}
        </MenuButton>,
      ),
    );
    await step(() => trigger().click());
    expect(trigger().getAttribute('aria-haspopup')).toBe('dialog');
    const input = container.querySelector('input');
    expect(document.activeElement).toBe(input);
    await step(() => input?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });
});

async function step(action: () => unknown): Promise<void> {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}
