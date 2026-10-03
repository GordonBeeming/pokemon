import { createRoute } from '@tanstack/react-router';
import { Trainers } from '../screens/Trainers';
import { authedRoute } from './authed-layout';
import { trainersSearch } from './search-params';

export const trainersRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/trainers',
  validateSearch: trainersSearch.parse,
  component: () => <Trainers search={trainersRoute.useSearch()} />,
});
