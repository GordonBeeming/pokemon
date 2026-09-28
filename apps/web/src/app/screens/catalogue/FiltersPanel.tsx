import {
  FRAME_TYPES,
  POKEMON_DISCOVERY_CATEGORIES,
  RARITY_KEYS,
  RARITY_LABELS,
  type FrameType,
} from '@pokedex/shared';
import { useState, type ReactElement } from 'react';
import { useSets } from '../../api/queries/sets';
import { RARITY_VISUALS } from '../../cards/rarity-visuals';
import { catalogueSortOrders, type CatalogueSearch } from '../../routes/search-params';
import { SelectField } from '../../ui/SelectField';

const ANY_REGION = 'any';

export const FRAME_TYPE_LABELS: Record<FrameType, string> = {
  grass: 'Grass',
  fire: 'Fire',
  water: 'Water',
  lightning: 'Lightning',
  psychic: 'Psychic',
  fighting: 'Fighting',
  darkness: 'Darkness',
  metal: 'Metal',
  dragon: 'Dragon',
  fairy: 'Fairy',
  colorless: 'Colorless',
  trainer: 'Trainer',
  energy: 'Energy',
  'special-energy': 'Special energy',
};

// Only these two sort orders have a server-side implementation
// (worker/routes/api/operations.ts's `catalogueFilters` only special-cases
// `sort=release`; everything else falls back to its default set/number order) — the
// schema's other values (`pokedex-number`, `name`) aren't offered here since there
// is nothing for them to actually change server-side yet.
const SORT_OPTIONS: Array<{ value: (typeof catalogueSortOrders)[number]; label: string }> = [
  { value: 'relevance', label: 'Set number' },
  { value: 'release-date', label: 'Release date' },
];

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

export function FiltersPanel({
  filters,
  onChange,
}: {
  filters: CatalogueSearch;
  onChange: (patch: Partial<CatalogueSearch>) => void;
}): ReactElement {
  const sets = useSets();
  const [setQuery, setSetQuery] = useState('');
  const matchingSets = (sets.data ?? []).filter((set) =>
    set.setName.toLocaleLowerCase('en-AU').includes(setQuery.trim().toLocaleLowerCase('en-AU')),
  );

  return (
    <div className="filters-panel">
      <fieldset>
        <legend>Set</legend>
        <input
          type="search"
          placeholder="Find a set"
          value={setQuery}
          onChange={(event) => setSetQuery(event.target.value)}
        />
        <div className="filters-panel-list">
          {matchingSets.map((set) => (
            <label key={`${set.setId}:${set.language}`}>
              <input
                type="checkbox"
                checked={filters.set.includes(set.setId)}
                onChange={() => onChange({ set: toggle(filters.set, set.setId), page: 1 })}
              />
              {set.setName}
            </label>
          ))}
          {sets.isLoading ? <p>Loading sets…</p> : null}
        </div>
      </fieldset>

      <SelectField
        className="filters-panel-select"
        label="First found region"
        value={filters.region ?? ANY_REGION}
        options={[
          { value: ANY_REGION, label: 'Any region' },
          ...POKEMON_DISCOVERY_CATEGORIES.map((region) => ({ value: region, label: region })),
        ]}
        onChange={(region) =>
          onChange({ region: region === ANY_REGION ? undefined : region, page: 1 })
        }
      />

      <fieldset>
        <legend>Card type</legend>
        <div className="filters-panel-list">
          {FRAME_TYPES.map((type) => (
            <label key={type}>
              <input
                type="checkbox"
                checked={filters.type.includes(type)}
                onChange={() => onChange({ type: toggle(filters.type, type), page: 1 })}
              />
              {FRAME_TYPE_LABELS[type]}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend>Rarity</legend>
        <div className="filters-panel-list">
          {RARITY_KEYS.map((key) => (
            <label key={key}>
              <input
                type="checkbox"
                checked={filters.rarity.includes(key)}
                onChange={() => onChange({ rarity: toggle(filters.rarity, key), page: 1 })}
              />
              <span aria-hidden="true" className="filters-panel-rarity-icon">
                {RARITY_VISUALS[key].icon}
              </span>
              {RARITY_LABELS[key]}
            </label>
          ))}
        </div>
      </fieldset>

      <SelectField
        className="filters-panel-select"
        label="Order"
        value={filters.sort}
        options={SORT_OPTIONS}
        onChange={(sort) => onChange({ sort })}
      />
    </div>
  );
}
