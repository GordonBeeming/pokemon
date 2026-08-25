import { useEffect, useRef, useState, type ReactElement } from 'react';
import {
  api,
  ApiError,
  type Dashboard,
  type DesktopToken,
  type PairingCode,
  type SetFacet,
  type SpeciesFacet,
} from './api';
import { BinderView } from './binder-view';
import { CatalogueView } from './catalogue-view';
import {
  DashboardView,
  DevicesView,
  FacetsView,
  Login,
  Shell,
  routes,
  userMessage,
  type Notice,
  type Route,
} from './ui';

type AuthState = 'checking' | 'authenticated' | 'anonymous' | 'error';

function LoadingPage({ message }: { message: string }): ReactElement {
  return (
    <main className="auth-shell" aria-busy="true">
      <section className="empty-state" aria-labelledby="loading-heading">
        <h1 id="loading-heading">{message}</h1>
      </section>
    </main>
  );
}

function LoadingRoute({ message }: { message: string }): ReactElement {
  return (
    <section className="empty-state">
      <h1>{message}</h1>
    </section>
  );
}

function RouteLoadError({ route, retry }: { route: string; retry: () => void }): ReactElement {
  return (
    <section className="empty-state">
      <h1>{route} could not load.</h1>
      <button className="quiet-button" type="button" onClick={retry}>
        Try again
      </button>
    </section>
  );
}

export function App(): ReactElement {
  const [auth, setAuth] = useState<AuthState>('checking');
  const [route, setRoute] = useState<Route>(
    () => routes.find(([key]) => `#${key}` === location.hash)?.[0] ?? 'dashboard',
  );
  const [notice, setNotice] = useState<Notice>(null);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [sets, setSets] = useState<SetFacet[] | null>(null);
  const [species, setSpecies] = useState<SpeciesFacet[] | null>(null);
  const [tokens, setTokens] = useState<DesktopToken[] | null>(null);
  const [pairCode, setPairCode] = useState<PairingCode | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeStatus, setRouteStatus] = useState('');
  const [routeError, setRouteError] = useState<string | null>(null);
  const [routeReload, setRouteReload] = useState(0);
  const [pairPending, setPairPending] = useState(false);
  const [catalogueParams, setCatalogueParams] = useState(new URLSearchParams());
  const loadGeneration = useRef(0);
  const loadController = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void api
      .me(controller.signal)
      .then(() => setAuth('authenticated'))
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 401) setAuth('anonymous');
        else {
          setAuth('error');
          const message = userMessage(error);
          if (message) setNotice({ kind: 'error', message });
        }
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const update = (): void =>
      setRoute(routes.find(([key]) => `#${key}` === location.hash)?.[0] ?? 'dashboard');
    addEventListener('hashchange', update);
    return () => removeEventListener('hashchange', update);
  }, []);

  useEffect(() => {
    if (auth !== 'authenticated' || route === 'catalogue' || route === 'binders') return;
    const generation = ++loadGeneration.current;
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    setRouteLoading(true);
    const routeLabel = routes.find(([key]) => key === route)?.[1] ?? 'Page';
    setRouteError(null);
    setRouteStatus(`Loading ${routeLabel}.`);
    const load =
      route === 'dashboard'
        ? api.dashboard(controller.signal).then((value) => {
            setDashboard(value);
            return 'Dashboard loaded.';
          })
        : route === 'sets'
          ? api.sets(controller.signal).then((value) => {
              setSets(value);
              return `${value.length} set checklists loaded.`;
            })
          : route === 'species'
            ? api.species(controller.signal).then((value) => {
                setSpecies(value);
                return `${value.length} National Pokédex entries loaded.`;
              })
            : route === 'devices'
              ? api.tokens(controller.signal).then((value) => {
                  setTokens(value);
                  return `${value.length} paired devices loaded.`;
                })
              : Promise.resolve(`${routeLabel} loaded.`);
    void load
      .then((message) => {
        if (generation === loadGeneration.current) setRouteStatus(message);
      })
      .catch((error: unknown) => {
        const message = userMessage(error);
        if (message && generation === loadGeneration.current) {
          setNotice({ kind: 'error', message: `${routeLabel} could not load. ${message}` });
          setRouteError(routeLabel);
          setRouteStatus('');
        }
      })
      .finally(() => {
        if (generation === loadGeneration.current) setRouteLoading(false);
      });
    return () => controller.abort();
  }, [auth, route, routeReload]);

  const retryRoute = (): void => {
    setNotice(null);
    setRouteReload((current) => current + 1);
  };

  function navigate(next: Route): void {
    if (location.hash !== `#${next}`) location.hash = next;
    setRoute(next);
    setNotice(null);
  }

  if (auth === 'checking') return <LoadingPage message="Checking your session…" />;
  if (auth === 'error')
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <h1>Pokédex could not start.</h1>
          <p className="notice error" role="alert">
            {notice?.message ?? 'Reload the page and try again.'}
          </p>
          <button className="quiet-button" type="button" onClick={() => location.reload()}>
            Reload
          </button>
        </section>
      </main>
    );
  if (auth === 'anonymous') return <Login onAuthenticated={() => setAuth('authenticated')} />;

  let content: ReactElement;
  if (route === 'catalogue')
    content = <CatalogueView initialParams={catalogueParams} onNotice={setNotice} />;
  else if (route === 'binders') content = <BinderView onNotice={setNotice} />;
  else if (route === 'sets')
    content = sets ? (
      <FacetsView
        title="Set checklists"
        items={sets.map((item) => ({
          id: `${item.setId}:${item.language}`,
          label: item.setName,
          detail: `${item.owned} of ${item.total} owned · ${item.language}`,
        }))}
        onChoose={(selected) => {
          const [setId] = selected.split(':', 1);
          if (!setId) return;
          setCatalogueParams(new URLSearchParams({ setId }));
          navigate('catalogue');
        }}
      />
    ) : routeError ? (
      <RouteLoadError route={routeError} retry={retryRoute} />
    ) : (
      <LoadingRoute message="Loading set checklists…" />
    );
  else if (route === 'species')
    content = species ? (
      <FacetsView
        title="National Pokédex"
        items={species.map((item) => ({
          id: item.species,
          label: item.species,
          detail: `${item.owned} of ${item.total} owned · ${item.languages.join(', ')}`,
        }))}
        onChoose={(selected) => {
          setCatalogueParams(new URLSearchParams({ species: selected }));
          navigate('catalogue');
        }}
      />
    ) : routeError ? (
      <RouteLoadError route={routeError} retry={retryRoute} />
    ) : (
      <LoadingRoute message="Loading National Pokédex…" />
    );
  else if (route === 'devices')
    content = tokens ? (
      <DevicesView
        tokens={tokens}
        pairCode={pairCode}
        pending={pairPending}
        pair={() => {
          setPairPending(true);
          void api
            .pair()
            .then((result) => {
              setPairCode(result);
              setNotice({ kind: 'success', message: 'Pairing code created.' });
            })
            .catch((error: unknown) => {
              const message = userMessage(error);
              if (message) setNotice({ kind: 'error', message });
            })
            .finally(() => setPairPending(false));
        }}
        revoke={(id) => {
          void api
            .revokeToken(id)
            .then(() => {
              setTokens((current) => current?.filter((token) => token.id !== id) ?? []);
              setNotice({ kind: 'success', message: 'Device revoked.' });
            })
            .catch((error: unknown) => {
              const message = userMessage(error);
              if (message) setNotice({ kind: 'error', message });
            });
        }}
        copied={() => setNotice({ kind: 'success', message: 'Pairing code copied.' })}
        copyFailed={() =>
          setNotice({
            kind: 'error',
            message:
              'Copying the pairing code failed. Select the visible code and copy it manually.',
          })
        }
      />
    ) : routeError ? (
      <RouteLoadError route={routeError} retry={retryRoute} />
    ) : (
      <LoadingRoute message="Loading paired devices…" />
    );
  else
    content = dashboard ? (
      <DashboardView data={dashboard} />
    ) : routeError ? (
      <RouteLoadError route={routeError} retry={retryRoute} />
    ) : (
      <section className="empty-state" aria-busy={routeLoading}>
        <h1>Loading dashboard…</h1>
      </section>
    );

  return (
    <Shell route={route} navigate={navigate} notice={notice}>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {routeStatus}
      </p>
      <div aria-busy={routeLoading}>{content}</div>
    </Shell>
  );
}
