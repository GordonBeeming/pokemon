// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cardIdSchema, type BinderPastePreview } from '@pokedex/shared';
import { BinderPasteDialog } from './binder-paste-dialog';
const preview = vi.hoisted(() => vi.fn());
vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  api: { previewPaste: preview },
}));
const at = { page: 0, row: 0, column: 0 };
const report: BinderPastePreview = {
  revision: 1,
  count: 1,
  replacedTargets: 0,
  unassignedCopies: 0,
  shiftedTargets: 0,
  at,
  end: at,
  reservedPage: false,
};
let root: Root, container: HTMLDivElement;
const paste = vi.fn<() => Promise<boolean>>(),
  close = vi.fn();
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.replaceChildren(container);
  root = createRoot(container);
  preview.mockReset();
  paste.mockReset();
  close.mockReset();
});
afterEach(() => act(() => root.unmount()));
async function render() {
  await act(async () => {
    root.render(
      <BinderPasteDialog
        versionId="v"
        revision={1}
        at={at}
        clipboard={{
          version: 1,
          cards: [{ id: cardIdSchema.parse('a'), name: 'A', setName: 'Set', number: '1' }],
        }}
        onClose={close}
        onPaste={paste}
      />,
    );
    await Promise.resolve();
  });
}
function primary() {
  const button = container.querySelector<HTMLButtonElement>('.pocket-panel-footer button');
  if (!button) throw Error('Missing paste action');
  return button;
}
it('makes mode selection distinct from applying the paste', async () => {
  preview.mockResolvedValue(report);
  await render();
  expect(container.querySelector('legend')?.textContent).toBe('Paste method');
  expect(container.querySelector<HTMLInputElement>('input[value="replace"]')?.checked).toBe(true);
  expect(primary().textContent).toBe('Paste 1 card');
  await act(async () => {
    container.querySelector<HTMLInputElement>('input[value="insert"]')?.click();
    await Promise.resolve();
  });
  expect(preview).toHaveBeenCalledTimes(2);
  expect(paste).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Choosing a method only updates the preview');
});
it('shows preview progress and disables paste until it is ready', async () => {
  let finish: ((value: BinderPastePreview) => void) | undefined;
  preview.mockReturnValue(
    new Promise<BinderPastePreview>((resolve) => {
      finish = resolve;
    }),
  );
  await render();
  expect(primary().disabled).toBe(true);
  expect(container.querySelector('[role="status"]')?.textContent).toContain('Checking space');
  expect(container.querySelector('.paste-spinner')).not.toBeNull();
  await act(async () => {
    finish?.(report);
    await Promise.resolve();
  });
  expect(primary().disabled).toBe(false);
});
it('shows saving progress and prevents duplicate submissions and dismissal', async () => {
  preview.mockResolvedValue(report);
  let finish: ((value: boolean) => void) | undefined;
  paste.mockReturnValue(
    new Promise<boolean>((resolve) => {
      finish = resolve;
    }),
  );
  await render();
  await act(async () => {
    primary().click();
    primary().click();
    await Promise.resolve();
  });
  expect(paste).toHaveBeenCalledTimes(1);
  expect(primary().disabled).toBe(true);
  expect(primary().textContent).toBe('Pasting…');
  expect(container.textContent).toContain('Saving 1 card to the binder');
  expect(container.querySelector<HTMLFieldSetElement>('fieldset')?.disabled).toBe(true);
  expect(container.querySelector<HTMLButtonElement>('.pocket-panel-close')?.disabled).toBe(true);
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await Promise.resolve();
  });
  expect(close).not.toHaveBeenCalled();
  await act(async () => {
    finish?.(true);
    await Promise.resolve();
  });
  expect(close).toHaveBeenCalledTimes(1);
});
