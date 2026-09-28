import { createRoute } from '@tanstack/react-router';
import { Home } from '../screens/Home';
import { authedRoute } from './authed-layout';

export const indexRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/',
  component: Home,
});
