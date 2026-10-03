import { ENERGY_GROUPS, energyGroupName, type EnergyGroup } from '@pokedex/shared';
import { useState, type ReactElement } from 'react';
import { useIllustrators } from '../../../api/queries/illustrators';
import { useTrainers } from '../../../api/queries/trainers';
import { Icon } from '../../../ui/icons';
import { binderErrorMessage } from '../model';

export type GroupKind = 'illustrator' | 'trainer';

export interface GroupChoice {
  key: string;
  name: string;
  cardCount: number;
  favorite: boolean;
}

const PAGE_SIZE = 40;

/** Favourites first, then A–Z, narrowed by a name search. */
export function sortGroups(groups: readonly GroupChoice[], query: string): GroupChoice[] {
  const needle = query.trim().toLocaleLowerCase('en-AU');
  return groups
    .filter((group) => !needle || group.name.toLocaleLowerCase('en-AU').includes(needle))
    .sort(
      (a, b) =>
        Number(b.favorite) - Number(a.favorite) ||
        a.name.localeCompare(b.name, 'en-AU', { sensitivity: 'base' }),
    );
}

/**
 * Picks one illustrator or trainer: a search box and a grid of names, favourites
 * first, the same look as the set and Pokémon lists beside it.
 */
export function GroupPicker({
  kind,
  selectedKey,
  pending,
  onSelect,
}: {
  kind: GroupKind;
  selectedKey: string | null;
  pending: boolean;
  onSelect: (group: GroupChoice) => void;
}): ReactElement {
  const illustrators = useIllustrators({ enabled: kind === 'illustrator' });
  const trainers = useTrainers({ enabled: kind === 'trainer' });
  const source = kind === 'illustrator' ? illustrators : trainers;
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const groups = sortGroups(
    (source.data ?? []).map((group) => ({
      key: group.key,
      name: group.name,
      cardCount: group.cardCount,
      favorite: group.favorite,
    })),
    query,
  );
  const noun = kind === 'illustrator' ? 'illustrators' : 'trainers';
  return (
    <>
      <label className="panel-field">
        <span>{kind === 'illustrator' ? 'Search illustrators' : 'Search trainers'}</span>
        <input
          type="search"
          value={query}
          placeholder="Name"
          onChange={(event) => {
            setQuery(event.target.value);
            setOffset(0);
          }}
        />
      </label>
      {source.isError ? (
        <p role="alert" className="panel-error">
          {binderErrorMessage(source.error)}
        </p>
      ) : null}
      <div className="species-grid" aria-label={`Matching ${noun}`}>
        {groups.slice(offset, offset + PAGE_SIZE).map((group) => (
          <button
            key={group.key}
            type="button"
            className="species-option"
            aria-pressed={selectedKey === group.key}
            disabled={pending}
            onClick={() => onSelect(group)}
          >
            <span>
              {group.favorite ? <Icon name="star" title="Favourite" /> : null} {group.name}
            </span>
            <small>
              {group.cardCount.toLocaleString('en-AU')} {group.cardCount === 1 ? 'card' : 'cards'}
            </small>
          </button>
        ))}
      </div>
      <nav className="panel-actions" aria-label="Search result pages">
        <button
          type="button"
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
        >
          Previous results
        </button>
        <span className="panel-help">
          {source.isLoading ? `Loading ${noun}…` : `${groups.length} ${noun}`}
        </span>
        <button
          type="button"
          disabled={offset + PAGE_SIZE >= groups.length}
          onClick={() => setOffset(offset + PAGE_SIZE)}
        >
          Next results
        </button>
      </nav>
    </>
  );
}

/** Picks an energy group: any energy, one basic type, or special energy. */
export function EnergyPicker({
  selected,
  pending,
  onSelect,
}: {
  selected: EnergyGroup | null;
  pending: boolean;
  onSelect: (group: EnergyGroup) => void;
}): ReactElement {
  return (
    <div className="species-grid" aria-label="Energy">
      {ENERGY_GROUPS.map((group) => (
        <button
          key={group}
          type="button"
          className="species-option"
          aria-pressed={selected === group}
          disabled={pending}
          onClick={() => onSelect(group)}
        >
          <span>{energyGroupName(group)}</span>
        </button>
      ))}
    </div>
  );
}
