import { useQueryClient } from '@tanstack/react-query';
import { applyMutation } from '../screens/binders/useBinderWriter';
import { z } from 'zod';
import { Link } from '@tanstack/react-router';
import { BinderActivity } from '../screens/binders/BinderActivity';
import { useBinders } from '../api/queries/binders';
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

export const binderActivityRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/binders/$binderId/activity',
  validateSearch: (search) =>
    z.object({ returnPage: z.number().int().positive().catch(1) }).parse(search),
  component: function BinderActivityPage() {
    const { binderId } = binderActivityRoute.useParams();
    const queryClient = useQueryClient();
    const { returnPage } = binderActivityRoute.useSearch();
    const navigate = useNavigate();
    const binders = useBinders();
    const binder = binders.data?.find((b) => b.id === binderId);
    if (binders.isPending) return <p role="status">Loading binder…</p>;
    if (binders.isError)
      return (
        <section>
          <h1>Binder activity could not load</h1>
          <button type="button" onClick={() => void binders.refetch()}>
            Try again
          </button>
        </section>
      );
    if (!binder)
      return (
        <section>
          <h1>Binder not found</h1>
          <Link to="/binders">Back to all binders</Link>
        </section>
      );
    return (
      <section className="binder-view binder-scope">
        <header className="binder-header">
          <div className="binder-heading">
            <Link
              to="/binders/$binderId"
              params={{ binderId }}
              search={binderSearch.parse({ page: returnPage, q: '' })}
            >
              Back to {binder?.name ?? 'binder'}
            </Link>
            <h1>Binder activity</h1>
            <p className="binder-meta">{binder?.name ?? 'Placements and checkpoints'}</p>
          </div>
        </header>
        <BinderActivity
          key={binderId}
          binderId={binderId}
          revision={0}
          onMutation={(result) => applyMutation(queryClient, result)}
          onOpenCard={(cardId) => void navigate({ to: '/card/$cardId', params: { cardId } })}
        />
      </section>
    );
  },
});
