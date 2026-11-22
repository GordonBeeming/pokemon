import { useInfiniteQuery } from '@tanstack/react-query';
import { pokemonDisplayName } from '@pokedex/shared';
import { InfiniteLoader } from '../../../ui/InfiniteLoader';
import { uniqueItems } from '../../../api/infinite-data';
import type { FrameType } from '@pokedex/shared';
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { searchCards, type ResolvedCard } from '../../../api/queries/binders';
import { CardFrame } from '../../../cards/CardFrame';
import { binderErrorMessage, frameCardFrom } from '../model';

export const PICKER_PAGE_SIZE = 24;

export interface PickerQuery {
  q: string;
  /** Fixed filters the picker always applies (same-type species, category). */
  filters?: Record<string, string>;
}

function toParams(query: PickerQuery, offset: number, limit = PICKER_PAGE_SIZE): URLSearchParams {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (query.q.trim()) params.set('q', query.q.trim());
  for (const [key, value] of Object.entries(query.filters ?? {})) params.set(key, value);
  return params;
}

/** Collects every result of a search up to `cap` cards, in catalogue order. Throws a
 * readable error instead of silently truncating when the search is larger. */
export async function collectAllCards(
  query: PickerQuery,
  cap: number,
  signal: AbortSignal,
): Promise<ResolvedCard[]> {
  const found: ResolvedCard[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;
  while (offset < total) {
    const page = await searchCards(toParams(query, offset, 100), signal);
    total = page.total;
    if (total > cap)
      throw new Error(
        `Select up to ${cap.toLocaleString('en-AU')} cards at once. This search has ${total.toLocaleString('en-AU')}; narrow it first.`,
      );
    if (page.cards.length === 0) break;
    for (const card of page.cards) {
      if (seen.has(card.id)) throw new Error('The results changed while selecting. Try again.');
      seen.add(card.id);
      found.push(card);
    }
    offset += page.cards.length;
  }
  return found;
}

/** The one exact-card result grid used by Change target, Insert and Find cards. Every
 * result is a picker preview: full colour, never faded by ownership. */
export function CardPicker({
  query,
  palette,
  pending,
  selectedIds,
  onPick,
  onTotal,
  searchLabel = 'Search cards',
  autoSearch = false,
  placeholder = 'Pokémon, set, number, rarity, or artist',
  hideIds,
  renderItem,
}: {
  query: PickerQuery;
  palette: Record<FrameType, string>;
  pending: boolean;
  selectedIds?: ReadonlySet<string>;
  onPick?: (card: ResolvedCard) => void;
  onTotal?: (total: number, query: PickerQuery) => void;
  searchLabel?: string;
  autoSearch?: boolean;
  placeholder?: string;
  /** Results left out of the grid because the caller already shows them elsewhere. */
  hideIds?: ReadonlySet<string>;
  /** Draws each result in place of the default pick button, keeping the grid's look. */
  renderItem?: (card: ResolvedCard) => ReactElement;
}): ReactElement {
  const [draft, setDraft] = useState(query.q);
  const [active, setActive] = useState<PickerQuery | null>(autoSearch ? query : null);
  const criteria = active ? JSON.stringify([active.q, active.filters ?? {}]) : null;
  const request = useInfiniteQuery({
    queryKey: ['catalogue', 'search', 'picker', criteria],
    initialPageParam: 0,
    enabled: active !== null,
    queryFn: ({ pageParam, signal }) => {
      if (!active) throw new Error('Choose a search first.');
      return searchCards(toParams(active, pageParam), signal);
    },
    getNextPageParam: (last, _pages, param) =>
      last.cards.length > 0 && param + last.cards.length < last.total
        ? param + last.cards.length
        : undefined,
  });
  const results = useMemo(() => {
    const first = request.data?.pages[0];
    return first
      ? {
          ...first,
          cards: uniqueItems(
            request.data?.pages.flatMap((page) => page.cards) ?? [],
            (card) => card.id,
          ),
        }
      : null;
  }, [request.data]);
  const loading = active !== null && request.isPending;
  const error = request.isError && !results ? binderErrorMessage(request.error) : null;
  const onTotalRef = useRef(onTotal);
  onTotalRef.current = onTotal;
  const total = request.data?.pages[0]?.total;
  useEffect(() => {
    if (active && total !== undefined) onTotalRef.current?.(total, active);
  }, [active, total]);

  const shown = results?.cards.filter((card) => !hideIds?.has(card.id)) ?? [];
  return (
    <div className="card-picker">
      <form
        className="card-picker-form"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          setActive({ ...query, q: draft });
        }}
      >
        <label>
          <span>{searchLabel}</span>
          <input
            type="search"
            value={draft}
            maxLength={200}
            placeholder={placeholder}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <button type="submit" disabled={pending || loading}>
          Search cards
        </button>
      </form>
      <p role="status" className="panel-help">
        {loading
          ? 'Loading cards…'
          : results
            ? results.total === 0
              ? 'No matching cards.'
              : `${results.total.toLocaleString('en-AU')} matches`
            : ''}
      </p>
      {error ? (
        <p role="alert" className="panel-error">
          {error}
        </p>
      ) : null}
      {shown.length > 0 ? (
        <div className="card-picker-grid" aria-label="Matching cards">
          {shown.map((card) =>
            renderItem ? (
              renderItem(card)
            ) : (
              <button
                key={card.id}
                type="button"
                className="card-picker-item"
                aria-pressed={selectedIds ? selectedIds.has(card.id) : undefined}
                disabled={pending || !onPick}
                onClick={() => onPick?.(card)}
              >
                <CardFrame card={frameCardFrom(card)} state="owned" forceSolid palette={palette} />
                <span className="card-picker-name" title={pokemonDisplayName(card.name)}>
                  {pokemonDisplayName(card.name)}
                </span>
                <span className="card-picker-meta" title={`${card.number} · ${card.setName}`}>
                  {card.number} · {card.setName}
                </span>
              </button>
            ),
          )}
        </div>
      ) : null}
      <InfiniteLoader
        hasMore={request.hasNextPage ?? false}
        loading={request.isFetchingNextPage}
        loadedCount={results?.cards.length ?? 0}
        error={request.isFetchNextPageError ? 'More cards could not load.' : null}
        onLoadMore={() => void request.fetchNextPage({ cancelRefetch: false })}
      />
    </div>
  );
}
