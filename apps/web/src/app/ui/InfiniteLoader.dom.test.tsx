// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InfiniteLoader } from './InfiniteLoader';
let root: Root;
let container: HTMLDivElement;
const observers: Array<{
  fire: () => void;
  disconnect: () => void;
  options: IntersectionObserverInit;
}> = [];
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  observers.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      disconnect = vi.fn();
      constructor(
        callback: (entries: { isIntersecting: boolean }[]) => void,
        options: IntersectionObserverInit,
      ) {
        observers.push({
          fire: () => callback([{ isIntersecting: true }]),
          disconnect: this.disconnect,
          options,
        });
      }
      observe() {}
    },
  );
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it('loads automatically once, then rearms only after the next batch arrives', () => {
  const load = vi.fn();
  act(() =>
    root.render(<InfiniteLoader hasMore loading={false} loadedCount={48} onLoadMore={load} />),
  );
  const first = observers[0];
  if (!first) throw new Error('Missing observer');
  act(() => {
    first.fire();
    first.fire();
  });
  expect(load).toHaveBeenCalledTimes(1);
  act(() => root.render(<InfiniteLoader hasMore loading loadedCount={48} onLoadMore={load} />));
  expect(first.disconnect).toHaveBeenCalledOnce();
  act(() => first.fire());
  expect(load).toHaveBeenCalledTimes(1);
  act(() =>
    root.render(<InfiniteLoader hasMore loading={false} loadedCount={96} onLoadMore={load} />),
  );
  act(() => observers.at(-1)?.fire());
  expect(load).toHaveBeenCalledTimes(2);
});
it('uses the surrounding dialog scroll container and pauses while an inspector is open', () => {
  const load = vi.fn();
  function view(paused: boolean) {
    return (
      <div
        ref={(node) => {
          if (node)
            Object.defineProperties(node, {
              clientHeight: { configurable: true, value: 400 },
              scrollHeight: { configurable: true, value: 800 },
            });
        }}
        style={{ overflowY: 'auto', height: 400 }}
        data-scroll
      >
        <InfiniteLoader
          hasMore
          loading={false}
          paused={paused}
          loadedCount={48}
          onLoadMore={load}
        />
      </div>
    );
  }
  act(() => root.render(view(false)));
  expect(observers[0]?.options.root).toBe(container.querySelector('[data-scroll]'));
  act(() => root.render(view(true)));
  act(() => observers[0]?.fire());
  expect(load).not.toHaveBeenCalled();
  expect(container.querySelector('button')?.disabled).toBe(true);
  act(() => root.render(view(false)));
  act(() => observers.at(-1)?.fire());
  expect(load).toHaveBeenCalledOnce();
});
it('keeps an error paused until Retry and stops completely at the end', () => {
  const load = vi.fn();
  act(() =>
    root.render(
      <InfiniteLoader
        hasMore
        loading={false}
        error="Connection lost"
        loadedCount={48}
        onLoadMore={load}
      />,
    ),
  );
  expect(observers).toHaveLength(0);
  expect(container.querySelector('[role=alert]')?.textContent).toBe('Connection lost');
  act(() => container.querySelector('button')?.click());
  expect(load).toHaveBeenCalledOnce();
  act(() =>
    root.render(
      <InfiniteLoader hasMore={false} loading={false} loadedCount={48} onLoadMore={load} />,
    ),
  );
  expect(container.childElementCount).toBe(0);
});
it('does not mistake a horizontal overflow wrapper for the vertical list viewport', () => {
  const load = vi.fn();
  act(() =>
    root.render(
      <div
        ref={(node) => {
          if (node)
            Object.defineProperties(node, {
              clientHeight: { configurable: true, value: 800 },
              scrollHeight: { configurable: true, value: 800 },
            });
        }}
        style={{ overflowX: 'auto', overflowY: 'auto' }}
      >
        <InfiniteLoader hasMore loading={false} loadedCount={48} onLoadMore={load} />
      </div>,
    ),
  );
  expect(observers[0]?.options.root).toBeNull();
});
