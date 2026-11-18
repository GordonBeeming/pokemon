import { TRAINER_REGIONS } from '@pokedex/shared';
import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { useTrainerDex } from '../api/queries/trainer-dex';
import { CardFrame } from '../cards/CardFrame';
import { catalogueSearch, pokedexSearch, trainersSearch } from '../routes/search-params';
import type { TrainerDexSearch } from '../routes/trainer-dex';
import { SelectField } from '../ui/SelectField';
import { Pagination } from './catalogue/Pagination';
import './trainer-dex.css';
const PAGE_SIZE = 50;
export function TrainerDex({
  search,
  onSearch,
}: {
  search: TrainerDexSearch;
  onSearch: (search: TrainerDexSearch) => void;
}): ReactElement {
  const trainers = useTrainerDex();
  const needle = search.q.trim().toLocaleLowerCase('en-AU');
  const filtered = (trainers.data ?? []).filter(
    (t) =>
      (!search.available || t.cardCount > 0) &&
      (search.region === 'all' || t.regions.includes(search.region)) &&
      (!needle || `${t.name} ${t.regions.join(' ')}`.toLocaleLowerCase('en-AU').includes(needle)),
  );
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(search.page, totalPages);
  const entries = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  function change(patch: Partial<TrainerDexSearch>) {
    onSearch({ ...search, ...patch, page: patch.page ?? 1 });
  }
  return (
    <section className="trainer-dex">
      <header className="trainer-dex-header">
        <div>
          <h1>Trainer Dex</h1>
          <p>Trainers by region. Open a person to choose from their English Trainer cards.</p>
        </div>
        <nav aria-label="Related directories">
          <Link to="/pokedex" search={pokedexSearch.parse({})}>
            Pokémon
          </Link>
          <Link to="/trainers" search={trainersSearch.parse({})}>
            Trainer’s Pokémon
          </Link>
        </nav>
      </header>
      <div className="trainer-dex-filters">
        <label>
          Find a trainer
          <input
            type="search"
            value={search.q}
            maxLength={200}
            placeholder="Brock, Misty, Cynthia…"
            onChange={(e) => change({ q: e.target.value })}
          />
        </label>
        <SelectField
          label="Region"
          value={search.region}
          options={[
            { value: 'all', label: 'All regions' },
            ...TRAINER_REGIONS.map((region) => ({ value: region, label: region })),
          ]}
          onChange={(region) => change({ region })}
        />
        <label className="trainer-dex-toggle">
          <input
            type="checkbox"
            checked={search.available}
            onChange={(e) => change({ available: e.target.checked })}
          />
          With cards in the catalogue
        </label>
      </div>
      {trainers.isPending ? (
        <p role="status">Loading trainers…</p>
      ) : trainers.isError ? (
        <p role="alert">
          Trainers could not load.{' '}
          <button type="button" onClick={() => void trainers.refetch()}>
            Try again
          </button>
        </p>
      ) : (
        <>
          <p className="trainer-dex-count" role="status">
            {filtered.length} trainers{search.region === 'all' ? '' : ` · ${search.region}`}
          </p>
          {entries.length ? (
            <ul className="trainer-dex-grid">
              {entries.map((trainer) => (
                <li key={trainer.key}>
                  <Link
                    to="/catalogue"
                    search={catalogueSearch.parse({ character: trainer.key, language: 'en' })}
                    className="trainer-dex-card"
                    aria-label={`${trainer.name}, ${trainer.regions.join(', ')}, ${trainer.cardCount} card variants`}
                  >
                    <CardFrame
                      card={{
                        id: trainer.key,
                        name: trainer.name,
                        frameType: null,
                        setCode: null,
                        number: null,
                        rarityKey: null,
                        pokedexNumber: null,
                        imageUrl: trainer.representative?.imageLowUrl ?? null,
                      }}
                      frame={false}
                      forceSolid
                      state={trainer.ownedCount ? 'owned' : 'unowned'}
                    />
                    <strong>{trainer.name}</strong>
                    <span className="trainer-dex-region">{trainer.regions.join(' · ')}</span>
                    <span>
                      {trainer.cardCount
                        ? `${trainer.ownedCount} / ${trainer.cardCount} printings owned`
                        : 'No English printings in the catalogue'}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <div className="trainer-dex-empty">
              <h2>No matching trainers</h2>
              <p>Try another region or name, or show trainers without cards.</p>
            </div>
          )}
          <Pagination
            page={page}
            totalPages={totalPages}
            pending={false}
            label="Trainer pages"
            onPage={(page) => change({ page })}
          />
        </>
      )}
    </section>
  );
}
