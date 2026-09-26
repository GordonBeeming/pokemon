// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NavigationLink } from './navigation-link';
import { Shell, routes } from './ui';
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
describe('browser-native navigation links', () => {
  it('gives every primary navigation item a real destination and current-page state', async () => {
    const navigate = vi.fn();
    await step(() =>
      root.render(
        <Shell route="catalogue" navigate={navigate} notice={null}>
          <p>Content</p>
        </Shell>,
      ),
    );
    const links = container.querySelectorAll('nav a');
    expect(links.length).toBe(routes.length);
    routes.forEach(([route, label], index) => {
      expect(links[index]?.getAttribute('href')).toBe(`#${route}`);
      expect(links[index]?.textContent).toBe(label);
    });
    expect(container.querySelector('[aria-current="page"]')?.getAttribute('href')).toBe(
      '#catalogue',
    );
    expect(container.querySelector('.brand')?.getAttribute('href')).toBe('#dashboard');
  });
  it.each([
    { button: 1 },
    { button: 0, metaKey: true },
    { button: 0, ctrlKey: true },
    { button: 0, shiftKey: true },
    { button: 0, altKey: true },
  ])('leaves modified clicks to the browser: %j', async (options) => {
    const navigate = vi.fn();
    await step(() =>
      root.render(
        <NavigationLink href="#species" onNavigate={navigate}>
          National Pokédex
        </NavigationLink>,
      ),
    );
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, ...options });
    await step(() => container.querySelector('a')?.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });
  it('handles ordinary and keyboard-generated clicks locally exactly once', async () => {
    const navigate = vi.fn();
    await step(() =>
      root.render(
        <NavigationLink href="#species" onNavigate={navigate}>
          National Pokédex
        </NavigationLink>,
      ),
    );
    const event = new MouseEvent('click', {
      button: 0,
      bubbles: true,
      cancelable: true,
      detail: 0,
    });
    await step(() => container.querySelector('a')?.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});

async function step(action: () => unknown): Promise<void> {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}
