import { createRoute, useNavigate } from '@tanstack/react-router';
import { useCallback } from 'react';
import { BinderDetail } from '../screens/BinderDetail';
import { Binders } from '../screens/Binders';
import { authedRoute } from './authed-layout';
import { binderSearch, type BinderSearch } from './search-params';

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
          // Every change from inside a binder (page turns by swipe, stepper, keys or a
          // drag at the edge; bookmark and search jumps; selection) stays on this
          // binder, so the window keeps its scroll instead of jumping to the top.
          resetScroll: false,
        }),
      [navigate, binderId],
    );
    return (
      <BinderDetail
        binderId={binderId}
        search={search}
        onSearch={onSearch}
        onOpenLibrary={() => void navigate({ to: '/binders' })}
      />
    );
  },
});
