import { useEffect, useState, type ReactElement } from 'react';
import type { BinderSearchMatch, BinderSearchResult } from '@pokedex/shared';
import { api } from './api';
import { userMessage } from './ui';

export function BinderSpaceSearch({
  versionId,
  revision,
  pending,
  onJump,
}: {
  versionId: string;
  revision: number;
  pending: boolean;
  onJump: (match: BinderSearchMatch) => void;
}): ReactElement {
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<BinderSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setResult(null);
    setError('');
    if (!query.trim()) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      void api
        .searchBinder(versionId, query.trim(), offset, controller.signal)
        .then((value) => {
          if (!controller.signal.aborted) setResult(value);
        })
        .catch((reason: unknown) => {
          if (!controller.signal.aborted) setError(userMessage(reason));
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [versionId, revision, query, offset]);
  return (
    <section className="surface binder-space-search" aria-label="Search binder placeholders">
      <label htmlFor="binder-space-query">Find a placeholder or space</label>
      <div className="binder-space-query">
        <input
          id="binder-space-query"
          type="search"
          maxLength={120}
          value={query}
          placeholder="Pokémon name or number, card, reservation, or empty"
          aria-describedby="binder-space-help"
          onChange={(event) => {
            setQuery(event.target.value);
            setOffset(0);
            setResult(null);
          }}
        />
        {query && (
          <button
            className="quiet-button"
            type="button"
            onClick={() => {
              setQuery('');
              setOffset(0);
              setResult(null);
            }}
          >
            Clear
          </button>
        )}
      </div>
      <p id="binder-space-help">
        Search every page in this binder. Choose a result to jump to its space.
      </p>
      <p role="status">
        {loading
          ? 'Searching binder…'
          : result
            ? result.matches.length
              ? `Showing matches ${offset + 1}–${offset + result.matches.length}${result.nextOffset !== null ? ' · more available' : ''}.`
              : 'No matching spaces.'
            : ''}
      </p>
      {error && <p role="alert">{error}</p>}
      {result && result.matches.length > 0 && (
        <ul className="binder-space-results">
          {result.matches.map((match) => (
            <li key={`${match.page}-${match.row}-${match.column}`}>
              <button
                className="quiet-button"
                type="button"
                disabled={pending || loading}
                onClick={() => onJump(match)}
              >
                <strong>{match.label}</strong>
                <span>
                  Page {match.page + 1}
                  {match.row !== null && match.column !== null
                    ? ` · Row ${match.row + 1}, column ${match.column + 1}`
                    : ''}
                  {match.kind === 'pokemon' || match.kind === 'exact-card'
                    ? ` · ${match.placed ? 'Placed' : 'Unfilled'}`
                    : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {result && (offset > 0 || result.nextOffset !== null) && (
        <div className="binder-space-query">
          <button
            className="quiet-button"
            type="button"
            disabled={offset === 0 || loading}
            onClick={() => setOffset(Math.max(0, offset - 50))}
          >
            Previous matches
          </button>
          <button
            className="quiet-button"
            type="button"
            disabled={result.nextOffset === null || loading}
            onClick={() => {
              if (result.nextOffset !== null) setOffset(result.nextOffset);
            }}
          >
            Next matches
          </button>
        </div>
      )}
    </section>
  );
}
