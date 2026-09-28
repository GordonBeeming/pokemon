import { createRoute } from '@tanstack/react-router';
import { BinderDetail } from '../screens/BinderDetail';
import { Binders } from '../screens/Binders';
import { authedRoute } from './authed-layout';
import { binderSearch } from './search-params';

export const bindersRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/binders',
  component: Binders,
});

export const binderDetailRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/binders/$binderId',
  validateSearch: binderSearch.parse,
  component: () => {
    const { binderId } = binderDetailRoute.useParams();
    return <BinderDetail binderId={binderId} search={binderDetailRoute.useSearch()} />;
  },
});
