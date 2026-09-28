import { createRoute } from '@tanstack/react-router';
import { Catalogue } from '../screens/Catalogue';
import { authedRoute } from './authed-layout';
import { catalogueSearch } from './search-params';

export const catalogueRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/catalogue',
  validateSearch: catalogueSearch.parse,
  component: () => <Catalogue search={catalogueRoute.useSearch()} />,
});
