import { createRoute } from '@tanstack/react-router';
import { AppShell } from '../shell/AppShell';
import { rootRoute } from './root';

// Pathless layout: every real screen (home, catalogue, pokedex, sets, binders,
// settings) sits under here so the session gate and shell chrome run once. The dev
// /_frames gallery is a sibling of this route, not a child, so it never touches auth.
export const authedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'authed',
  component: AppShell,
});
