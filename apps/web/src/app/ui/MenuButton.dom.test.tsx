// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MenuButton, MenuItem } from './MenuButton';
import { useOverlayAction } from './overlay';
import { ToastProvider } from './Toast';

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
function item(label: string): HTMLElement {
  const match = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
    (element) => element.textContent?.startsWith(label),
  );
  if (!match) throw new Error(`no menu item ${label}`);
  return match;
}

describe('MenuButton', () => {
  it('stays collapsed until the trigger is pressed, then shows its items', async () => {
    await step(() =>
      root.render(
        <ToastProvider>
          <MenuButton label="Copy" menuLabel="Copy cards">
            {() => (
              <>
                <MenuItem label="Displayed order" disabled onSelect={vi.fn()} />
                <MenuItem label="This page" onSelect={vi.fn()} />
              </>
            )}
          </MenuButton>
        </ToastProvider>,
      ),
    );
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');

    await step(() => trigger().click());
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    const labelledBy = document.querySelector('[role="menu"]')?.getAttribute('aria-labelledby');
    expect(labelledBy ? document.getElementById(labelledBy)?.textContent : null).toBe('Copy cards');
    expect(item('Displayed order').getAttribute('aria-disabled')).toBe('true');
  });

  it('closes when an item is chosen and on Escape, returning focus to the trigger', async () => {
    const onSelect = vi.fn();
    await step(() =>
      root.render(
        <ToastProvider>
          <MenuButton label="More" menuLabel="More actions">
            {() => <MenuItem label="Add a card" onSelect={onSelect} />}
          </MenuButton>
        </ToastProvider>,
      ),
    );
    await step(() => trigger().click());
    await step(() => item('Add a card').click());
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="menu"]')).toBeNull();

    await step(() => trigger().click());
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    await step(() => (document.activeElement ?? document.body).dispatchEvent(escape));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('keeps a working item open until its action finishes, then closes; a failure stays inside', async () => {
    let finish: (value: unknown) => void = () => undefined;
    let fail: (cause: Error) => void = () => undefined;
    function Items({ outcome }: { outcome: 'ok' | 'fail' }) {
      const action = useOverlayAction();
      return (
        <MenuItem
          label="Copy all"
          closeOnSelect={false}
          onSelect={() =>
            void action.run(
              () =>
                new Promise((resolve, reject) => {
                  finish = resolve;
                  fail = reject;
                }),
              { success: outcome === 'ok' ? 'Copied.' : undefined },
            )
          }
        />
      );
    }
    await step(() =>
      root.render(
        <ToastProvider>
          <MenuButton label="Copy" menuLabel="Copy cards">
            {() => <Items outcome="ok" />}
          </MenuButton>
        </ToastProvider>,
      ),
    );
    await step(() => trigger().click());
    await step(() => item('Copy all').click());
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    await step(() => finish(3));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.body.textContent).toContain('Copied.');

    await step(() => trigger().click());
    await step(() => item('Copy all').click());
    await step(() => fail(new Error('The results changed while copying.')));
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    expect(document.querySelector('.menu-popover [role="alert"]')?.textContent).toBe(
      'The results changed while copying.',
    );
  });

  it('as a dialog popover, stays open while its controls change', async () => {
    const onChange = vi.fn();
    await step(() =>
      root.render(
        <ToastProvider>
          <MenuButton kind="dialog" label="Display" menuLabel="Display">
            {() => <input aria-label="Peek" onChange={onChange} />}
          </MenuButton>
        </ToastProvider>,
      ),
    );
    await step(() => trigger().click());
    const input = document.querySelector('input');
    await step(() => input?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });
});

async function step(action: () => unknown): Promise<void> {
  await act(async () => {
    action();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
