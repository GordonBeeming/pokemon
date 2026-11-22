import { TRAINER_REGIONS, type TrainerDexEntry } from '@pokedex/shared';
import { useState, type ReactElement } from 'react';
import { useTrainerDex } from '../../../api/queries/trainer-dex';
import { InfiniteLoader } from '../../../ui/InfiniteLoader';
import { binderErrorMessage } from '../model';

/** The people in Trainer Dex, distinct from the owners of Trainer Pokémon. */
export function TrainerDexPicker({
  pending,
  onSelect,
}: {
  pending: boolean;
  onSelect: (trainer: TrainerDexEntry) => void;
}): ReactElement {
  const trainers = useTrainerDex();
  const [query, setQuery] = useState('');
  const [region, setRegion] = useState('all');
  const [limit, setLimit] = useState(40);
  const needle = query.trim().toLocaleLowerCase('en-AU');
  const matches = (trainers.data ?? []).filter(
    (trainer) =>
      trainer.cardCount > 0 &&
      (region === 'all' || trainer.regions.some((value) => value === region)) &&
      (!needle || trainer.name.toLocaleLowerCase('en-AU').includes(needle)),
  );
  return (
    <>
      <p className="panel-help">
        Choose a person from Trainer Dex, then select their English Trainer card variants.
      </p>
      <label className="panel-field">
        <span>Search Trainer Dex</span>
        <input
          type="search"
          placeholder="Brock, Misty, Cynthia…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setLimit(40);
          }}
        />
      </label>
      <label className="panel-field">
        <span>Trainer region</span>
        <select
          value={region}
          onChange={(event) => {
            setRegion(event.target.value);
            setLimit(40);
          }}
        >
          <option value="all">All regions</option>
          {TRAINER_REGIONS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      {trainers.isError ? (
        <p role="alert" className="panel-error">
          {binderErrorMessage(trainers.error)}{' '}
          <button type="button" onClick={() => void trainers.refetch()}>
            Try again
          </button>
        </p>
      ) : null}
      <div className="species-grid" role="group" aria-label="Matching Trainer Dex characters">
        {matches.slice(0, limit).map((trainer) => (
          <button
            type="button"
            className="species-option"
            key={trainer.key}
            disabled={pending}
            onClick={() => onSelect(trainer)}
          >
            <span>{trainer.name}</span>
            <small>
              {trainer.regions.join(' · ')} · {trainer.cardCount}{' '}
              {trainer.cardCount === 1 ? 'card' : 'cards'}
            </small>
          </button>
        ))}
      </div>
      {!trainers.isError ? (
        <p className="panel-help" role="status">
          {trainers.isPending ? 'Loading Trainer Dex…' : `${matches.length} trainers with cards`}
        </p>
      ) : null}
      <InfiniteLoader
        hasMore={limit < matches.length}
        loading={trainers.isPending}
        loadedCount={Math.min(limit, matches.length)}
        label="trainers"
        onLoadMore={() => setLimit((value) => value + 40)}
      />
    </>
  );
}
