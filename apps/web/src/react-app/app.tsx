import { useEffect, useRef, useState, type ReactElement } from 'react';
import {
  api,
  ApiError,
  AUTH_LOST_EVENT,
  type Dashboard,
  type DesktopToken,
  type PairingCode,
  type SetFacet,
  type NationalPokedexCoverage,
  type NationalPokedexPreview,
} from './api';
import { BinderView } from './binder-view';
import { CatalogueView } from './catalogue-view';
import { NationalPokedexView, type OwnershipFilter } from './national-pokedex-view';
import { NATIONAL_POKEDEX, type NationalPokedexEntry } from './national-pokedex';
import { LoadingOverlay } from './loading-overlay';
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
const DISCOVERY_CACHE_MS = 6 * 60 * 60 * 1000;

function discoveryCacheKey(number: number): string {
  return `pokedex:species-discovery:${number}`;
}

function recentlyDiscovered(number: number): boolean {
  try {
    const checkedAt = Number(localStorage.getItem(discoveryCacheKey(number)) ?? 0);
    return checkedAt > Date.now() - DISCOVERY_CACHE_MS;
  } catch {
    return false;
  }
}

function rememberDiscovery(number: number): void {
  try {
    localStorage.setItem(discoveryCacheKey(number), String(Date.now()));
  } catch {
    // Storage can be unavailable in private or locked-down browser contexts.
  }
}

function hashRoute(): Route {
  const key = location.hash.slice(1).split('?', 1)[0];
  return routes.find(([route]) => route === key)?.[0] ?? 'dashboard';
}

function hashParams(): URLSearchParams {
  const query = location.hash.slice(1).split('?', 2)[1];
  return new URLSearchParams(query ?? '');
}

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
  const [route, setRoute] = useState<Route>(hashRoute);
  const [notice, setNotice] = useState<Notice>(null);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [sets, setSets] = useState<SetFacet[] | null>(null);
  const [species, setSpecies] = useState<NationalPokedexCoverage[] | null>(null);
  const [speciesPreviews, setSpeciesPreviews] = useState<NationalPokedexPreview[]>([]);
  const [discoveringSpecies, setDiscoveringSpecies] = useState<number | null>(null);
  const [discoveryError, setDiscoveryError] = useState<{ number: number; message: string } | null>(
    null,
  );
  const [discoveryResult, setDiscoveryResult] = useState<{
    number: number;
    message: string;
  } | null>(null);
  const [catalogueRefresh, setCatalogueRefresh] = useState(0);
  const [tokens, setTokens] = useState<DesktopToken[] | null>(null);
  const [pairCode, setPairCode] = useState<PairingCode | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeStatus, setRouteStatus] = useState('');
  const [routeError, setRouteError] = useState<string | null>(null);
  const [routeReload, setRouteReload] = useState(0);
  const [pairPending, setPairPending] = useState(false);
  const [catalogueParams, setCatalogueParams] = useState(() =>
    hashRoute() === 'catalogue' ? hashParams() : new URLSearchParams(),
  );
  const [nationalQuery, setNationalQuery] = useState('');
  const [nationalOwnership, setNationalOwnership] = useState<OwnershipFilter>('all');
  const [nationalPage, setNationalPage] = useState(0);
  const [nationalFocus, setNationalFocus] = useState<number | null>(null);
  const [nationalScrollY, setNationalScrollY] = useState(0);
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
    const authenticationLost = (): void => {
      loadController.current?.abort();
      setNotice(null);
      setAuth('anonymous');
    };
    addEventListener(AUTH_LOST_EVENT, authenticationLost);
    return () => removeEventListener(AUTH_LOST_EVENT, authenticationLost);
  }, []);

  useEffect(() => {
    const update = (): void => {
      const next = hashRoute();
      setRoute(next);
      if (next === 'catalogue') setCatalogueParams(hashParams());
    };
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
            ? api.nationalPokedex(controller.signal).then((coverage) => {
                setSpecies(coverage);
                void api
                  .nationalPokedexPreviews(
                    NATIONAL_POKEDEX.map((entry) => entry.name),
                    controller.signal,
                  )
                  .then((previews) => {
                    if (generation === loadGeneration.current) {
                      setSpeciesPreviews(previews);
                      setRouteStatus(
                        `1,025 National Pokédex entries and ${previews.length} card previews loaded.`,
                      );
                    }
                  })
                  .catch((error: unknown) => {
                    if (error instanceof DOMException && error.name === 'AbortError') return;
                    if (generation === loadGeneration.current)
                      setRouteStatus(
                        'National Pokédex loaded. Some automatic card previews are unavailable.',
                      );
                  });
                return '1,025 National Pokédex entries loaded. Card previews are loading.';
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

  function navigate(next: Route, params?: URLSearchParams): void {
    const query = params && [...params].length ? `?${params}` : '';
    const hash = `#${next}${query}`;
    if (next === 'catalogue') setCatalogueParams(params ?? new URLSearchParams());
    if (location.hash !== hash) location.hash = hash;
    setRoute(next);
    setNotice(null);
  }

  function discoverSpecies(entry: NationalPokedexEntry, force = false): void {
    if (!force && recentlyDiscovered(entry.number)) {
      setDiscoveryError(null);
      setDiscoveryResult({
        number: entry.number,
        message: `${entry.name} printings are ready from the recent index.`,
      });
      return;
    }
    setDiscoveringSpecies(entry.number);
    setDiscoveryError(null);
    setDiscoveryResult(null);
    void api
      .discoverSpecies(entry.number, entry.name)
      .then((imported) => {
        rememberDiscovery(entry.number);
        setCatalogueRefresh((current) => current + 1);
        setDiscoveryResult({
          number: entry.number,
          message: imported
            ? `${imported} ${entry.name} printings are indexed.`
            : `No additional English ${entry.name} printings were found.`,
        });
      })
      .catch((error: unknown) => {
        const message = userMessage(error);
        if (message) setDiscoveryError({ number: entry.number, message });
      })
      .finally(() => setDiscoveringSpecies(null));
  }

  function openSpecies(entry: NationalPokedexEntry): void {
    const params = new URLSearchParams({
      species: entry.name,
      pokedexNumber: String(entry.number),
    });
    setNationalFocus(entry.number);
    setNationalScrollY(window.scrollY);
    navigate('catalogue', params);
    discoverSpecies(entry);
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
    content = (
      <CatalogueView
        initialParams={catalogueParams}
        refreshKey={catalogueRefresh}
        indexing={discoveringSpecies === Number(catalogueParams.get('pokedexNumber'))}
        indexingError={
          discoveryError?.number === Number(catalogueParams.get('pokedexNumber'))
            ? discoveryError.message
            : null
        }
        indexingResult={
          discoveryResult?.number === Number(catalogueParams.get('pokedexNumber'))
            ? discoveryResult.message
            : null
        }
        retryIndexing={() => {
          const number = Number(catalogueParams.get('pokedexNumber'));
          const name = catalogueParams.get('species');
          if (Number.isInteger(number) && name) discoverSpecies({ number, name }, true);
        }}
        onBackToNational={() => navigate('species')}
        onBackToSets={() => navigate('sets')}
        onShowAll={() => navigate('catalogue')}
        onNotice={setNotice}
      />
    );
  else if (route === 'binders') content = <BinderView onNotice={setNotice} />;
  else if (route === 'sets')
    content = sets ? (
      <FacetsView
        title="Set checklists"
        items={sets.map((item) => ({
          id: `${item.setId}:${item.language}`,
          label: item.setName,
          detail: `${item.owned} of ${item.total} owned · ${item.language}`,
          owned: item.owned,
          total: item.total,
        }))}
        onChoose={(selected) => {
          const chosen = sets.find((item) => `${item.setId}:${item.language}` === selected);
          if (!chosen) return;
          navigate(
            'catalogue',
            new URLSearchParams({
              setId: chosen.setId,
              setName: chosen.setName,
              language: chosen.language,
            }),
          );
        }}
      />
    ) : routeError ? (
      <RouteLoadError route={routeError} retry={retryRoute} />
    ) : (
      <LoadingRoute message="Loading set checklists…" />
    );
  else if (route === 'species')
    content = species ? (
      <NationalPokedexView
        coverage={species}
        previews={speciesPreviews}
        query={nationalQuery}
        ownership={nationalOwnership}
        page={nationalPage}
        focusNumber={nationalFocus}
        restoreScrollY={nationalScrollY}
        pendingNumber={discoveringSpecies}
        onQueryChange={setNationalQuery}
        onOwnershipChange={setNationalOwnership}
        onPageChange={setNationalPage}
        onChoose={openSpecies}
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
      <DashboardView
        data={dashboard}
        browse={() => navigate('catalogue')}
        plan={() => navigate('species')}
        chooseCard={(card) => navigate('catalogue', new URLSearchParams({ q: card.name }))}
      />
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
      <div className="route-frame loading-stage" aria-busy={routeLoading}>
        {routeLoading ? (
          <LoadingOverlay message={routeStatus || 'Opening your collection…'} />
        ) : null}
        {content}
      </div>
    </Shell>
  );
}
