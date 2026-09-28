import { createRoute } from '@tanstack/react-router';
import { Sets } from '../screens/Sets';
import { authedRoute } from './authed-layout';
import { setsSearch } from './search-params';

export const setsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/sets',
  validateSearch: setsSearch.parse,
  component: () => <Sets search={setsRoute.useSearch()} />,
});
