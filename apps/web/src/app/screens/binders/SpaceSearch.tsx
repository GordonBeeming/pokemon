import { useEffect, useState, type ReactElement } from 'react';

const DEBOUNCE_MS = 250;

/** "Find in this binder": the search field. The query lives in the URL (`q`), so it
 * survives reload and is naturally empty in any other binder; while it is set, the
 * binder shows its matches as a card grid (BinderSearchResults) instead of its pages. */
export function SpaceSearch({
  query,
  pending,
  onQueryChange,
}: {
  query: string;
  pending: boolean;
  onQueryChange: (query: string) => void;
}): ReactElement {
  const [draft, setDraft] = useState(query);

  useEffect(() => setDraft(query), [query]);
  useEffect(() => {
    if (draft === query) return;
    const timer = setTimeout(() => onQueryChange(draft), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, query, onQueryChange]);

  return (
    <div className="space-search">
      <label className="sr-only" htmlFor="binder-space-search">
        Find in this binder
      </label>
      <input
        id="binder-space-search"
        type="search"
        maxLength={120}
        placeholder="Find in this binder"
        value={draft}
        disabled={pending}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && draft) {
            event.preventDefault();
            setDraft('');
            onQueryChange('');
          }
        }}
      />
    </div>
  );
}
