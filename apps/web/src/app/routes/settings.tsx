import { createRoute } from '@tanstack/react-router';
import { Settings } from '../screens/Settings';
import { authedRoute } from './authed-layout';
import { settingsSearch } from './search-params';

export const settingsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/settings',
  validateSearch: settingsSearch.parse,
  component: () => <Settings search={settingsRoute.useSearch()} />,
});
