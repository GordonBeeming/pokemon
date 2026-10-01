import { formatDexNumber, languageSchema } from '@pokedex/shared';
import { useState, type ReactElement } from 'react';
import { useSets } from '../../../api/queries/sets';
import { SegmentedControl } from '../../../ui/SegmentedControl';
import { binderErrorMessage } from '../model';
import { filterPokemon, filterSets } from './InsertPanel';
import { Panel } from './Panel';

export type PageFillTarget =
  | { kind: 'pokemon'; pokemonNumber: number }
  | { kind: 'set'; setId: string; setLanguage: ReturnType<typeof languageSchema.parse> };

type Kind = PageFillTarget['kind'];
const PAGE_SIZE = 40;

/**
 * Reserves a page for one thing: every empty pocket on it becomes the same any-card
 * target (any printing of a Pokémon, or any card from a set). Pockets that already hold
 * something are left alone and nothing on other pages moves.
 */
export function PageFillPanel({
  emptyPockets,
  pending,
  error,
  onFill,
  onClose,
}: {
  emptyPockets: number;
  pending: boolean;
  error: string | null;
  onFill: (target: PageFillTarget, name: string) => void;
  onClose: () => void;
}): ReactElement {
  const sets = useSets();
  const [kind, setKind] = useState<Kind>('set');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [chosen, setChosen] = useState<{
    key: string;
    target: PageFillTarget;
    name: string;
  } | null>(null);
  const pokemon = kind === 'pokemon' ? filterPokemon(query) : [];
  const matchingSets = kind === 'set' ? filterSets(sets.data ?? [], query) : [];
  const total = kind === 'pokemon' ? pokemon.length : matchingSets.length;
  const pockets = `${emptyPockets} empty ${emptyPockets === 1 ? 'pocket' : 'pockets'}`;

  return (
    <Panel title="Reserve page for" onClose={onClose} wide>
      <p className="panel-lead">
        {emptyPockets > 0
          ? `The ${pockets} on this page will take any card that fits. Nothing else moves.`
          : 'This page has no empty pockets to reserve.'}
      </p>
      <SegmentedControl<Kind>
        label="Reserve for"
        value={kind}
        onChange={(value) => {
          setKind(value);
          setQuery('');
          setOffset(0);
          setChosen(null);
        }}
        options={[
          { value: 'set', label: 'A set' },
          { value: 'pokemon', label: 'A Pokémon' },
        ]}
      />
      <label className="panel-field">
        <span>{kind === 'set' ? 'Search sets' : 'Search Pokémon'}</span>
        <input
          type="search"
          value={query}
          placeholder={kind === 'set' ? 'Set name or code' : 'Name or Pokédex number'}
          onChange={(event) => {
            setQuery(event.target.value);
            setOffset(0);
          }}
        />
      </label>
      {kind === 'set' && sets.isError ? (
        <p role="alert" className="panel-error">
          {binderErrorMessage(sets.error)}
        </p>
      ) : null}
      <div
        className="species-grid"
        aria-label={kind === 'set' ? 'Matching sets' : 'Matching Pokémon'}
      >
        {kind === 'set'
          ? matchingSets.slice(offset, offset + PAGE_SIZE).flatMap((set) => {
              const language = languageSchema.safeParse(set.language);
              if (!language.success) return [];
              const key = `${set.language}:${set.setId}`;
              return [
                <button
                  key={key}
                  type="button"
                  className="species-option"
                  aria-pressed={chosen?.key === key}
                  disabled={pending}
                  onClick={() =>
                    setChosen({
                      key,
                      target: { kind: 'set', setId: set.setId, setLanguage: language.data },
                      name: set.setName,
                    })
                  }
                >
                  <span>{set.setName}</span>
                  <small>
                    {set.total.toLocaleString('en-AU')} {set.total === 1 ? 'card' : 'cards'}
                    {set.language === 'en' ? '' : ` · ${set.language.toUpperCase()}`}
                  </small>
                </button>,
              ];
            })
          : pokemon.slice(offset, offset + PAGE_SIZE).map((item) => (
              <button
                key={item.number}
                type="button"
                className="species-option"
                aria-pressed={chosen?.key === String(item.number)}
                disabled={pending}
                onClick={() =>
                  setChosen({
                    key: String(item.number),
                    target: { kind: 'pokemon', pokemonNumber: item.number },
                    name: item.name,
                  })
                }
              >
                <span className="species-option-number">{formatDexNumber(item.number)}</span>
                <span>{item.name}</span>
                <small>{item.discoveryCategory}</small>
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
          {kind === 'set' && sets.isLoading ? 'Loading sets…' : `${total} matches`}
        </span>
        <button
          type="button"
          disabled={offset + PAGE_SIZE >= total}
          onClick={() => setOffset(offset + PAGE_SIZE)}
        >
          Next results
        </button>
      </nav>
      <footer className="panel-footer">
        {error ? (
          <p role="alert" className="panel-error">
            {error}
          </p>
        ) : null}
        <p role="status">
          {chosen ? `${pockets} for any ${chosen.name}.` : 'Choose what this page is for.'}
        </p>
        <button
          type="button"
          className="button-primary"
          disabled={pending || !chosen || emptyPockets === 0}
          onClick={() => {
            if (chosen) onFill(chosen.target, chosen.name);
          }}
        >
          Reserve {pockets}
        </button>
      </footer>
    </Panel>
  );
}
