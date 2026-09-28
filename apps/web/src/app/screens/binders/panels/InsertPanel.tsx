import {
  cardIdSchema,
  NATIONAL_POKEDEX,
  type BinderEntry,
  type BinderSlotLocation,
  type FrameType,
} from '@pokedex/shared';
import { useRef, useState, type ReactElement } from 'react';
import { ApiError } from '../../../api/client';
import { useInsertDestinations, type ResolvedCard } from '../../../api/queries/binders';
import { SegmentedControl } from '../../../ui/SegmentedControl';
import { binderErrorMessage, INSERT_SELECTION_CAP, pad4 } from '../model';
import { CardPicker, collectAllCards, type PickerQuery } from './CardPicker';
import { Panel } from './Panel';

type Kind = 'pokemon' | 'exact-card';
const POKEMON_PAGE_SIZE = 40;

function pokemonEntry(pokemonNumber: number): BinderEntry {
  return { kind: 'pokemon', pokemonNumber, startsNewPage: false };
}
function exactEntry(cardId: ResolvedCard['id']): BinderEntry {
  return { kind: 'exact-card', cardId: cardIdSchema.parse(cardId), startsNewPage: false };
}

export function filterPokemon(query: string) {
  const trimmed = query.trim();
  const numberQuery = /^#?0*(\d+)$/u.exec(trimmed);
  const lowered = trimmed.toLocaleLowerCase('en-AU');
  return NATIONAL_POKEDEX.filter((item) =>
    numberQuery
      ? item.number === Number(numberQuery[1])
      : `${item.number} ${item.name} ${item.discoveryCategory}`
          .toLocaleLowerCase('en-AU')
          .includes(lowered),
  );
}

export function destinationText(
  at: BinderSlotLocation | null,
  reservedPage: boolean,
  destinations:
    | { appendAt: BinderSlotLocation | null; requiredCapacity: number; maxCapacity: number }
    | undefined,
  failed: boolean,
): string {
  if (at)
    return `Insert at page ${at.page + 1}, pocket ${at.row + 1}:${at.column + 1}, shifting later targets${reservedPage ? ' on this reserved page only' : ''}.`;
  if (destinations?.appendAt)
    return `Append at page ${destinations.appendAt.page + 1}, pocket ${destinations.appendAt.row + 1}:${destinations.appendAt.column + 1}.`;
  if (destinations)
    return destinations.requiredCapacity > destinations.maxCapacity
      ? `This binder has reached its ${destinations.maxCapacity}-pocket limit. Choose an existing empty sleeve or another binder.`
      : `No room at the end. Grow the binder to at least ${destinations.requiredCapacity} pockets in Manage binder.`;
  if (failed) return 'Could not load the insertion position. Close and reopen this tool to retry.';
  return 'Finding space at the end of the binder…';
}

export function InsertPanel({
  versionId,
  at,
  reservedPage,
  palette,
  pending,
  error,
  shift,
  onInsert,
  onClose,
}: {
  versionId: string;
  at: BinderSlotLocation | null;
  reservedPage: boolean;
  palette: Record<FrameType, string>;
  pending: boolean;
  error: string | null;
  /** Present when the anchor holds a target or reserved sleeve: shifting is offered too. */
  shift?: { onShift: (offset: number) => void };
  onInsert: (at: BinderSlotLocation, entries: BinderEntry[]) => void;
  onClose: () => void;
}): ReactElement {
  const destinations = useInsertDestinations(versionId);
  const [kind, setKind] = useState<Kind>('pokemon');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Map<string, BinderEntry>>(new Map());
  const [message, setMessage] = useState('');
  const [working, setWorking] = useState(false);
  const [exactTotal, setExactTotal] = useState<{ total: number; query: PickerQuery } | null>(null);
  const [shiftBy, setShiftBy] = useState('1');
  const selectAllRequest = useRef<AbortController | null>(null);

  const pokemon = kind === 'pokemon' ? filterPokemon(query) : [];
  const destination = at ?? destinations.data?.appendAt ?? null;
  const busy = pending || working;

  function toggle(key: string, entry: BinderEntry): void {
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(key)) next.delete(key);
      else if (next.size < INSERT_SELECTION_CAP) next.set(key, entry);
      else
        setMessage(
          `Select up to ${INSERT_SELECTION_CAP.toLocaleString('en-AU')} targets at once. Insert these first, then add more.`,
        );
      return next;
    });
  }

  async function selectAllExact(): Promise<void> {
    if (!exactTotal) return;
    selectAllRequest.current?.abort();
    const controller = new AbortController();
    selectAllRequest.current = controller;
    setWorking(true);
    setMessage('');
    try {
      const cards = await collectAllCards(
        exactTotal.query,
        INSERT_SELECTION_CAP,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setSelected(new Map(cards.map((card) => [card.id, exactEntry(card.id)])));
    } catch (cause) {
      if (!controller.signal.aborted)
        setMessage(
          cause instanceof ApiError || !(cause instanceof Error)
            ? binderErrorMessage(cause)
            : cause.message,
        );
    } finally {
      if (!controller.signal.aborted) setWorking(false);
    }
  }

  const shiftValue = Number(shiftBy);
  return (
    <Panel title={at ? 'Insert / shift' : 'Insert targets'} onClose={onClose} wide>
      <p className="panel-lead">
        {destinationText(at, reservedPage, destinations.data, destinations.isError)}
      </p>
      {shift ? (
        <section className="panel-section" aria-labelledby="shift-heading">
          <h3 id="shift-heading">Insert a gap or shift sleeves</h3>
          <p className="panel-help">
            Positive numbers add empty sleeves before this target; negative numbers close an empty
            gap. Later targets move with it.
          </p>
          <div className="panel-inline">
            <label>
              <span>Shift by sleeves</span>
              <input
                type="number"
                step="1"
                value={shiftBy}
                disabled={busy}
                onChange={(event) => setShiftBy(event.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={busy || !Number.isInteger(shiftValue) || shiftValue === 0}
              onClick={() => shift.onShift(shiftValue)}
            >
              Shift targets
            </button>
          </div>
        </section>
      ) : null}
      <section className="panel-section" aria-labelledby="insert-heading">
        <h3 id="insert-heading">Insert targets here</h3>
        <SegmentedControl<Kind>
          label="Target type"
          value={kind}
          onChange={(value) => {
            selectAllRequest.current?.abort();
            setKind(value);
            setQuery('');
            setOffset(0);
            setSelected(new Map());
            setMessage('');
            setExactTotal(null);
          }}
          options={[
            { value: 'pokemon', label: 'Pokémon targets' },
            { value: 'exact-card', label: 'Exact cards' },
          ]}
        />
        {kind === 'pokemon' ? (
          <>
            <label className="panel-field">
              <span>Search targets</span>
              <input
                type="search"
                value={query}
                placeholder="Name, Pokédex number, or region"
                onChange={(event) => {
                  setQuery(event.target.value);
                  setOffset(0);
                }}
              />
            </label>
            <div className="panel-actions">
              <button
                type="button"
                disabled={busy || pokemon.length === 0}
                onClick={() =>
                  setSelected(
                    new Map(
                      pokemon.map((item) => [String(item.number), pokemonEntry(item.number)]),
                    ),
                  )
                }
              >
                Select all {pokemon.length} matches
              </button>
              <button
                type="button"
                className="button-text"
                disabled={busy || selected.size === 0}
                onClick={() => setSelected(new Map())}
              >
                Clear selection
              </button>
            </div>
            <div className="species-grid" aria-label="Matching Pokémon">
              {pokemon.slice(offset, offset + POKEMON_PAGE_SIZE).map((item) => (
                <button
                  key={item.number}
                  type="button"
                  className="species-option"
                  aria-pressed={selected.has(String(item.number))}
                  disabled={busy}
                  onClick={() => toggle(String(item.number), pokemonEntry(item.number))}
                >
                  <span className="species-option-number">#{pad4(item.number)}</span>
                  <span>{item.name}</span>
                  <small>{item.discoveryCategory}</small>
                </button>
              ))}
            </div>
            <nav className="panel-actions" aria-label="Search result pages">
              <button
                type="button"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - POKEMON_PAGE_SIZE))}
              >
                Previous results
              </button>
              <span className="panel-help">{pokemon.length} matches</span>
              <button
                type="button"
                disabled={offset + POKEMON_PAGE_SIZE >= pokemon.length}
                onClick={() => setOffset(offset + POKEMON_PAGE_SIZE)}
              >
                Next results
              </button>
            </nav>
          </>
        ) : (
          <>
            <div className="panel-actions">
              <button
                type="button"
                disabled={busy || !exactTotal || exactTotal.total === 0}
                onClick={() => void selectAllExact()}
              >
                Select all {exactTotal?.total ?? 0} matches
              </button>
              <button
                type="button"
                className="button-text"
                disabled={busy || selected.size === 0}
                onClick={() => setSelected(new Map())}
              >
                Clear selection
              </button>
            </div>
            <CardPicker
              query={{ q: '' }}
              palette={palette}
              pending={busy}
              selectedIds={new Set(selected.keys())}
              onTotal={(total, active) => setExactTotal({ total, query: active })}
              onPick={(card) => toggle(card.id, exactEntry(card.id))}
            />
          </>
        )}
      </section>
      <footer className="panel-footer">
        {error ? (
          <p role="alert" className="panel-error">
            {error}
          </p>
        ) : null}
        <p role="status">
          {working ? 'Working…' : message || `${selected.size} targets selected.`}
        </p>
        <button
          type="button"
          className="button-primary"
          disabled={busy || selected.size === 0 || !destination || !destinations.data}
          onClick={() => {
            if (destination) onInsert(destination, [...selected.values()]);
          }}
        >
          Insert {selected.size || ''} selected {selected.size === 1 ? 'target' : 'targets'}
        </button>
      </footer>
    </Panel>
  );
}
