import { useNavigate } from '@tanstack/react-router';
import { useMemo, type ReactElement } from 'react';
import { useIllustrators } from '../api/queries/illustrators';
import { CardFrame } from '../cards/CardFrame';
import {
  catalogueSearch,
  type IllustratorSortOrder,
  type IllustratorsSearch,
} from '../routes/search-params';
import { EmptyState } from '../ui/EmptyState';
import { SegmentedControl } from '../ui/SegmentedControl';
import { CardFrameSkeleton } from '../ui/Skeleton';
import './illustrators/illustrators.css';

export function Illustrators({ search }: { search: IllustratorsSearch }): ReactElement {
  const navigate = useNavigate({ from: '/illustrators' });
  const illustrators = useIllustrators();

  function updateSearch(patch: Partial<IllustratorsSearch>): void {
    void navigate({ search: (prev) => ({ ...prev, ...patch }) });
  }

  function openIllustrator(name: string): void {
    void navigate({ to: '/catalogue', search: catalogueSearch.parse({ artist: name }) });
  }

  const needle = search.q.trim().toLocaleLowerCase('en-AU');
  const filtered = useMemo(() => {
    const list = (illustrators.data ?? []).filter((entry) =>
      needle ? entry.name.toLocaleLowerCase('en-AU').includes(needle) : true,
    );
    return list
      .slice()
      .sort((a, b) =>
        search.sort === 'card-count'
          ? b.cardCount - a.cardCount || a.name.localeCompare(b.name, 'en-AU')
          : a.name.localeCompare(b.name, 'en-AU'),
      );
  }, [illustrators.data, needle, search.sort]);

  return (
    <div className="illustrators-screen">
      <header className="page-heading">
        <div>
          <h1>Illustrators</h1>
          <p>Every artist, one of their cards.</p>
        </div>
      </header>

      <form
        className="illustrators-toolbar"
        role="search"
        onSubmit={(event) => event.preventDefault()}
      >
        <label>
          Find an illustrator
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
        {(illustrators.data ?? []).length.toLocaleString('en-AU')} illustrators.
      </p>

      {illustrators.isError ? (
        <EmptyState
          icon="illustrator"
          title="Nothing to show yet."
          description="Illustrators could not load."
        />
      ) : illustrators.isLoading ? (
        <div className="illustrators-grid">
          {Array.from({ length: 12 }, (_, index) => (
            <CardFrameSkeleton key={index} />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState icon="illustrator" title="No illustrators match this search." />
      ) : (
        <div className="illustrators-grid">
          {filtered.map((entry) => (
            <button
              key={entry.name}
              type="button"
              className="illustrator-tile"
              onClick={() => openIllustrator(entry.name)}
            >
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
                {entry.ownedCount.toLocaleString('en-AU')} /{' '}
                {entry.cardCount.toLocaleString('en-AU')}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
