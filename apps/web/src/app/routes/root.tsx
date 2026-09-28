import { createRootRoute, Outlet } from '@tanstack/react-router';
import { RouteLiveRegionProvider, ToastProvider } from '../ui/Toast';

export const rootRoute = createRootRoute({
  component: () => (
    <ToastProvider>
      <RouteLiveRegionProvider>
        <Outlet />
      </RouteLiveRegionProvider>
    </ToastProvider>
  ),
});
