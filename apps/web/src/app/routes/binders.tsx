import { createRoute, useNavigate } from '@tanstack/react-router';
import { useCallback } from 'react';
import { BinderDetail } from '../screens/BinderDetail';
import { Binders } from '../screens/Binders';
import { authedRoute } from './authed-layout';
import { binderSearch, catalogueSearch, type BinderSearch } from './search-params';

export const bindersRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/binders',
  component: function BindersRoute() {
    const navigate = useNavigate();
    return (
      <Binders
        onOpenBinder={(binderId) =>
          void navigate({
            to: '/binders/$binderId',
            params: { binderId },
            search: { page: 1, q: '' },
          })
        }
      />
    );
  },
});

export const binderDetailRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/binders/$binderId',
  validateSearch: binderSearch.parse,
  component: function BinderDetailRoute() {
    const { binderId } = binderDetailRoute.useParams();
    const search = binderDetailRoute.useSearch();
    const navigate = useNavigate();
    const onSearch = useCallback(
      (next: BinderSearch, options: { replace: boolean }) =>
        void navigate({
          to: '/binders/$binderId',
          params: { binderId },
          search: next,
          replace: options.replace,
        }),
      [navigate, binderId],
    );
    return (
      <BinderDetail
        binderId={binderId}
        search={search}
        onSearch={onSearch}
        onOpenLibrary={() => void navigate({ to: '/binders' })}
        onFindCards={(query) =>
          void navigate({ to: '/catalogue', search: catalogueSearch.parse({ q: query }) })
        }
      />
    );
  },
});
