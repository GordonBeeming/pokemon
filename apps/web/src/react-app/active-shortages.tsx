import { useEffect, useRef, useState, type ReactElement } from 'react';
import { api, type ActiveShortageEntry, type Dashboard } from './api';
import { userMessage } from './ui';

export function catalogueHrefForEntry(entry: ActiveShortageEntry): string {
  if (entry.kind === 'pokemon' && entry.pokemonNumber !== null) {
    const params = new URLSearchParams();
    params.set('pokedexNumber', String(entry.pokemonNumber));
    return `#catalogue?${params.toString()}`;
  }
  const cardName = entry.label.includes(' · ') ? entry.label.split(' · ')[0] : entry.label;
  const params = new URLSearchParams();
  if (cardName) {
    params.set('q', entry.number ?? cardName.trim());
  }
  if (entry.setId) params.set('setId', entry.setId);
  if (entry.language) params.set('language', entry.language);
  return `#catalogue?${params.toString()}`;
}

export function ActiveShortages({
  id = 'active-shortages-panel',
  dashboard,
  onClose,
}: {
  id?: string;
  dashboard: Dashboard;
  onClose?: () => void;
}): ReactElement {
  const [entries, setEntries] = useState<ActiveShortageEntry[] | null>(null);
  const [totalMissing, setTotalMissing] = useState<number | null>(null);
  const [totalEntries, setTotalEntries] = useState<number | null>(null);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

  const requestController = useRef<AbortController | null>(null);
  const snapshot = useRef<string | undefined>(undefined);

  async function loadInitial(signal: AbortSignal): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const report = await api.activeShortages(0, signal);
      if (signal.aborted) return;
      snapshot.current = report.snapshot;
      setEntries(report.entries);
      setTotalMissing(report.totalMissing);
      setTotalEntries(report.totalEntries);
      setNextOffset(report.nextOffset);
    } catch (cause) {
      if (signal.aborted) return;
      setError(userMessage(cause) || 'Active shortages could not load. Try again.');
    } finally {
      if (!signal.aborted) {
        setLoading(false);
      }
    }
  }

  async function loadMore(): Promise<void> {
    if (nextOffset === null || loadingMore) return;
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const report = await api.activeShortages(nextOffset, controller.signal);
      if (controller.signal.aborted) return;
      if (
        report.snapshot !== snapshot.current ||
        report.totalEntries !== totalEntries ||
        report.totalMissing !== totalMissing
      ) {
        await loadInitial(controller.signal);
        return;
      }
      setEntries((prev) => [
        ...new Map(
          [...(prev ?? []), ...report.entries].map((entry) => [
            `${entry.kind}:${entry.cardId ?? entry.pokemonNumber}`,
            entry,
          ]),
        ).values(),
      ]);
      setTotalMissing(report.totalMissing);
      setTotalEntries(report.totalEntries);
      setNextOffset(report.nextOffset);
    } catch (cause) {
      if (controller.signal.aborted) return;
      setLoadMoreError(userMessage(cause) || 'Could not load more shortages. Try again.');
    } finally {
      if (!controller.signal.aborted) {
        setLoadingMore(false);
      }
    }
  }

  useEffect(() => {
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    setEntries(null);
    setNextOffset(null);
    setTotalMissing(null);
    setTotalEntries(null);
    setLoadMoreError(null);
    setLoadingMore(false);
    void loadInitial(controller.signal);

    return () => {
      requestController.current?.abort();
    };
  }, [dashboard]);

  return (
    <section className="active-shortages-panel" id={id} aria-labelledby="active-shortages-heading">
      <div className="active-shortages-header">
        <div>
          <h2 id="active-shortages-heading">Active shortages report</h2>
          <p className="active-shortages-subtitle">
            Physical copies needed to complete targets across your current binder plans.
          </p>
        </div>
        <div className="header-actions">
          <a className="quiet-button" href="#binders">
            Open binder plans
          </a>
          {onClose && (
            <button
              className="quiet-button"
              type="button"
              onClick={onClose}
              aria-label="Close active shortages report"
            >
              Close
            </button>
          )}
        </div>
      </div>

      <aside className="active-shortages-guide" aria-label="Understanding active shortages">
        <p>
          <strong>Active plans:</strong> Targets are drawn from your current binder plans. Shortages
          indicate additional physical copies needed for unfilled targets after copies already
          placed elsewhere in your binders are counted.
        </p>
        <p>
          <strong>Allocation priority:</strong> Exact printing targets get first claim on remaining
          owned copies before flexible, any-printing Pokémon species targets. Planned placeholders
          reserve binder layout slots and are not counted as owned inventory.
        </p>
      </aside>

      {loading && (
        <p className="active-shortages-status" role="status" aria-live="polite">
          Loading active shortages…
        </p>
      )}

      {error && !loading && (
        <div className="active-shortages-error" role="alert">
          <p className="notice error">{error}</p>
          <button
            className="quiet-button"
            type="button"
            onClick={() => {
              requestController.current?.abort();
              const controller = new AbortController();
              requestController.current = controller;
              void loadInitial(controller.signal);
            }}
          >
            Try again
          </button>
        </div>
      )}

      {!loading && !error && entries !== null && entries.length === 0 && (
        <div className="empty-state">
          <h3>No active shortages</h3>
          <p>
            You have enough available copies for your current targets. Some copies may still need to
            be placed in a binder.
          </p>
        </div>
      )}

      {!loading && !error && entries !== null && entries.length > 0 && (
        <>
          <div
            className="active-shortages-table-wrap"
            tabIndex={0}
            role="region"
            aria-label="Active shortages table"
          >
            <table className="active-shortages-table">
              <thead>
                <tr>
                  <th scope="col">Target</th>
                  <th scope="col">Kind</th>
                  <th className="num-col" scope="col">
                    Unfilled targets
                  </th>
                  <th className="num-col" scope="col">
                    Owned
                  </th>
                  <th className="num-col" scope="col">
                    Placed
                  </th>
                  <th className="num-col" scope="col">
                    Available
                  </th>
                  <th className="num-col" scope="col">
                    Missing
                  </th>
                  <th scope="col">Action</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry, index) => {
                  const href = catalogueHrefForEntry(entry);
                  const isExact = entry.kind === 'exact-card';
                  return (
                    <tr
                      key={`${entry.kind}:${entry.cardId ?? entry.pokemonNumber ?? entry.label}:${index}`}
                    >
                      <th scope="row">
                        <a className="shortage-target-link" href={href}>
                          {entry.label}
                        </a>
                      </th>
                      <td>
                        <span className="shortage-kind-tag">
                          {isExact ? 'Exact printing' : 'Pokémon species'}
                        </span>
                      </td>
                      <td className="num-col">{entry.required}</td>
                      <td className="num-col">{entry.owned}</td>
                      <td className="num-col">{entry.assigned}</td>
                      <td className="num-col">{entry.available}</td>
                      <td className="num-col shortage-missing-badge">
                        <strong>{entry.missing}</strong>
                      </td>
                      <td>
                        <a className="text-button" href={href}>
                          View in catalogue
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="active-shortages-footer">
            <p className="active-shortages-summary">
              Showing {entries.length}
              {totalEntries !== null ? ` of ${totalEntries}` : ''} shortage targets
              {totalMissing !== null ? ` (${totalMissing} copies needed)` : ''}.
            </p>
            {nextOffset !== null && (
              <div className="active-shortages-load-more">
                <button
                  className="quiet-button"
                  type="button"
                  onClick={() => void loadMore()}
                  disabled={loadingMore}
                >
                  {loadingMore ? 'Loading more…' : 'Load more shortages'}
                </button>
                {loadMoreError && (
                  <div className="active-shortages-error" role="alert">
                    <span className="notice error">{loadMoreError}</span>
                    <button
                      className="text-button"
                      type="button"
                      onClick={() => void loadMore()}
                      disabled={loadingMore}
                    >
                      Retry
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
