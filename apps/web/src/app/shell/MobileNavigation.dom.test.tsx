// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  Outlet,
} from '@tanstack/react-router';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { MobileNavigation } from './MobileNavigation';
import { NAV_ITEMS } from './nav-items';
vi.mock('./LogoutButton', () => ({ LogoutButton: () => <button type="button">Log out</button> }));
let container: HTMLDivElement;
let root: Root;
async function step(f: () => unknown) {
  await act(async () => {
    f();
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}
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
it('exposes every desktop destination on mobile, navigates and closes the menu', async () => {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <MobileNavigation />
        <Outlet />
      </>
    ),
  });
  const routes = NAV_ITEMS.map((item) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path: item.to,
      component: () => <h1>{item.label}</h1>,
    }),
  );
  const router = createRouter({
    routeTree: rootRoute.addChildren(routes),
    history: createMemoryHistory({ initialEntries: ['/wanted'] }),
  });
  await router.load();
  await step(() => root.render(<RouterProvider router={router} />));
  const more = container.querySelector<HTMLButtonElement>('[aria-label="More navigation"]');
  if (!more) throw Error('Missing More');
  expect(more.className).toContain('nav-item-active');
  await step(() => more.click());
  const links = [...document.querySelectorAll<HTMLAnchorElement>('.mobile-navigation a')];
  expect(links.map((a) => a.getAttribute('href'))).toEqual(NAV_ITEMS.map((item) => item.to));
  expect(document.querySelector('.mobile-navigation')?.textContent).toContain('Log out');
  const trainer = links.find((a) => a.getAttribute('href') === '/trainer-dex');
  if (!trainer) throw Error('Missing Trainer Dex');
  await step(() => trainer.click());
  expect(router.state.location.pathname).toBe('/trainer-dex');
  expect(document.querySelector('.mobile-navigation')).toBeNull();
  await step(() => more.click());
  await step(() =>
    document
      .querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="Close"]')
      ?.click(),
  );
  expect(document.querySelector('.mobile-navigation')).toBeNull();
});
