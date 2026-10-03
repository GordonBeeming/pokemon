import type { BinderSearchMatch } from '@pokedex/shared';
import { useContext, useEffect, useRef, useState, type ReactElement } from 'react';
import {
  ComboBox,
  ComboBoxStateContext,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
} from 'react-aria-components';
import { useBinderSpaceSearch } from '../../api/queries/binders';
import { binderErrorMessage } from './model';

const DEBOUNCE_MS = 250;
const PAGE_SIZE = 50;
const PREVIOUS_KEY = '__previous';
const NEXT_KEY = '__next';

interface MatchOption {
  id: string;
  match: BinderSearchMatch | null;
  label: string;
  detail: string;
}

function matchDetail(match: BinderSearchMatch): string {
  return [
    `Page ${match.page + 1}`,
    match.row !== null && match.column !== null
      ? `row ${match.row + 1}, pocket ${match.column + 1}`
      : null,
    match.kind === 'pokemon' ||
    match.kind === 'exact-card' ||
    match.kind === 'set' ||
    match.kind === 'illustrator' ||
    match.kind === 'trainer'
      ? match.placed
        ? 'Placed'
        : 'Unfilled'
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Re-opens the results after "more matches" (choosing any option closes the list).
 * Compares against the last page seen rather than skipping the first run, so React's
 * development double-run of effects can't open an empty list on mount. */
function ReopenWhen({ signal }: { signal: number }): null {
  const state = useContext(ComboBoxStateContext);
  const seen = useRef(signal);
  useEffect(() => {
    if (seen.current === signal) return;
    seen.current = signal;
    state?.open();
    // Only the page change should reopen it, not every state object React Aria makes.
  }, [signal]);
  return null;
}

/** "Find in this binder": searches every page server-side. The query lives in the URL
 * (`q`), so it survives reload and is naturally empty in any other binder. The
 * results are a combo box list anchored to the field: picking one clears the search,
 * closes the list and then jumps, so a list and a pocket sheet are never open together. */
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
  const status = !draft.trim()
    ? ''
    : draft !== query
      ? 'Searching binder…'
      : results.isError
        ? binderErrorMessage(results.error)
        : results.isFetching
          ? 'Searching binder…'
          : data
            ? data.matches.length
              ? `Showing matches ${offset + 1}–${offset + data.matches.length}${data.nextOffset !== null ? ' · more available' : ''}.`
              : 'No matching spaces.'
            : '';

  const options: MatchOption[] = [];
  if (data && offset > 0)
    options.push({ id: PREVIOUS_KEY, match: null, label: 'Previous matches', detail: '' });
  for (const match of data?.matches ?? [])
    options.push({
      id: `${match.page}-${match.row}-${match.column}-${match.kind}`,
      match,
      label: match.label,
      detail: matchDetail(match),
    });
  if (data && data.nextOffset !== null)
    options.push({ id: NEXT_KEY, match: null, label: 'More matches', detail: '' });

  return (
    <>
      <ComboBox
        className="space-search"
        items={options}
        inputValue={draft}
        onInputChange={setDraft}
        selectedKey={null}
        allowsCustomValue
        allowsEmptyCollection
        menuTrigger="input"
        isDisabled={pending}
        onSelectionChange={(key) => {
          if (key === PREVIOUS_KEY) setOffset(Math.max(0, offset - PAGE_SIZE));
          else if (key === NEXT_KEY) {
            if (data?.nextOffset !== null && data?.nextOffset !== undefined)
              setOffset(data.nextOffset);
          } else {
            const option = options.find((item) => item.id === key);
            if (option?.match) {
              // A pick is done with the search: clear the field and the query so the
              // list and its type-ahead don't linger over the pocket it jumped to.
              setDraft('');
              setOffset(0);
              onQueryChange('');
              onJump(option.match);
            }
          }
        }}
      >
        <Label className="sr-only">Find in this binder</Label>
        <Input type="search" maxLength={120} placeholder="Find in this binder" />
        <ReopenWhen signal={offset} />
        <Popover
          className="space-search-popover"
          placement="bottom start"
          offset={4}
          containerPadding={8}
        >
          <ListBox<MatchOption>
            className="space-search-list"
            renderEmptyState={() => <p className="space-search-status">{status}</p>}
          >
            {(option) => (
              <ListBoxItem
                id={option.id}
                textValue={option.label}
                className={
                  option.match ? 'space-search-option' : 'space-search-option space-search-more'
                }
              >
                <strong>{option.label}</strong>
                {option.detail ? (
                  <span className="space-search-option-detail">{option.detail}</span>
                ) : null}
              </ListBoxItem>
            )}
          </ListBox>
        </Popover>
      </ComboBox>
      <span role="status" className="sr-only">
        {status}
      </span>
    </>
  );
}
