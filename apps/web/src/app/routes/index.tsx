import { createRoute, useNavigate } from '@tanstack/react-router';
import { Home } from '../screens/Home';
import { homeSearch } from '../screens/home/search';
import { authedRoute } from './authed-layout';

export const indexRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/',
  validateSearch: homeSearch.parse,
  component: function IndexRoute() {
    const search = indexRoute.useSearch();
    const navigate = useNavigate();
    return (
      <Home
        search={search}
        onOpenCard={(cardId) =>
          void navigate({ to: '/', search: (prev) => ({ ...prev, card: cardId }) })
        }
        onCloseCard={() =>
          void navigate({ to: '/', search: (prev) => ({ ...prev, card: undefined }) })
        }
      />
    );
  },
});
