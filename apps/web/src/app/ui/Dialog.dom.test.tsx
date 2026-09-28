// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from './Dialog';

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

describe('Dialog', () => {
  it('moves focus inside on open and returns it to the opener on close', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'Open';
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    await step(() =>
      root.render(
        <Dialog open onClose={vi.fn()} title="Delete binder">
          <button>Confirm</button>
        </Dialog>,
      ),
    );
    expect(document.activeElement?.textContent).toBe('Confirm');

    await step(() => root.render(<></>));
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('calls onClose on Escape and traps Tab focus between the first and last elements', async () => {
    const onClose = vi.fn();
    await step(() =>
      root.render(
        <Dialog open onClose={onClose} title="Delete binder">
          <button>First</button>
          <button>Last</button>
        </Dialog>,
      ),
    );
    const [first, last] = Array.from(container.querySelectorAll('button'));
    if (!first || !last) throw new Error('expected two buttons inside the dialog');
    last.focus();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    await step(() => document.dispatchEvent(tab));
    expect(document.activeElement).toBe(first);

    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    await step(() => document.dispatchEvent(escape));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when closed', async () => {
    await step(() =>
      root.render(
        <Dialog open={false} onClose={vi.fn()} title="Delete binder">
          content
        </Dialog>,
      ),
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});

async function step(action: () => unknown): Promise<void> {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}
