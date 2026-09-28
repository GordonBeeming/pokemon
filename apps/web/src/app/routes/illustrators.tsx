import { createRoute } from '@tanstack/react-router';
import { Illustrators } from '../screens/Illustrators';
import { authedRoute } from './authed-layout';
import { illustratorsSearch } from './search-params';

export const illustratorsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/illustrators',
  validateSearch: illustratorsSearch.parse,
  component: () => <Illustrators search={illustratorsRoute.useSearch()} />,
});
