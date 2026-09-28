import type { BinderSearchMatch } from '@pokedex/shared';
import { useEffect, useId, useState, type ReactElement } from 'react';
import { useBinderSpaceSearch } from '../../api/queries/binders';
import { binderErrorMessage } from './model';

const DEBOUNCE_MS = 250;
const PAGE_SIZE = 50;

/** "Find in this binder": searches every page server-side. The query lives in the URL
 * (`q`), so it survives reload and is naturally empty in any other binder. */
export function SpaceSearch({
  versionId,
  query,
  pending,
  onQueryChange,
  onJump,
}: {
  versionId: string;
  query: string;
  pending: boolean;
  onQueryChange: (query: string) => void;
  onJump: (match: BinderSearchMatch) => void;
}): ReactElement {
  const inputId = useId();
  const [draft, setDraft] = useState(query);
  const [offset, setOffset] = useState(0);
  const results = useBinderSpaceSearch(versionId, query, offset);

  useEffect(() => setDraft(query), [query]);
  useEffect(() => {
    if (draft === query) return;
    const timer = setTimeout(() => {
      setOffset(0);
      onQueryChange(draft);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, query, onQueryChange]);

  const data = results.data;
  const status = !query.trim()
    ? ''
    : results.isFetching
      ? 'Searching binder…'
      : data
        ? data.matches.length
          ? `Showing matches ${offset + 1}–${offset + data.matches.length}${data.nextOffset !== null ? ' · more available' : ''}.`
          : 'No matching spaces.'
        : '';

  return (
    <div className="space-search">
      <label htmlFor={inputId} className="sr-only">
        Find in this binder
      </label>
      <input
        id={inputId}
        type="search"
        maxLength={120}
        value={draft}
        placeholder="Find in this binder"
        onChange={(event) => setDraft(event.target.value)}
      />
      {query.trim() ? (
        <div className="space-search-results">
          <p role="status" className="panel-help">
            {status}
          </p>
          {results.isError ? (
            <p role="alert" className="panel-error">
              {binderErrorMessage(results.error)}
            </p>
          ) : null}
          {data && data.matches.length > 0 ? (
            <ul>
              {data.matches.map((match) => (
                <li key={`${match.page}-${match.row}-${match.column}-${match.kind}`}>
                  <button type="button" disabled={pending} onClick={() => onJump(match)}>
                    <strong>{match.label}</strong>
                    <span>
                      Page {match.page + 1}
                      {match.row !== null && match.column !== null
                        ? ` · row ${match.row + 1}, pocket ${match.column + 1}`
                        : ''}
                      {match.kind === 'pokemon' || match.kind === 'exact-card'
                        ? ` · ${match.placed ? 'Placed' : 'Unfilled'}`
                        : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {data && (offset > 0 || data.nextOffset !== null) ? (
            <div className="panel-actions">
              <button
                type="button"
                disabled={offset === 0 || results.isFetching}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                Previous matches
              </button>
              <button
                type="button"
                disabled={data.nextOffset === null || results.isFetching}
                onClick={() => {
                  if (data.nextOffset !== null) setOffset(data.nextOffset);
                }}
              >
                Next matches
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
