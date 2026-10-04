import {
  type BinderEntry,
  type BinderSlotLocation,
  cardIdSchema,
  energyGroupName,
  formatDexNumber,
  type EnergyGroup,
  languageSchema,
  type FrameType,
  NATIONAL_POKEDEX,
} from '@pokedex/shared';
import { useRef, useState, type ReactElement } from 'react';
import { ApiError } from '../../../api/client';
import { useInsertDestinations, type ResolvedCard } from '../../../api/queries/binders';
import { useSets, type SetFacet } from '../../../api/queries/sets';
import { SegmentedControl } from '../../../ui/SegmentedControl';
import { binderErrorMessage, INSERT_SELECTION_CAP } from '../model';
import { CardPicker, collectAllCards, type PickerQuery } from './CardPicker';
import { EnergyPicker, GroupPicker, type GroupChoice } from './GroupPicker';
import { Panel } from './Panel';

type Kind = 'pokemon' | 'set' | 'illustrator' | 'trainer' | 'energy' | 'exact-card';
/** A set is inserted as pockets that take any of its cards, or as one target per card. */
type SetMode = 'any' | 'every';
const MAX_ANY_POCKETS = 400;
const POKEMON_PAGE_SIZE = 40;
const SET_PAGE_SIZE = 40;
// "2", "10", "TG05": numbers in card order, letters after.
const cardNumberOrder = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

function setKey(set: SetFacet): string {
  return `${set.language}:${set.setId}`;
}

/** Matching sets, starred ones first (each half keeps release order). */
export function filterSets(sets: readonly SetFacet[], query: string): SetFacet[] {
  const lowered = query.trim().toLocaleLowerCase('en-AU');
  const matching = lowered
    ? sets.filter((set) =>
        `${set.setName} ${set.setId}`.toLocaleLowerCase('en-AU').includes(lowered),
      )
    : [...sets];
  return [
    ...matching.filter((set) => set.favorite === true),
    ...matching.filter((set) => set.favorite !== true),
  ];
}

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
  const sets = useSets();
  const [chosenSet, setChosenSet] = useState<string | null>(null);
  const [setMode, setSetMode] = useState<SetMode>('any');
  // Inserting starts from one pocket; whole pages have "Reserve page for…".
  const [anyCount, setAnyCount] = useState('1');
  const [anySet, setAnySet] = useState<SetFacet | null>(null);
  const [anyGroup, setAnyGroup] = useState<GroupChoice | null>(null);
  const [energy, setEnergy] = useState<EnergyGroup | null>(null);
  const selectAllRequest = useRef<AbortController | null>(null);

  const pokemon = kind === 'pokemon' ? filterPokemon(query) : [];
  const matchingSets = kind === 'set' ? filterSets(sets.data ?? [], query) : [];
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

  /** `count` pockets that each take any card from the set. */
  function selectAnyFromSet(set: SetFacet, countText: string): void {
    selectAllRequest.current?.abort();
    setWorking(false);
    setAnySet(set);
    setChosenSet(setKey(set));
    const language = languageSchema.safeParse(set.language);
    const count = Number(countText);
    if (!language.success || !Number.isInteger(count) || count < 1 || count > MAX_ANY_POCKETS) {
      setSelected(new Map());
      setMessage(`Enter how many pockets, from 1 to ${MAX_ANY_POCKETS}.`);
      return;
    }
    const entry: BinderEntry = {
      kind: 'set',
      setId: set.setId,
      setLanguage: language.data,
      startsNewPage: false,
    };
    setSelected(
      new Map(Array.from({ length: count }, (_unused, index) => [`any:${index}`, entry])),
    );
    setMessage(
      `${count.toLocaleString('en-AU')} ${count === 1 ? 'pocket' : 'pockets'} for any card from ${set.setName}.`,
    );
  }

  /** `count` pockets that each take any card by an illustrator or of a trainer. */
  function selectAnyFromGroup(
    groupKind: 'illustrator' | 'trainer',
    group: GroupChoice,
    countText: string,
  ): void {
    setAnyGroup(group);
    const count = Number(countText);
    if (!Number.isInteger(count) || count < 1 || count > MAX_ANY_POCKETS) {
      setSelected(new Map());
      setMessage(`Enter how many pockets, from 1 to ${MAX_ANY_POCKETS}.`);
      return;
    }
    const entry: BinderEntry = { kind: groupKind, key: group.key, startsNewPage: false };
    setSelected(
      new Map(Array.from({ length: count }, (_unused, index) => [`any:${index}`, entry])),
    );
    setMessage(
      `${count.toLocaleString('en-AU')} ${count === 1 ? 'pocket' : 'pockets'} for any card ${groupKind === 'illustrator' ? 'by' : 'of'} ${group.name}.`,
    );
  }

  function clearSetChoice(): void {
    selectAllRequest.current?.abort();
    setWorking(false);
    setSelected(new Map());
    setChosenSet(null);
    setAnySet(null);
    setMessage('');
  }

  /** `count` pockets that each take any card from an energy group. */
  function selectAnyEnergy(group: EnergyGroup, countText: string): void {
    selectAllRequest.current?.abort();
    setWorking(false);
    setEnergy(group);
    const count = Number(countText);
    if (!Number.isInteger(count) || count < 1 || count > MAX_ANY_POCKETS) {
      setSelected(new Map());
      setMessage(`Enter how many pockets, from 1 to ${MAX_ANY_POCKETS}.`);
      return;
    }
    const entry: BinderEntry = { kind: 'energy', key: group, startsNewPage: false };
    setSelected(
      new Map(Array.from({ length: count }, (_unused, index) => [`any:${index}`, entry])),
    );
    setMessage(
      `${count.toLocaleString('en-AU')} ${count === 1 ? 'pocket' : 'pockets'} for ${energyGroupName(group).toLocaleLowerCase('en-AU')}.`,
    );
  }

  /** Every card in an energy group becomes an exact target, oldest set first. */
  async function selectEveryEnergy(group: EnergyGroup): Promise<void> {
    selectAllRequest.current?.abort();
    const controller = new AbortController();
    selectAllRequest.current = controller;
    setWorking(true);
    setMessage('');
    setEnergy(group);
    try {
      // The catalogue's release sort: set release date, then card number.
      const cards = await collectAllCards(
        { q: '', filters: { energy: group, sort: 'release' } },
        INSERT_SELECTION_CAP,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setSelected(new Map(cards.map((card) => [card.id, exactEntry(card.id)])));
      setMessage(
        `${cards.length.toLocaleString('en-AU')} ${energyGroupName(group).toLocaleLowerCase('en-AU')} ${cards.length === 1 ? 'card' : 'cards'} selected, in release order.`,
      );
    } catch (cause) {
      if (controller.signal.aborted) return;
      setEnergy(null);
      setSelected(new Map());
      setMessage(
        cause instanceof ApiError || !(cause instanceof Error)
          ? binderErrorMessage(cause)
          : cause.message,
      );
    } finally {
      if (!controller.signal.aborted) setWorking(false);
    }
  }

  /** Every card of a set becomes an exact-card target, in the set's own number order. */
  async function selectSet(set: SetFacet): Promise<void> {
    selectAllRequest.current?.abort();
    const controller = new AbortController();
    selectAllRequest.current = controller;
    setWorking(true);
    setMessage('');
    setChosenSet(setKey(set));
    try {
      const cards = await collectAllCards(
        { q: '', filters: { set: set.setId, language: set.language } },
        INSERT_SELECTION_CAP,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      cards.sort((a, b) => cardNumberOrder.compare(a.number, b.number));
      setSelected(new Map(cards.map((card) => [card.id, exactEntry(card.id)])));
      setMessage(
        `${cards.length.toLocaleString('en-AU')} ${cards.length === 1 ? 'card' : 'cards'} from ${set.setName} selected, in set order.`,
      );
    } catch (cause) {
      if (controller.signal.aborted) return;
      setChosenSet(null);
      setSelected(new Map());
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
            setChosenSet(null);
            setAnySet(null);
            setAnyGroup(null);
            setEnergy(null);
          }}
          options={[
            { value: 'pokemon', label: 'Pokémon' },
            { value: 'set', label: 'Set' },
            { value: 'illustrator', label: 'Illustrator' },
            { value: 'trainer', label: 'Trainer' },
            { value: 'energy', label: 'Energy' },
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
        ) : kind === 'energy' ? (
          <>
            <SegmentedControl<SetMode>
              label="Pockets take"
              value={setMode}
              onChange={(value) => {
                setSetMode(value);
                selectAllRequest.current?.abort();
                setWorking(false);
                setSelected(new Map());
                setEnergy(null);
                setMessage('');
              }}
              options={[
                { value: 'any', label: 'Any card of it' },
                { value: 'every', label: 'Every card, release order' },
              ]}
            />
            {setMode === 'any' ? (
              <label className="panel-field">
                <span>How many pockets</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max={MAX_ANY_POCKETS}
                  step="1"
                  value={anyCount}
                  disabled={busy}
                  onChange={(event) => {
                    setAnyCount(event.target.value);
                    if (energy) selectAnyEnergy(energy, event.target.value);
                  }}
                />
              </label>
            ) : null}
            <EnergyPicker
              selected={energy}
              pending={busy}
              onSelect={(group) =>
                setMode === 'any' ? selectAnyEnergy(group, anyCount) : void selectEveryEnergy(group)
              }
            />
          </>
        ) : kind === 'illustrator' || kind === 'trainer' ? (
          <>
            <label className="panel-field">
              <span>How many pockets</span>
              <input
                type="number"
                inputMode="numeric"
                min="1"
                max={MAX_ANY_POCKETS}
                step="1"
                value={anyCount}
                disabled={busy}
                onChange={(event) => {
                  setAnyCount(event.target.value);
                  if (anyGroup) selectAnyFromGroup(kind, anyGroup, event.target.value);
                }}
              />
            </label>
            <GroupPicker
              kind={kind}
              selectedKey={anyGroup?.key ?? null}
              pending={busy}
              onSelect={(group) => selectAnyFromGroup(kind, group, anyCount)}
            />
          </>
        ) : kind === 'set' ? (
          <>
            <label className="panel-field">
              <span>Search sets</span>
              <input
                type="search"
                value={query}
                placeholder="Set name or code"
                onChange={(event) => {
                  setQuery(event.target.value);
                  setOffset(0);
                }}
              />
            </label>
            <SegmentedControl<SetMode>
              label="Pockets take"
              value={setMode}
              onChange={(value) => {
                setSetMode(value);
                clearSetChoice();
              }}
              options={[
                { value: 'any', label: 'Any card from the set' },
                { value: 'every', label: 'Every card, in order' },
              ]}
            />
            {setMode === 'any' ? (
              <label className="panel-field">
                <span>How many pockets</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max={MAX_ANY_POCKETS}
                  step="1"
                  value={anyCount}
                  disabled={busy}
                  onChange={(event) => {
                    setAnyCount(event.target.value);
                    if (anySet) selectAnyFromSet(anySet, event.target.value);
                  }}
                />
              </label>
            ) : (
              <p className="panel-help">
                Pick a set to target every card in it, in set order. Clear the selection to start
                again.
              </p>
            )}
            {sets.isError ? (
              <p role="alert" className="panel-error">
                {binderErrorMessage(sets.error)}
              </p>
            ) : null}
            <div className="species-grid" aria-label="Matching sets">
              {matchingSets.slice(offset, offset + SET_PAGE_SIZE).map((set) => (
                <button
                  key={setKey(set)}
                  type="button"
                  className="species-option"
                  aria-pressed={chosenSet === setKey(set)}
                  disabled={busy}
                  onClick={() =>
                    setMode === 'any' ? selectAnyFromSet(set, anyCount) : void selectSet(set)
                  }
                >
                  <span>{set.setName}</span>
                  <small>
                    {set.total.toLocaleString('en-AU')} {set.total === 1 ? 'card' : 'cards'}
                    {set.language === 'en' ? '' : ` · ${set.language.toUpperCase()}`}
                  </small>
                </button>
              ))}
            </div>
            <nav className="panel-actions" aria-label="Search result pages">
              <button
                type="button"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - SET_PAGE_SIZE))}
              >
                Previous results
              </button>
              <span className="panel-help">
                {sets.isLoading ? 'Loading sets…' : `${matchingSets.length} sets`}
              </span>
              <button
                type="button"
                disabled={offset + SET_PAGE_SIZE >= matchingSets.length}
                onClick={() => setOffset(offset + SET_PAGE_SIZE)}
              >
                Next results
              </button>
              <button
                type="button"
                className="button-text"
                disabled={busy || selected.size === 0}
                onClick={clearSetChoice}
              >
                Clear selection
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
