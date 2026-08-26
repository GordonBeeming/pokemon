// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pagination } from './pagination';

describe('Pagination', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div');
    document.body.replaceChildren(container);
    root = createRoot(container);
  });

  afterEach(() => act(() => root.unmount()));

  it('hides for one page and labels the current page in a larger result', () => {
    act(() =>
      root.render(
        <Pagination
          page={0}
          totalPages={1}
          pending={false}
          label="Pages"
          onPage={() => undefined}
        />,
      ),
    );
    expect(container.textContent).toBe('');
    act(() =>
      root.render(
        <Pagination
          page={9}
          totalPages={20}
          pending={false}
          label="Pages"
          onPage={() => undefined}
        />,
      ),
    );
    expect(container.querySelector('nav')?.getAttribute('aria-label')).toBe('Pages');
    expect(container.querySelector('[aria-current="page"]')?.textContent).toBe('10');
    expect(container.textContent).toContain('…');
  });

  it('supports direct page jumps and ignores invalid page numbers', () => {
    const onPage = vi.fn();
    act(() =>
      root.render(
        <Pagination page={0} totalPages={20} pending={false} label="Pages" onPage={onPage} />,
      ),
    );
    const input = container.querySelector<HTMLInputElement>('input[type="number"]');
    const form = container.querySelector('form');
    act(() => {
      if (!input || !form) throw new Error('page jump missing');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '10');
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
      form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    });
    expect(onPage).toHaveBeenCalledWith(9);
    onPage.mockClear();
    act(() => {
      if (!input || !form) throw new Error('page jump missing');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '99');
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
      form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    });
    expect(onPage).not.toHaveBeenCalled();
  });
});
