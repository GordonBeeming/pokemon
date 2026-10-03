import { useNavigate } from '@tanstack/react-router';
import { useMemo, type ReactElement } from 'react';
import { useSetTrainerFavorite, useTrainers, type Trainer } from '../api/queries/trainers';
import { CardFrame } from '../cards/CardFrame';
import {
  catalogueSearch,
  type IllustratorSortOrder,
  type TrainersSearch,
} from '../routes/search-params';
import { EmptyState } from '../ui/EmptyState';
import { Icon } from '../ui/icons';
import { SegmentedControl } from '../ui/SegmentedControl';
import { CardFrameSkeleton } from '../ui/Skeleton';
import './illustrators/illustrators.css';

/** Trainers whose Pokémon have their own cards ("Lillie's Comfey"), laid out like
 * Illustrators: favourites first, one card each, owned / total. */
export function Trainers({ search }: { search: TrainersSearch }): ReactElement {
  const navigate = useNavigate({ from: '/trainers' });
  const trainers = useTrainers();
  const setFavorite = useSetTrainerFavorite();

  function updateSearch(patch: Partial<TrainersSearch>): void {
    void navigate({ search: (prev) => ({ ...prev, ...patch }) });
  }

  function openTrainer(key: string): void {
    void navigate({ to: '/catalogue', search: catalogueSearch.parse({ trainer: key }) });
  }

  const needle = search.q.trim().toLocaleLowerCase('en-AU');
  const filtered = useMemo(
    () =>
      (trainers.data ?? [])
        .filter((entry) => (needle ? entry.name.toLocaleLowerCase('en-AU').includes(needle) : true))
        .sort((a, b) =>
          search.sort === 'card-count'
            ? b.cardCount - a.cardCount || a.name.localeCompare(b.name, 'en-AU')
            : a.name.localeCompare(b.name, 'en-AU'),
        ),
    [trainers.data, needle, search.sort],
  );
  const favorites = filtered.filter((entry) => entry.favorite);
  const others = filtered.filter((entry) => !entry.favorite);

  function tile(entry: Trainer): ReactElement {
    return (
      <li key={entry.key} className="illustrator-tile">
        <button type="button" className="illustrator-open" onClick={() => openTrainer(entry.key)}>
          <CardFrame
            card={{
              id: entry.representative.id,
              name: entry.name,
              frameType: entry.representative.frameType,
              setCode: entry.representative.setCode,
              number: entry.representative.number,
              rarityKey: entry.representative.rarityKey,
              pokedexNumber: entry.representative.pokedexNumber,
              imageUrl: entry.representative.imageLowUrl,
            }}
            state={entry.ownedCount > 0 ? 'owned' : 'unowned'}
          />
          <span className="illustrator-name">{entry.name}</span>
          <span className="illustrator-count">
            {entry.ownedCount.toLocaleString('en-AU')} / {entry.cardCount.toLocaleString('en-AU')}
          </span>
        </button>
        <button
          type="button"
          className="illustrator-favorite"
          aria-pressed={entry.favorite}
          aria-label={entry.favorite ? `Unfavourite ${entry.name}` : `Favourite ${entry.name}`}
          title={entry.favorite ? 'Unfavourite' : 'Favourite'}
          onClick={() => setFavorite.mutate({ key: entry.key, favorite: !entry.favorite })}
        >
          <Icon name="star" />
        </button>
      </li>
    );
  }

  return (
    <div className="illustrators-screen">
      <header className="page-heading">
        <div>
          <h1>Trainers</h1>
          <p>Every trainer’s Pokémon, one of their cards.</p>
        </div>
      </header>

      <form
        className="illustrators-toolbar"
        role="search"
        onSubmit={(event) => event.preventDefault()}
      >
        <label>
          Find a trainer
          <input
            type="search"
            value={search.q}
            placeholder="Name"
            onChange={(event) => updateSearch({ q: event.target.value })}
          />
        </label>
        <SegmentedControl<IllustratorSortOrder>
          label="Sort"
          value={search.sort}
          options={[
            { value: 'name', label: 'A–Z' },
            { value: 'card-count', label: 'Most cards' },
          ]}
          onChange={(sort) => updateSearch({ sort })}
        />
      </form>
      <p className="live-status" role="status" aria-live="polite" aria-atomic="true">
        Showing {filtered.length.toLocaleString('en-AU')} of{' '}
        {(trainers.data ?? []).length.toLocaleString('en-AU')} trainers.
      </p>

      {trainers.isError ? (
        <EmptyState
          icon="people"
          title="Nothing to show yet."
          description="Trainers could not load."
        />
      ) : trainers.isLoading ? (
        <div className="illustrators-grid">
          {Array.from({ length: 12 }, (_, index) => (
            <CardFrameSkeleton key={index} />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState icon="people" title="No trainers match this search." />
      ) : (
        <>
          {favorites.length > 0 ? (
            <section aria-labelledby="trainers-favorites-heading">
              <h2 id="trainers-favorites-heading" className="illustrators-group-heading">
                <Icon name="star" /> Favourites
              </h2>
              <ul className="illustrators-grid">{favorites.map(tile)}</ul>
            </section>
          ) : null}
          {others.length > 0 ? (
            <section aria-labelledby="trainers-all-heading">
              <h2
                id="trainers-all-heading"
                className={favorites.length > 0 ? 'illustrators-group-heading' : 'sr-only'}
              >
                {favorites.length > 0 ? 'Everyone else' : 'All trainers'}
              </h2>
              <ul className="illustrators-grid">{others.map(tile)}</ul>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
