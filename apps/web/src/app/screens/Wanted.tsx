import { useEffect, type ReactElement } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { anyFrameCard, frameCardFrom } from './binders/model';
import { catalogueSearch } from '../routes/search-params';
import { useBinders } from '../api/queries/binders';
import {
  useWantedList,
  useSetWanted,
  wantedPrinting,
  type WantedFilters,
} from '../api/queries/wanted';
import { CardFrame } from '../cards/CardFrame';
import './wanted.css';
export function Wanted({
  search,
  onSearch,
}: {
  search: WantedFilters;
  onSearch: (search: WantedFilters) => void;
}): ReactElement {
  const binders = useBinders();
  const navigate = useNavigate();
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
                  e.target.value === 'placed'
                    ? 'placed'
                    : e.target.value === 'not-placed'
                      ? 'not-placed'
                      : 'all',
              })
            }
          >
            <option value="all">All wanted cards</option>
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
      ) : list.isError ? (
        <p role="alert">
          The shopping list could not load.{' '}
          <button type="button" onClick={() => void list.refetch()}>
            Try again
          </button>
        </p>
      ) : (
        <>
          <p role="status">
            {list.data.total} {list.data.total === 1 ? 'item' : 'items'}
            {normalized.includeUnfilled ? ' · including unfilled targets' : ''}
          </p>
          {list.data.entries.length === 0 ? (
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
              {list.data.entries.map((entry) => (
                <li key={entry.key} className="wanted-item">
                  <div className="wanted-art">
                    <CardFrame
                      state={entry.ownedQuantity > 0 ? 'owned' : 'unowned'}
                      variant={entry.cardId ? 'card' : 'any'}
                      onView={
                        entry.cardId
                          ? () =>
                              void navigate({
                                to: '/card/$cardId',
                                params: { cardId: entry.cardId! },
                              })
                          : undefined
                      }
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
                    <h2>{entry.name}</h2>
                    {entry.cardId ? (
                      <p>{wantedPrinting(entry)}</p>
                    ) : (
                      <p>
                        Any{' '}
                        {entry.targetKind === 'pokemon'
                          ? 'printing'
                          : entry.targetKind === 'set'
                            ? 'card from this set'
                            : `matching ${entry.targetKind} card`}
                      </p>
                    )}
                    <p className="wanted-scope">
                      {entry.binderName ?? 'General'} ·{' '}
                      {entry.manual ? 'Wanted' : 'Unfilled target'}
                    </p>
                    {entry.unfilled > 0 ? (
                      <p>
                        {entry.unfilled} unfilled {entry.unfilled === 1 ? 'pocket' : 'pockets'}
                      </p>
                    ) : null}
                    {entry.cardId ? <p>{entry.ownedQuantity} owned</p> : null}
                    {entry.placedCount > 0 ? (
                      <p className="wanted-scope">
                        {entry.placedCount} placed{' '}
                        {entry.binderId ? 'in this binder' : 'in your binders'}
                      </p>
                    ) : null}
                    <div className="wanted-item-actions">
                      {entry.cardId ? (
                        <Link to="/card/$cardId" params={{ cardId: entry.cardId }}>
                          Card details
                        </Link>
                      ) : entry.binderId ? (
                        <Link
                          to="/binders/$binderId"
                          params={{ binderId: entry.binderId }}
                          search={{ page: 1, q: entry.targetKind === 'pokemon' ? entry.name : '' }}
                        >
                          Open binder
                        </Link>
                      ) : null}
                      {entry.manual && entry.cardId ? (
                        <button
                          type="button"
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
                          Remove want
                        </button>
                      ) : null}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <nav className="wanted-pagination" aria-label="Shopping list pages">
            <button
              type="button"
              disabled={search.offset === 0}
              onClick={() => change({ offset: Math.max(0, search.offset - 100) })}
            >
              Previous
            </button>
            <span>Page {Math.floor(search.offset / 100) + 1}</span>
            <button
              type="button"
              disabled={list.data.nextOffset === null}
              onClick={() =>
                list.data.nextOffset !== null && change({ offset: list.data.nextOffset })
              }
            >
              Next
            </button>
          </nav>
        </>
      )}
    </section>
  );
}
