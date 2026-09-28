// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';
import { Dialog } from './Dialog';
import { useOverlayAction } from './overlay';
import { Sheet } from './Sheet';
import { ToastProvider, useToast } from './Toast';

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

function dialog(): HTMLElement | null {
  return document.querySelector('[role="dialog"]');
}
function button(name: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll('button')).find(
    (item) => item.textContent === name || item.getAttribute('aria-label') === name,
  );
  if (!match) throw new Error(`no button named ${name}`);
  return match;
}

describe('Dialog', () => {
  it('moves focus inside on open and returns it to the opener on close', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'Open';
    document.body.appendChild(opener);
    opener.focus();

    await step(() =>
      root.render(
        <ToastProvider>
          <Dialog open onClose={vi.fn()} title="Delete binder">
            <button>Confirm</button>
          </Dialog>
        </ToastProvider>,
      ),
    );
    expect(dialog()?.contains(document.activeElement)).toBe(true);

    await step(() => root.render(<ToastProvider>{null}</ToastProvider>));
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('closes on Escape and on its visible close control', async () => {
    const onClose = vi.fn();
    await step(() =>
      root.render(
        <ToastProvider>
          <Dialog open onClose={onClose} title="Delete binder">
            <button>First</button>
          </Dialog>
        </ToastProvider>,
      ),
    );
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    await step(() => (document.activeElement ?? document.body).dispatchEvent(escape));
    expect(onClose).toHaveBeenCalledTimes(1);

    await step(() => button('Close').click());
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('renders nothing when closed', async () => {
    await step(() =>
      root.render(
        <ToastProvider>
          <Dialog open={false} onClose={vi.fn()} title="Delete binder">
            content
          </Dialog>
        </ToastProvider>,
      ),
    );
    expect(dialog()).toBeNull();
  });
});

function SaveAction({ action }: { action: () => Promise<unknown> }) {
  const { run } = useOverlayAction();
  return (
    <button type="button" onClick={() => void run(action, { success: 'Saved it.' })}>
      Save
    </button>
  );
}

function Harness({ action }: { action: () => Promise<unknown> }) {
  const [open, setOpen] = useState(true);
  return (
    <Sheet open={open} onClose={() => setOpen(false)} title="Edit">
      <SaveAction action={action} />
    </Sheet>
  );
}

describe('overlay actions', () => {
  it('done means closed: success closes the surface, then confirms with a toast on the page', async () => {
    await step(() =>
      root.render(
        <ToastProvider>
          <Harness action={() => Promise.resolve()} />
        </ToastProvider>,
      ),
    );
    await step(() => button('Save').click());
    expect(dialog()).toBeNull();
    const toast = document.querySelector('.toast-viewport .toast');
    expect(toast?.textContent).toContain('Saved it.');
  });

  it('failure keeps you in place: the error shows inside the surface, which stays open', async () => {
    await step(() =>
      root.render(
        <ToastProvider>
          <Harness action={() => Promise.reject(new Error('The binder changed.'))} />
        </ToastProvider>,
      ),
    );
    await step(() => button('Save').click());
    expect(dialog()).not.toBeNull();
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe('The binder changed.');
    expect(document.querySelector('.toast-viewport .toast')).toBeNull();
  });

  it('a confirm dialog closes itself when its promise resolves and keeps a failure inside', async () => {
    function Confirm({ onConfirm }: { onConfirm: () => Promise<unknown> }) {
      const [open, setOpen] = useState(true);
      return (
        <ConfirmDialog
          open={open}
          title="Revoke token"
          confirmLabel="Revoke"
          onCancel={() => setOpen(false)}
          onConfirm={onConfirm}
          success="Revoked."
        />
      );
    }
    await step(() =>
      root.render(
        <ToastProvider>
          <Confirm onConfirm={() => Promise.reject(new Error('Try again.'))} />
        </ToastProvider>,
      ),
    );
    await step(() => button('Revoke').click());
    expect(dialog()?.textContent).toContain('Try again.');

    await step(() =>
      root.render(
        <ToastProvider>
          <Confirm key="ok" onConfirm={() => Promise.resolve()} />
        </ToastProvider>,
      ),
    );
    await step(() => button('Revoke').click());
    expect(dialog()).toBeNull();
    expect(document.body.textContent).toContain('Revoked.');
  });
});

describe('one layer at a time', () => {
  it('a toast raised under a surface that fills the screen shows inside it, not over it', async () => {
    function Raise() {
      const toast = useToast();
      return (
        <button type="button" onClick={() => toast('success', 'Notes saved.')}>
          Raise
        </button>
      );
    }
    await step(() =>
      root.render(
        <ToastProvider>
          <Dialog open onClose={vi.fn()} title="Card">
            <Raise />
          </Dialog>
        </ToastProvider>,
      ),
    );
    await step(() => button('Raise').click());
    // happy-dom lays nothing out, so the surface starts at the top edge with no room
    // above or beside it: the toast goes in the surface's own flow.
    expect(document.querySelector('.toast-viewport')).toBeNull();
    expect(dialog()?.querySelector('.toast-inline')?.textContent).toContain('Notes saved.');
  });
});

async function step(action: () => unknown): Promise<void> {
  await act(async () => {
    await action();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
