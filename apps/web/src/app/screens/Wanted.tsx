import { type WantedEntry } from '@pokedex/shared';
import { useEffect, useState, type ReactElement } from 'react';
import { Link } from '@tanstack/react-router';
import { anyFrameCard, frameCardFrom } from './binders/model';
import { catalogueSearch } from '../routes/search-params';
import { useBinders } from '../api/queries/binders';
import { useWantedList, useSetWanted, type WantedFilters } from '../api/queries/wanted';
import { CardFrame } from '../cards/CardFrame';
import { InfiniteLoader } from '../ui/InfiniteLoader';
import { SidePanel } from '../ui/SidePanel';
import { useToast } from '../ui/Toast';
import { CardInspector } from './card/CardInspector';
import './wanted.css';
export function Wanted({
  search,
  onSearch,
}: {
  search: WantedFilters;
  onSearch: (search: WantedFilters) => void;
}): ReactElement {
  const binders = useBinders();
  const [inspected, setInspected] = useState<WantedEntry | null>(null);
  const scope =
    search.scope === 'all' ||
    search.scope === 'general' ||
    !binders.data ||
    binders.data.some((b) => b.id === search.scope)
      ? search.scope
      : 'all';
  const canInclude = scope !== 'all' && scope !== 'general';
  const normalized = { ...search, scope, includeUnfilled: canInclude && search.includeUnfilled };
  useEffect(() => {
    if (scope !== search.scope || normalized.includeUnfilled !== search.includeUnfilled)
      onSearch({ ...normalized, offset: 0 });
  }, [scope, search, onSearch, normalized.includeUnfilled]);
  const needsBinders = search.scope !== 'all' && search.scope !== 'general';
  const list = useWantedList(normalized, !needsBinders || binders.data !== undefined);
  const mutation = useSetWanted();
  const entries = list.data?.entries ?? [];
  const total = list.data?.total ?? 0;
  function change(patch: Partial<WantedFilters>) {
    onSearch({
      ...normalized,
      placement: normalized.placement ?? 'all',
      ...patch,
      offset: patch.offset ?? 0,
    });
  }
  return (
    <section className="wanted-screen">
      <header className="wanted-header">
        <div>
          <h1>Wanted</h1>
          <p>Your shopping list. Mark cards as wanted from their details.</p>
        </div>
        <button type="button" onClick={() => window.print()}>
          Print page
        </button>
      </header>
      <div className="wanted-filters">
        <label>
          List
          <select
            value={scope}
            onChange={(e) =>
              change({
                scope: e.target.value,
                includeUnfilled:
                  e.target.value === 'general' || e.target.value === 'all'
                    ? false
                    : normalized.includeUnfilled,
              })
            }
          >
            <option value="all">All lists</option>
            <option value="general">General</option>
            {binders.data?.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Placement
          <select
            value={search.placement ?? 'all'}
            onChange={(e) =>
              change({
                placement:
                  e.target.value === 'ordered'
                    ? 'ordered'
                    : e.target.value === 'placed'
                      ? 'placed'
                      : e.target.value === 'not-placed'
                        ? 'not-placed'
                        : 'all',
              })
            }
          >
            <option value="all">All wanted cards</option>
            <option value="ordered">On order</option>
            <option value="placed">Already placed in binder</option>
            <option value="not-placed">Not placed in binder</option>
          </select>
        </label>
        <label>
          Search
          <input
            type="search"
            value={search.q}
            maxLength={200}
            placeholder="Card, set or number"
            onChange={(e) => change({ q: e.target.value })}
          />
        </label>
        <label>
          Sort by
          <select
            value={search.sort}
            onChange={(e) => {
              const value = e.target.value;
              if (value === 'name' || value === 'newest' || value === 'pokedex' || value === 'set')
                change({ sort: value });
            }}
          >
            <option value="name">Card name</option>
            <option value="newest">Recently wanted</option>
            <option value="pokedex">Pokédex number</option>
            <option value="set">Set and number</option>
          </select>
        </label>
      </div>
      <label className="wanted-toggle">
        <input
          type="checkbox"
          checked={normalized.includeUnfilled}
          disabled={!canInclude}
          onChange={(e) => change({ includeUnfilled: e.target.checked })}
        />
        {canInclude
          ? 'Include unfilled targets for this binder'
          : 'Include unfilled targets (choose a binder)'}
      </label>
      <p className="wanted-help">
        Wanted marks stay until you remove them. Owning or placing a card does not clear your list.
      </p>
      {mutation.isError ? <p role="alert">Could not update the wanted list. Try again.</p> : null}
      {needsBinders && binders.isError ? (
        <p role="alert">
          Binders could not load.{' '}
          <button type="button" onClick={() => void binders.refetch()}>
            Try again
          </button>
        </p>
      ) : list.isPending ? (
        <p role="status">Loading wanted cards…</p>
      ) : list.isError && !list.data ? (
        <p role="alert">
          The shopping list could not load.{' '}
          <button type="button" onClick={() => void list.refetch()}>
            Try again
          </button>
        </p>
      ) : (
        <>
          <p role="status">
            {total} {total === 1 ? 'item' : 'items'}
            {normalized.includeUnfilled ? ' · including unfilled targets' : ''}
          </p>
          {entries.length === 0 ? (
            <div className="wanted-empty">
              <h2>No matching wants</h2>
              <p>
                Open a card and mark it as wanted for General or a binder. You can also include
                unfilled binder targets above.
              </p>
              <Link to="/catalogue" search={catalogueSearch.parse({})}>
                Find cards
              </Link>
            </div>
          ) : (
            <ul className="wanted-grid">
              {entries.map((entry) => (
                <li key={entry.key} className="wanted-item">
                  <div className="wanted-art">
                    <CardFrame
                      state={
                        entry.orderedCount
                          ? 'ordered'
                          : entry.ownedQuantity > 0
                            ? 'owned'
                            : 'unowned'
                      }
                      variant={entry.cardId ? 'card' : 'any'}
                      onView={entry.cardId ? () => setInspected(entry) : undefined}
                      card={
                        entry.card
                          ? frameCardFrom(entry.card)
                          : entry.pokedexNumber && !entry.cardId
                            ? anyFrameCard(entry.pokedexNumber)
                            : {
                                id: entry.key,
                                name: entry.name,
                                frameType: null,
                                rarityKey: null,
                                setCode: null,
                                number: entry.number,
                                pokedexNumber: entry.pokedexNumber,
                                imageUrl: entry.imageLowUrl,
                              }
                      }
                    />
                  </div>
                  <div className="wanted-details">
                    {entry.binderId ? (
                      <Link
                        className="wanted-scope"
                        to="/binders/$binderId"
                        params={{ binderId: entry.binderId }}
                        search={{ page: 1, q: entry.targetKind === 'pokemon' ? entry.name : '' }}
                      >
                        {entry.binderName ?? 'Binder'}
                      </Link>
                    ) : (
                      <span className="wanted-scope">General</span>
                    )}
                    {entry.manual && entry.cardId ? (
                      <button
                        type="button"
                        className="wanted-remove"
                        disabled={mutation.isPending}
                        onClick={() =>
                          mutation.mutate({
                            cardId: entry.cardId ?? '',
                            binderId: entry.binderId,
                            wanted: false,
                          })
                        }
                        aria-label={`Remove ${entry.name} from ${entry.binderName ?? 'General'} wanted list`}
                      >
                        Remove
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <InfiniteLoader
            paused={inspected !== null}
            hasMore={list.hasNextPage ?? false}
            loading={list.isFetchingNextPage ?? false}
            loadedCount={entries.length}
            error={list.isFetchNextPageError ? 'More wanted cards could not load.' : null}
            onLoadMore={() => void list.fetchNextPage({ cancelRefetch: false })}
          />
        </>
      )}
      {inspected?.cardId ? (
        <WantedInspector
          key={inspected.key}
          cardId={inspected.cardId}
          binderId={inspected.binderId}
          onClose={() => setInspected(null)}
        />
      ) : null}
    </section>
  );
}

function WantedInspector({
  cardId,
  binderId,
  onClose,
}: {
  cardId: string;
  binderId: string | null;
  onClose: () => void;
}): ReactElement {
  const [dirty, setDirty] = useState(false);
  const toast = useToast();
  function close() {
    if (dirty) {
      toast(
        'error',
        'Notes are still saving. Wait a moment, or fix the save error, then try again.',
      );
      return;
    }
    onClose();
  }
  return (
    <SidePanel open onClose={close} title="Card">
      <CardInspector
        cardId={cardId}
        onClose={close}
        onDirtyChange={setDirty}
        context={{ from: 'wanted', ...(binderId ? { binderId } : {}) }}
      />
    </SidePanel>
  );
}
