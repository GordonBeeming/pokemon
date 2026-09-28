import { Link } from '@tanstack/react-router';
import { useEffect, useRef, type ReactElement, type RefObject } from 'react';
import { useActiveShortages, type ActiveShortageEntry } from '../../api/queries/dashboard';
import { catalogueSearch } from '../../routes/search-params';

/** Deep-links a shortage row back into Catalogue, pre-filtered to the exact card
 * (via `q`) or scoped to the species (via `dex`) — FEATURES.md's "each carry a deep
 * link back into Catalogue" requirement. */
function catalogueHrefFor(entry: ActiveShortageEntry) {
  if (entry.kind === 'pokemon' && entry.pokemonNumber !== null)
    return catalogueSearch.parse({ dex: entry.pokemonNumber });
  const cardName = entry.label.includes(' · ') ? entry.label.split(' · ')[0] : entry.label;
  return catalogueSearch.parse({
    q: entry.number ?? cardName?.trim() ?? entry.label,
    set: entry.setId ? [entry.setId] : [],
  });
}

export function ActiveShortagesPanel({
  onClose,
  closeButtonRef,
}: {
  onClose: () => void;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
}): ReactElement {
  const shortages = useActiveShortages(true);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <section className="active-shortages-panel" aria-labelledby="active-shortages-heading">
      <div className="active-shortages-header">
        <h2 id="active-shortages-heading" ref={headingRef} tabIndex={-1}>
          Active shortages report
        </h2>
        <div className="active-shortages-header-actions">
          <Link to="/binders">Open binder plans</Link>
          <button
            type="button"
            ref={closeButtonRef}
            onClick={() => {
              onClose();
            }}
          >
            Close
          </button>
        </div>
      </div>
      <p className="active-shortages-subtitle">
        Physical copies needed to complete targets across your current binder plans. Exact-printing
        targets get first claim on remaining owned copies before any-printing Pokémon targets.
      </p>

      {shortages.loading ? (
        <p role="status" aria-live="polite">
          Loading active shortages…
        </p>
      ) : shortages.error ? (
        <div className="notice error" role="alert">
          <p>{shortages.error}</p>
          <button type="button" onClick={shortages.retry}>
            Try again
          </button>
        </div>
      ) : shortages.entries !== null && shortages.entries.length === 0 ? (
        <p className="empty-state">No active shortages.</p>
      ) : shortages.entries !== null ? (
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
                  <th scope="col">Unfilled targets</th>
                  <th scope="col">Owned</th>
                  <th scope="col">Placed</th>
                  <th scope="col">Available</th>
                  <th scope="col">Missing</th>
                  <th scope="col">Action</th>
                </tr>
              </thead>
              <tbody>
                {shortages.entries.map((entry, index) => (
                  <tr key={`${entry.kind}:${entry.cardId ?? entry.pokemonNumber}:${index}`}>
                    <th scope="row">
                      <Link to="/catalogue" search={catalogueHrefFor(entry)}>
                        {entry.label}
                      </Link>
                    </th>
                    <td>{entry.kind === 'exact-card' ? 'Exact printing' : 'Pokémon species'}</td>
                    <td>{entry.required}</td>
                    <td>{entry.owned}</td>
                    <td>{entry.assigned}</td>
                    <td>{entry.available}</td>
                    <td>
                      <strong>{entry.missing}</strong>
                    </td>
                    <td>
                      <Link to="/catalogue" search={catalogueHrefFor(entry)}>
                        View in catalogue
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="active-shortages-summary">
            Showing {shortages.entries.length}
            {shortages.totalEntries !== null ? ` of ${shortages.totalEntries}` : ''} shortage
            targets
            {shortages.totalMissing !== null ? ` (${shortages.totalMissing} copies needed)` : ''}.
          </p>
          {shortages.nextOffset !== null ? (
            <div>
              <button
                type="button"
                disabled={shortages.loadingMore}
                onClick={() => void shortages.loadMore()}
              >
                {shortages.loadingMore ? 'Loading more…' : 'Load more shortages'}
              </button>
              {shortages.loadMoreError ? (
                <span role="alert">
                  {shortages.loadMoreError}{' '}
                  <button type="button" onClick={() => void shortages.loadMore()}>
                    Retry
                  </button>
                </span>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
