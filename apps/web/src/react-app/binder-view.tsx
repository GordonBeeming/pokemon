import {
  binderCapacityErrorSchema,
  binderSlotLocationSchema,
  NATIONAL_POKEDEX,
  type BinderAssignmentCandidate,
  type BinderLayout,
  type BinderSlot,
  type BinderSlotLocation,
  type CardId,
} from '@pokedex/shared';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import {
  api,
  ApiError,
  type BinderMutationResult,
  type BinderPlannerSummary,
  type BinderVersionPages,
  type BinderView,
  type CatalogueCardView,
} from './api';
import { userMessage, type Notice } from './ui';
import { CardArt } from './card-art';
import { CardTile } from './card-tile';
import { PocketPanel, PocketTools, type PocketTool } from './binder-pocket-tools';
import { BinderInsertDialog } from './binder-insert-dialog';
import { binderHash, parseBinderHash } from './binder-navigation';

const layouts: Array<{ kind: BinderLayout['kind']; label: string; rows: number; columns: number }> =
  [
    { kind: '2x2', label: '2 × 2', rows: 2, columns: 2 },
    { kind: '3x3', label: '3 × 3', rows: 3, columns: 3 },
    { kind: '4x3', label: '4 × 3', rows: 3, columns: 4 },
    { kind: 'top-loader', label: 'Top-loader', rows: 2, columns: 2 },
    { kind: 'custom', label: 'Custom', rows: 3, columns: 3 },
  ];
export function binderMutationPage(
  result: BinderMutationResult,
  currentPage: number,
): { position: number; page: BinderMutationResult['pages'][number] | null } {
  const position = Math.max(0, Math.min(currentPage, result.version.pageCount - 1));
  return { position, page: result.pages.find((item) => item.position === position) ?? null };
}
function layoutFor(kind: BinderLayout['kind'], rows: number, columns: number): BinderLayout {
  if (kind === 'custom') return { kind, rows, columns };
  if (kind === '2x2') return { kind, rows: 2, columns: 2 };
  if (kind === '3x3') return { kind, rows: 3, columns: 3 };
  if (kind === '4x3') return { kind, rows: 3, columns: 4 };
  return { kind: 'top-loader', rows: 2, columns: 2 };
}
function capacityDescription(capacity: number, face: number): string {
  if (!Number.isInteger(capacity)) return 'Enter a whole number of pockets.';
  if (capacity < 1) return 'Enter at least 1 pocket.';
  const pages = Math.ceil(capacity / face);
  const finalPage = capacity % face || face;
  const pageLabel = pages === 1 ? 'page face' : 'page faces';
  const pocketLabel = finalPage === 1 ? 'pocket' : 'pockets';
  const capacityLabel = capacity === 1 ? 'pocket' : 'pockets';
  const partial = finalPage < face ? ` The final page has ${finalPage} ${pocketLabel}.` : '';
  return `${capacity.toLocaleString('en-AU')} ${capacityLabel} in this binder across ${pages.toLocaleString('en-AU')} ${pageLabel}.${partial}`;
}
function place(location: BinderSlotLocation): string {
  return `page ${location.page + 1}, row ${location.row + 1}, column ${location.column + 1}`;
}
function label(slot: BinderSlot, cards: Map<string, CatalogueCardView>): string {
  if (slot.entryKind === 'reserved')
    return slot.label ? `Reserved: ${slot.label}` : 'Reserved sleeve';
  if (slot.entryKind === 'pokemon' && slot.pokemonNumber) {
    const pokemon = NATIONAL_POKEDEX[slot.pokemonNumber - 1];
    return pokemon
      ? `#${String(pokemon.number).padStart(4, '0')} ${pokemon.name} · ${pokemon.discoveryCategory}`
      : `Pokémon #${slot.pokemonNumber}`;
  }
  if (slot.entryKind === 'exact-card' && slot.cardId)
    return cards.get(slot.cardId)?.name ?? 'Exact card target';
  return 'Empty pocket';
}
function visualLabel(slot: BinderSlot, cards: Map<string, CatalogueCardView>): string {
  if (slot.entryKind === 'reserved') return slot.label ?? 'Reserved sleeve';
  if (slot.entryKind === 'pokemon' && slot.pokemonNumber) {
    const pokemon = NATIONAL_POKEDEX[slot.pokemonNumber - 1];
    return pokemon
      ? `#${String(pokemon.number).padStart(4, '0')} ${pokemon.name} · ${pokemon.discoveryCategory}`
      : 'Pokémon target';
  }
  if (slot.entryKind === 'exact-card' && slot.cardId)
    return cards.get(slot.cardId)?.name ?? 'Exact card target';
  return 'Empty pocket';
}

function Create({
  pending,
  create,
}: {
  pending: boolean;
  create: (name: string, layout: BinderLayout, capacity: number) => void;
}): ReactElement {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<BinderLayout['kind']>('3x3');
  const [rows, setRows] = useState(3);
  const [columns, setColumns] = useState(3);
  const [capacity, setCapacity] = useState(9);
  const layout = layoutFor(kind, rows, columns);
  const face = layout.rows * layout.columns;
  const valid = Number.isInteger(capacity) && capacity >= 1;
  return (
    <section className="surface activity-panel" aria-labelledby="create-binder-heading">
      <h1 id="create-binder-heading">Create your first binder.</h1>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) create(name.trim(), layout, capacity);
        }}
      >
        <label>
          Name
          <input
            value={name}
            maxLength={120}
            required
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <fieldset className="layout-picker">
          <legend>Page face</legend>
          <div>
            {layouts.map((item) => (
              <button
                key={item.kind}
                type="button"
                aria-pressed={kind === item.kind}
                onClick={() => {
                  setKind(item.kind);
                }}
              >
                <strong>{item.label}</strong>
              </button>
            ))}
          </div>
        </fieldset>
        {kind === 'custom' ? (
          <div className="inline-fields">
            <label>
              Rows
              <input
                type="number"
                min="1"
                max="20"
                value={rows}
                onChange={(event) => setRows(Number(event.target.value))}
              />
            </label>
            <label>
              Columns
              <input
                type="number"
                min="1"
                max="20"
                value={columns}
                onChange={(event) => setColumns(Number(event.target.value))}
              />
            </label>
          </div>
        ) : null}
        <label>
          Binder capacity (pockets)
          <input
            type="number"
            min="1"
            step="1"
            value={capacity}
            onChange={(event) => setCapacity(Number(event.target.value))}
          />
        </label>
        <p className="form-help">
          {capacityDescription(capacity, face)} Each full page is {layout.rows} × {layout.columns}.
        </p>
        <button
          className="quiet-button tone-accent"
          type="submit"
          disabled={!name.trim() || !valid || pending}
        >
          {pending ? 'Creating…' : 'Create binder'}
        </button>
      </form>
    </section>
  );
}

function BinderUsage({
  summary,
  counts,
  capacity,
}: {
  summary: BinderPlannerSummary | null;
  counts: { target: number; placed: number; reserved: number };
  capacity: number;
}): ReactElement {
  const reservedSleeves = summary?.reservedSleeves ?? counts.reserved;
  const reservedPages = summary?.reservedPages ?? 0;
  return (
    <section className="binder-summary" aria-label="Binder usage">
      <span>
        <strong>{summary?.targets ?? counts.target}</strong> targets
      </span>
      <span>
        <strong>{summary?.placed ?? counts.placed}</strong> placed
      </span>
      <span>
        <strong>{reservedSleeves}</strong> reserved {reservedSleeves === 1 ? 'sleeve' : 'sleeves'}
      </span>
      <span>
        <strong>{reservedPages}</strong> reserved {reservedPages === 1 ? 'page' : 'pages'}
      </span>
      <span>
        <strong>{summary?.generatedPadding ?? 0}</strong> generated padding
      </span>
      <span>
        <strong>
          {summary?.available ?? Math.max(0, capacity - counts.target - counts.reserved)}
        </strong>{' '}
        available
      </span>
    </section>
  );
}

function BinderPageToolbar({
  pending,
  editable,
  page,
  pageCount,
  canRemove,
  status,
  onPrevious,
  onInsert,
  onManage,
  managementOpen,
  onGo,
  onNext,
  onEarlier,
  onLater,
  onArrange,
  onRemove,
}: {
  pending: boolean;
  editable: boolean;
  page: number;
  pageCount: number;
  canRemove: boolean;
  status: string;
  onPrevious: () => void;
  onInsert: () => void;
  onManage: () => void;
  managementOpen: boolean;
  onGo: (page: number) => void;
  onNext: () => void;
  onEarlier: () => void;
  onLater: () => void;
  onArrange: () => void;
  onRemove: () => void;
}): ReactElement {
  const [pageInput, setPageInput] = useState(String(page + 1));
  useEffect(() => setPageInput(String(page + 1)), [page]);
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent): void => {
      if (!menu.current?.contains(event.target as Node)) setOpen(false);
    };
    const close = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    addEventListener('pointerdown', dismiss);
    addEventListener('keydown', close);
    return () => {
      removeEventListener('pointerdown', dismiss);
      removeEventListener('keydown', close);
    };
  }, [open]);
  const act = (action: () => void): void => {
    setOpen(false);
    action();
  };
  return (
    <div className="binder-page-toolbar">
      <div className="binder-workspace-actions">
        <button
          className="quiet-button tone-accent"
          type="button"
          disabled={!editable || pending}
          onClick={onInsert}
        >
          Insert targets
        </button>
        <button
          className="quiet-button"
          type="button"
          disabled={pending}
          aria-expanded={managementOpen}
          onClick={onManage}
        >
          Manage binder
        </button>
      </div>
      <nav className="binder-page-stepper" aria-label="Binder pages">
        <button
          className="quiet-button"
          type="button"
          disabled={pending || page === 0}
          onClick={() => onGo(0)}
        >
          First
        </button>
        <button
          className="quiet-button"
          type="button"
          disabled={pending || page === 0}
          onClick={onPrevious}
        >
          Previous
        </button>
        <form
          className="binder-page-jump"
          onSubmit={(event) => {
            event.preventDefault();
            const value = Number(pageInput);
            if (Number.isInteger(value) && value >= 1 && value <= pageCount) onGo(value - 1);
          }}
        >
          <label>
            Page{' '}
            <input
              aria-label="Go to page"
              type="number"
              min="1"
              max={pageCount}
              value={pageInput}
              disabled={pending}
              onChange={(event) => setPageInput(event.target.value)}
            />
          </label>
          <span>of {pageCount}</span>
          <button
            className="quiet-button"
            type="submit"
            disabled={
              pending ||
              !Number.isInteger(Number(pageInput)) ||
              Number(pageInput) < 1 ||
              Number(pageInput) > pageCount
            }
          >
            Go
          </button>
        </form>
        <button
          className="quiet-button"
          type="button"
          disabled={pending || page + 1 >= pageCount}
          onClick={onNext}
        >
          Next
        </button>
        <button
          className="quiet-button"
          type="button"
          disabled={pending || page + 1 >= pageCount}
          onClick={() => onGo(pageCount - 1)}
        >
          Last
        </button>
      </nav>
      <div className="page-menu" ref={menu}>
        <button
          className="quiet-button"
          type="button"
          aria-label="Page actions"
          aria-expanded={open}
          ref={trigger}
          onClick={() => setOpen((current) => !current)}
        >
          Manage page
        </button>
        {open ? (
          <div className="page-menu-popover" aria-label="Page actions">
            <button
              type="button"
              disabled={!editable || pending || page === 0}
              onClick={() => act(onEarlier)}
            >
              Move page earlier
            </button>
            <button
              type="button"
              disabled={!editable || pending || page + 1 >= pageCount}
              onClick={() => act(onLater)}
            >
              Move page later
            </button>
            <button type="button" disabled={!editable || pending} onClick={() => act(onArrange)}>
              Arrange targets
            </button>
            <button
              className="danger-menu-item"
              type="button"
              disabled={!editable || pending || !canRemove || pageCount <= 1}
              onClick={() => act(onRemove)}
            >
              Remove this page
            </button>
          </div>
        ) : null}
      </div>
      <p className="binder-page-status" role="status" aria-live="polite">
        {status}
      </p>
    </div>
  );
}

function BinderGrid({
  page,
  currentPage,
  columns,
  rows,
  pending,
  editable,
  selected,
  moveSource,
  cards,
  onNotice,
  onSelect,
  onTool,
  onMove,
  onPickUp,
  onUnassign,
  onCancelMove,
}: {
  page: number;
  currentPage: BinderVersionPages['pages'][number] | null;
  columns: number;
  rows: number;
  pending: boolean;
  editable: boolean;
  selected: BinderSlotLocation | null;
  moveSource: BinderSlotLocation | null;
  cards: Map<string, CatalogueCardView>;
  onNotice: (notice: Notice) => void;
  onSelect: (at: BinderSlotLocation) => void;
  onTool: (tool: PocketTool) => void;
  onMove: (source: BinderSlotLocation, target: BinderSlotLocation) => void;
  onPickUp: (at: BinderSlotLocation) => void;
  onUnassign: (at: BinderSlotLocation) => void;
  onCancelMove: () => void;
}): ReactElement {
  const reservedPage = currentPage?.kind === 'reserved';
  return (
    <section
      className={`binder-page ${reservedPage ? 'reserved-binder-page' : ''} ${columns > 4 ? 'binder-page-wide' : ''}`}
      style={{
        width:
          columns > 4
            ? '100%'
            : `min(100%, max(36rem, calc((100dvh - 18rem) * ${(columns * 0.72) / rows})))`,
      }}
      aria-label={reservedPage ? `Reserved binder page ${page + 1}` : `Binder page ${page + 1}`}
    >
      {reservedPage ? (
        <p className="reserved-page-label">
          Reserved page{currentPage.label ? `: ${currentPage.label}` : ''}
        </p>
      ) : null}
      <div
        className={`binder-grid${columns <= 4 ? ' binder-grid-fit' : ''}`}
        style={{
          gridTemplateColumns: `repeat(${columns}, minmax(var(--binder-slot-min, 4rem), 1fr))`,
        }}
      >
        {(currentPage?.slots ?? []).map((slot) => {
          const at = { page, row: slot.row, column: slot.column };
          const selectedTarget = selected?.row === slot.row && selected?.column === slot.column;
          const state = slot.assignedCardId
            ? 'placed'
            : slot.entryKind === 'reserved'
              ? 'reserved'
              : slot.entryKind === 'empty'
                ? 'empty'
                : 'target';
          const card = slot.assignedCardId
            ? cards.get(slot.assignedCardId)
            : slot.cardId
              ? cards.get(slot.cardId)
              : null;
          return (
            <div
              key={`${slot.row}-${slot.column}`}
              className={`binder-slot-wrap${selectedTarget ? ' selected' : ''}`}
            >
              <button
                className={`binder-slot ${state} ${selectedTarget ? 'selected-slot' : ''}`}
                data-binder-slot={`${page}-${slot.row}-${slot.column}`}
                type="button"
                disabled={pending || reservedPage}
                draggable={slot.entryKind !== 'empty' && editable && !reservedPage}
                aria-pressed={selectedTarget}
                aria-label={`${place(at)}, ${label(slot, cards)}. ${state}.`}
                onDragStart={(event) =>
                  event.dataTransfer.setData('application/json', JSON.stringify(at))
                }
                onDragOver={(event) => {
                  if (editable) event.preventDefault();
                }}
                onDrop={(event) => {
                  if (!editable) return;
                  event.preventDefault();
                  try {
                    const source = binderSlotLocationSchema.safeParse(
                      JSON.parse(event.dataTransfer.getData('application/json')) as unknown,
                    );
                    if (source.success) onMove(source.data, at);
                    else onNotice({ kind: 'error', message: 'That card move could not be read.' });
                  } catch (error) {
                    onNotice({ kind: 'error', message: userMessage(error) });
                  }
                }}
                onKeyDown={(event) => {
                  if (
                    editable &&
                    event.key.toLocaleLowerCase('en-AU') === 'm' &&
                    slot.entryKind !== 'empty'
                  ) {
                    event.preventDefault();
                    onPickUp(at);
                  }
                  if (
                    editable &&
                    (event.key === 'Delete' || event.key === 'Backspace') &&
                    slot.assignedCardId
                  ) {
                    event.preventDefault();
                    onUnassign(at);
                  }
                  if (event.key === 'Escape') onCancelMove();
                }}
                onClick={() => {
                  if (moveSource && editable) onMove(moveSource, at);
                  else onSelect(at);
                }}
              >
                {card ? (
                  <CardArt src={card.imageLowUrl} highSrc={card.imageHighUrl} alt="" />
                ) : null}
                <strong title={label(slot, cards)}>{visualLabel(slot, cards)}</strong>
                <small>
                  {slot.assignedCardId
                    ? `Placed: ${card?.name ?? 'owned card'}`
                    : state === 'target'
                      ? 'Target planned'
                      : state}
                </small>
              </button>
              {selectedTarget && editable && !reservedPage ? (
                <PocketTools
                  target={slot.entryKind === 'exact-card' || slot.entryKind === 'pokemon'}
                  reserved={slot.entryKind === 'reserved'}
                  pending={pending}
                  alignEnd={slot.column >= columns / 2}
                  onTool={onTool}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function BinderCapacityControls({
  canReservePage,
  face,
  capacity,
  resize,
  reservation,
  pending,
  onResizeChange,
  onResize,
  onReservationChange,
  onReservePage,
  onArrange,
}: {
  canReservePage: boolean;
  face: number;
  capacity: number;
  resize: string;
  reservation: string;
  pending: boolean;
  onResizeChange: (value: string) => void;
  onResize: (value: number) => void;
  onReservationChange: (value: string) => void;
  onReservePage: (label: string | null) => void;
  onArrange: () => void;
}): ReactElement {
  const value = Number(resize || capacity);
  const invalid = !Number.isInteger(value) || value < 1;
  return (
    <>
      <hr />
      <h3>Binder capacity</h3>
      <label htmlFor="binder-capacity-input">
        Binder capacity (pockets)
        <input
          id="binder-capacity-input"
          type="number"
          min="1"
          step="1"
          value={resize}
          placeholder={String(capacity)}
          disabled={pending}
          aria-describedby="binder-capacity-help"
          aria-invalid={resize !== '' && invalid}
          onChange={(event) => onResizeChange(event.target.value)}
        />
      </label>
      <p id="binder-capacity-help" className="form-help" aria-live="polite">
        {capacityDescription(value, face)}
      </p>
      <button
        className="quiet-button"
        type="button"
        disabled={pending || value === capacity || invalid}
        onClick={() => onResize(value)}
      >
        {value > capacity ? 'Grow binder' : 'Safely shrink binder'}
      </button>
      <label>
        Page reservation label (optional)
        <input
          value={reservation}
          disabled={pending || !canReservePage}
          maxLength={120}
          onChange={(event) => onReservationChange(event.target.value)}
        />
      </label>
      <button
        className="quiet-button"
        type="button"
        disabled={pending || !canReservePage}
        onClick={() => onReservePage(reservation.trim() || null)}
      >
        Reserve this page
      </button>
      <button className="quiet-button" type="button" disabled={pending} onClick={onArrange}>
        Arrange targets
      </button>
    </>
  );
}

function useBinderPlanner(onNotice: (notice: Notice) => void, resetPanels: () => void) {
  const [binders, setBinders] = useState<BinderView[]>([]);
  const [binder, setBinder] = useState<BinderVersionPages | null>(null);
  const [page, setPage] = useState(0);
  const [showCreate, setShowCreate] = useState(false);
  const [selected, setSelected] = useState<BinderSlotLocation | null>(null);
  const [candidates, setCandidates] = useState<BinderAssignmentCandidate[]>([]);
  const [candidateState, setCandidateState] = useState<'idle' | 'loading' | 'loaded'>('idle');
  const [cards, setCards] = useState<Map<string, CatalogueCardView>>(new Map());
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState('');
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [reservation, setReservation] = useState('');
  const [pageReservation, setPageReservation] = useState('');
  const [offset, setOffset] = useState('1');
  const [resize, setResize] = useState('');
  const [moveSource, setMoveSource] = useState<BinderSlotLocation | null>(null);
  const [summary, setSummary] = useState<BinderPlannerSummary | null>(null);
  const [replacement, setReplacement] = useState<'same' | 'any' | null>(null);
  const [searchState, setSearchState] = useState<'idle' | 'loading' | 'loaded'>('idle');
  const searchController = useRef<AbortController | null>(null);
  const [legacyQuery, setLegacyQuery] = useState('');
  const [legacyResults, setLegacyResults] = useState<CatalogueCardView[]>([]);
  const mounted = useRef(false);
  const navigation = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const loadedVersion = useRef<string | null>(null);
  const pageRequest = useRef<AbortController | null>(null);
  const lastHash = useRef<string | null>(null);
  const scrollRestoredPocket = useRef(false);
  const pendingPocketFocus = useRef<BinderSlotLocation | null>(null);
  const candidateController = useRef<AbortController | null>(null);
  const candidateGeneration = useRef(0);
  const version = binder?.version ?? null;
  const currentPage = binder?.pages[0] ?? null;
  const reservedPage = currentPage?.kind === 'reserved';
  const editable = version?.status !== 'archived';
  const face = (version?.layout.rows ?? 1) * (version?.layout.columns ?? 1);
  const capacity = version?.capacity ?? face * (version?.pageCount ?? 1);
  const counts = useMemo(() => {
    const slots = currentPage?.slots ?? [];
    return {
      target: slots.filter(
        (slot) => slot.entryKind === 'exact-card' || slot.entryKind === 'pokemon',
      ).length,
      placed: slots.filter((slot) => slot.assignedCardId).length,
      reserved: slots.filter((slot) => slot.entryKind === 'reserved').length,
    };
  }, [currentPage]);
  function resetBinderDrafts(): void {
    setMoveSource(null);
    setReservation('');
    setPageReservation('');
    setOffset('1');
    setResize('');
    setLegacyQuery('');
    setLegacyResults([]);
    setReplacement(null);
    setMutationError(null);
  }
  function captureNavigation(): () => boolean {
    const current = navigation.current;
    return () => mounted.current && navigation.current === current;
  }
  async function loadBinders(): Promise<void> {
    if (!mounted.current) return;
    const items = await api.binders();
    if (mounted.current) setBinders(items);
  }
  async function load(
    id: string,
    next: number,
    keepSelection: BinderSlotLocation | null = null,
    historyMode: 'push' | 'replace' | 'none' = 'push',
  ): Promise<void> {
    if (!mounted.current) return;
    if (historyMode !== 'replace') {
      navigation.current += 1;
      resetPanels();
      setShowCreate(false);
    }
    if (loadedVersion.current !== id) resetBinderDrafts();
    pageRequest.current?.abort();
    const controller = new AbortController();
    pageRequest.current = controller;
    candidateController.current?.abort();
    candidateGeneration.current += 1;
    searchController.current?.abort();
    if (!keepSelection) {
      setMutationError(null);
      setReplacement(null);
      setLegacyResults([]);
      setSearchState('idle');
    }
    setPending(true);
    try {
      const data = await api.binder(id, next, 1, controller.signal);
      const ids: CardId[] = [];
      for (const slot of data.pages.flatMap((item) => item.slots)) {
        if (slot.cardId) ids.push(slot.cardId);
        if (slot.assignedCardId) ids.push(slot.assignedCardId);
      }
      const retained =
        keepSelection?.page === next &&
        data.pages[0]?.kind !== 'reserved' &&
        data.pages[0]?.slots.some(
          (slot) => slot.row === keepSelection.row && slot.column === keepSelection.column,
        )
          ? keepSelection
          : null;
      const keptSlot = retained
        ? data.pages[0]?.slots.find(
            (slot) => slot.row === retained.row && slot.column === retained.column,
          )
        : null;
      const hasTarget = keptSlot?.entryKind === 'exact-card' || keptSlot?.entryKind === 'pokemon';
      const [resolved, nextSummary, owned] = await Promise.all([
        ids.length ? api.resolveCards([...new Set(ids)], controller.signal) : Promise.resolve([]),
        api.plannerSummary(id, controller.signal),
        retained && hasTarget
          ? api.assignmentCandidates(id, retained, controller.signal)
          : Promise.resolve([]),
      ]);
      if (controller.signal.aborted || !mounted.current) return;
      setCards(
        (current) => new Map([...current, ...resolved.map((card) => [card.id, card] as const)]),
      );
      if (historyMode === 'none' && data.pages[0]?.kind !== 'reserved') {
        const first = data.pages[0]?.slots[0];
        pendingPocketFocus.current =
          retained ?? (first ? { page: next, row: first.row, column: first.column } : null);
        scrollRestoredPocket.current = pendingPocketFocus.current !== null;
      }
      loadedVersion.current = id;
      setBinder(data);
      setSummary(nextSummary);
      setPage(next);
      setSelected(retained);
      setCandidates(owned);
      setCandidateState(hasTarget ? 'loaded' : 'idle');
      setStatus(`Page ${next + 1} loaded.`);
      const hash = binderHash(id, next, retained);
      if (historyMode !== 'none' && hash !== location.hash)
        history[historyMode === 'push' ? 'pushState' : 'replaceState'](null, '', hash);
      lastHash.current = location.hash;
    } catch (error) {
      if (!controller.signal.aborted) onNotice({ kind: 'error', message: userMessage(error) });
    } finally {
      if (!controller.signal.aborted && mounted.current) setPending(false);
    }
  }
  function showLibrary(historyMode: 'push' | 'replace' | 'none' = 'push'): void {
    if (!mounted.current) return;
    navigation.current += 1;
    resetPanels();
    resetBinderDrafts();
    loadedVersion.current = null;
    setShowCreate(false);
    pageRequest.current?.abort();
    candidateController.current?.abort();
    searchController.current?.abort();
    candidateGeneration.current += 1;
    pendingPocketFocus.current = null;
    scrollRestoredPocket.current = false;
    setPending(false);
    setBinder(null);
    setSelected(null);
    if (historyMode !== 'none' && location.hash !== '#binders')
      history[historyMode === 'push' ? 'pushState' : 'replaceState'](null, '', '#binders');
    lastHash.current = location.hash;
  }

  useEffect(() => {
    void loadBinders().catch((error: unknown) =>
      onNotice({ kind: 'error', message: userMessage(error) }),
    );
  }, []);
  useEffect(() => {
    const openLink = () => {
      if (lastHash.current === location.hash) return;
      lastHash.current = location.hash;
      navigation.current += 1;
      if (location.hash === '#binders') {
        showLibrary('none');
        return;
      }
      const route = parseBinderHash(location.hash);
      if (route) void load(route.versionId, route.page, route.pocket, 'none');
    };
    openLink();
    addEventListener('hashchange', openLink);
    addEventListener('popstate', openLink);
    return () => {
      removeEventListener('hashchange', openLink);
      removeEventListener('popstate', openLink);
      lastHash.current = null;
    };
  }, []);
  useEffect(
    () => () => {
      candidateController.current?.abort();
      searchController.current?.abort();
      pageRequest.current?.abort();
    },
    [],
  );
  useEffect(() => {
    const at = pendingPocketFocus.current;
    if (!at) {
      scrollRestoredPocket.current = false;
      return;
    }
    if (at.page !== page) {
      pendingPocketFocus.current = null;
      scrollRestoredPocket.current = false;
      return;
    }
    pendingPocketFocus.current = null;
    const shouldScroll = scrollRestoredPocket.current;
    scrollRestoredPocket.current = false;
    const frame = requestAnimationFrame(() => {
      const pocket = document.querySelector<HTMLButtonElement>(
        `[data-binder-slot="${at.page}-${at.row}-${at.column}"]`,
      );
      if (shouldScroll) {
        if (document.querySelector('.pocket-editor-popup')) return;
        pocket?.focus({ preventScroll: true });
        pocket?.scrollIntoView({ block: 'center' });
      } else pocket?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [binder, page]);
  async function mutate(
    action: () => Promise<BinderMutationResult>,
    message: string,
    focusAt: BinderSlotLocation | null = selected,
  ): Promise<boolean> {
    if (!version || !mounted.current) return false;
    const startedOn = navigation.current;
    const stillHere = () => mounted.current && navigation.current === startedOn;
    const editorControl =
      document.activeElement instanceof HTMLElement &&
      document.activeElement.closest('.pocket-editor-popup')
        ? document.activeElement
        : null;
    setPending(true);
    setMutationError(null);
    try {
      const result = await action();
      if (!stillHere()) {
        onNotice({ kind: 'success', message });
        return true;
      }
      pendingPocketFocus.current = editorControl ? null : (result.anchor ?? focusAt);
      await load(
        result.version.id,
        binderMutationPage(result, result.anchor?.page ?? page).position,
        result.anchor ?? focusAt,
        'replace',
      );
      if (!stillHere()) {
        onNotice({ kind: 'success', message });
        return true;
      }
      if (editorControl)
        requestAnimationFrame(() => {
          if (editorControl.isConnected && !editorControl.matches(':disabled'))
            editorControl.focus({ preventScroll: true });
        });
      setStatus(message);
      onNotice({ kind: 'success', message });
      return true;
    } catch (error) {
      if (!stillHere()) {
        onNotice({ kind: 'error', message: userMessage(error) });
        return false;
      }
      pendingPocketFocus.current = null;
      setMutationError(userMessage(error));
      if (error instanceof ApiError && error.code === 'binder_capacity_exceeded') {
        const details = binderCapacityErrorSchema.safeParse(error.details);
        const required = details.success ? details.data.requiredCapacity : capacity + face;
        setResize(String(required));
        setStatus('This action needs more capacity. Open Manage binder to grow it.');
        setMutationError(
          `This needs ${required} pockets. Open Manage binder to grow it, then retry. No targets were changed.`,
        );
      }
      onNotice({ kind: 'error', message: userMessage(error) });
      return false;
    } finally {
      if (stillHere()) setPending(false);
    }
  }
  async function select(at: BinderSlotLocation): Promise<void> {
    if (!version) return;
    candidateController.current?.abort();
    const generation = ++candidateGeneration.current;
    searchController.current?.abort();
    setReplacement(null);
    setLegacyQuery('');
    setLegacyResults([]);
    setSearchState('idle');
    setSelected(at);
    setMutationError(null);
    const hash = binderHash(version.id, at.page, at);
    history.replaceState(null, '', hash);
    lastHash.current = hash;
    setCandidates([]);
    setCandidateState('idle');
    const slot = currentPage?.slots.find(
      (item) => item.row === at.row && item.column === at.column,
    );
    setStatus(`${place(at)} selected.`);
    if (slot?.entryKind === 'exact-card' || slot?.entryKind === 'pokemon') {
      try {
        const controller = new AbortController();
        candidateController.current = controller;
        setCandidateState('loading');

        const found = await api.assignmentCandidates(version.id, at, controller.signal);
        if (generation === candidateGeneration.current) {
          setCandidates(found);
          setCandidateState('loaded');
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        if (generation === candidateGeneration.current) setCandidateState('idle');
        onNotice({ kind: 'error', message: userMessage(error) });
      }
    }
  }
  const selectedSlot = selected
    ? (currentPage?.slots.find(
        (slot) => slot.row === selected.row && slot.column === selected.column,
      ) ?? null)
    : null;
  const target = selectedSlot?.entryKind === 'exact-card' || selectedSlot?.entryKind === 'pokemon';
  async function searchLegacyCards(mode = replacement, query = legacyQuery): Promise<void> {
    searchController.current?.abort();
    const controller = new AbortController();
    searchController.current = controller;
    setSearchState('loading');
    setLegacyResults([]);
    try {
      const params = new URLSearchParams({ q: query, limit: '24', offset: '0' });
      if (mode === 'same') {
        const original = selectedSlot?.cardId ? cards.get(selectedSlot.cardId) : null;
        const pokemonNumber = selectedSlot?.pokemonNumber ?? original?.pokedexNumber;
        if (pokemonNumber) params.set('pokedexNumber', String(pokemonNumber));
        else if (original && original.category !== 'pokemon')
          params.set('category', original.category);
        else {
          setSearchState('idle');
          onNotice({
            kind: 'error',
            message: 'This card has no Pokémon species recorded. Use Replace with any card.',
          });
          return;
        }
      }
      const result = await api.search(params, controller.signal);
      if (controller.signal.aborted) return;
      setLegacyResults(result.cards);
      setSearchState('loaded');
    } catch (error) {
      if (controller.signal.aborted) return;
      setSearchState('idle');
      onNotice({ kind: 'error', message: userMessage(error) });
    }
  }
  function startReplacement(mode: 'same' | 'any'): void {
    setReplacement(mode);
    setLegacyQuery('');
    void searchLegacyCards(mode, '');
  }
  async function chooseExactTarget(card: CatalogueCardView): Promise<void> {
    if (!version || !selected) return;
    const placed = await mutate(
      () =>
        replacement
          ? api.setSlot(version.id, {
              ...selected,
              cardId: card.id,
              expectedRevision: version.revision,
            })
          : api.insertEntries(
              version.id,
              selected,
              [{ kind: 'exact-card', cardId: card.id, startsNewPage: false }],
              version.revision,
            ),
      `${card.name} is now the exact target for pocket ${selected.row + 1}:${selected.column + 1}.`,
    );
    if (placed) {
      setLegacyResults([]);
      setLegacyQuery('');
    }
  }
  function moveOrSwap(source: BinderSlotLocation, target: BinderSlotLocation): void {
    if (!version) return;
    void mutate(
      () => api.swapSlots(version.id, { expectedRevision: version.revision, source, target }),
      'Cards moved.',
      target,
    ).then((moved) => {
      if (moved) setMoveSource(null);
    });
  }
  function reorderCurrentPage(direction: -1 | 1): void {
    if (!version) return;
    const ids = [...(summary?.pageIds ?? [])];
    const target = page + direction;
    const currentId = ids[page];
    const targetId = ids[target];
    if (!currentId || !targetId) return;
    ids[page] = targetId;
    ids[target] = currentId;
    void mutate(
      () => api.reorderPages(version.id, ids, version.revision),
      direction < 0 ? 'Page moved earlier.' : 'Page moved later.',
    );
  }
  const insert = (): void => {
    if (!version || !selected) return;
    void mutate(
      () =>
        api.insertEntries(
          version.id,
          selected,
          [{ kind: 'reserved', label: reservation.trim() || null }],
          version.revision,
        ),
      'Sleeve reserved.',
    ).then((inserted) => {
      if (inserted) setReservation((current) => (current === reservation ? '' : current));
    });
  };
  return {
    binders,
    binder,
    setBinder,
    page,
    showCreate,
    setShowCreate,
    selected,
    setSelected,
    candidates,
    candidateState,
    cards,
    pending,
    setPending,
    status,
    mutationError,
    setStatus,
    reservation,
    setReservation,
    pageReservation,
    setPageReservation,
    offset,
    setOffset,
    resize,
    setResize,
    moveSource,
    setMoveSource,
    summary,
    legacyQuery,
    setLegacyQuery,
    replacement,
    setReplacement,
    searchState,
    startReplacement,
    legacyResults,
    version,
    currentPage,
    reservedPage,
    editable,
    face,
    capacity,
    counts,
    loadBinders,
    captureNavigation,
    showLibrary,
    load,
    mutate,
    select,
    selectedSlot,
    target,
    searchLegacyCards,
    chooseExactTarget,
    moveOrSwap,
    reorderCurrentPage,
    insert,
  };
}

export function BinderView({ onNotice }: { onNotice: (notice: Notice) => void }): ReactElement {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteName, setDeleteName] = useState('');
  const [tool, setTool] = useState<PocketTool | null>(null);
  const [managementOpen, setManagementOpen] = useState(false);
  const [insertOpen, setInsertOpen] = useState(false);
  const [insertAt, setInsertAt] = useState<BinderSlotLocation | null>(null);
  const resetPanels = useCallback(() => {
    setTool(null);
    setManagementOpen(false);
    setInsertOpen(false);
    setInsertAt(null);
    setDeleteOpen(false);
    setDeleteName('');
  }, []);
  const {
    binders,
    binder,
    page,
    showCreate,
    setShowCreate,
    selected,
    candidates,
    candidateState,
    cards,
    pending,
    setPending,
    status,
    mutationError,
    setStatus,
    reservation,
    setReservation,
    pageReservation,
    setPageReservation,
    offset,
    setOffset,
    resize,
    setResize,
    moveSource,
    setMoveSource,
    summary,
    legacyQuery,
    setLegacyQuery,
    replacement,
    setReplacement,
    searchState,
    startReplacement,
    legacyResults,
    version,
    currentPage,
    reservedPage,
    editable,
    face,
    capacity,
    counts,
    loadBinders,
    captureNavigation,
    showLibrary,
    load,
    mutate,
    select,
    selectedSlot,
    target,
    searchLegacyCards,
    chooseExactTarget,
    moveOrSwap,
    reorderCurrentPage,
    insert,
  } = useBinderPlanner(onNotice, resetPanels);
  const currentBinder = binders.find((item) => item.id === version?.binderId);
  if (!binder)
    return (
      <>
        <header className="page-heading binder-library-heading">
          <div>
            <h1>Your binders.</h1>
            <p>Build a fixed-capacity plan for a physical binder.</p>
          </div>
          <button
            className="quiet-button tone-accent"
            type="button"
            disabled={pending}
            onClick={() => setShowCreate((open) => !open)}
          >
            {showCreate ? 'Cancel' : 'New binder'}
          </button>
        </header>
        <section className="binder-library" aria-label="Your binders">
          {binders.map((item) => (
            <button
              key={item.id}
              className="binder-library-card"
              type="button"
              disabled={pending}
              onClick={() => {
                const id = item.activeVersionId ?? item.latestVersionId;
                if (id) void load(id, 0);
              }}
            >
              <span className="binder-cover" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              <span>
                <strong>{item.name}</strong>
                <small>Open binder plan</small>
              </span>
            </button>
          ))}
        </section>
        {showCreate || binders.length === 0 ? (
          <Create
            pending={pending}
            create={(name, layout, total) => {
              const stillHere = captureNavigation();
              setPending(true);
              void api
                .createBinder(name, layout, total)
                .then(async (created) => {
                  await loadBinders();
                  if (stillHere()) {
                    setShowCreate(false);
                    await load(created.version.id, 0);
                  }
                })
                .catch((error: unknown) => onNotice({ kind: 'error', message: userMessage(error) }))
                .finally(() => {
                  if (stillHere()) setPending(false);
                });
            }}
          />
        ) : null}
      </>
    );
  return (
    <>
      <header className="page-heading binder-active-heading">
        <div>
          <button
            className="text-button back-link"
            type="button"
            onClick={() => {
              showLibrary();
              setTool(null);
              setDeleteOpen(false);
              setDeleteName('');
            }}
          >
            Back to all binders
          </button>
          <h1>{binders.find((item) => item.id === version?.binderId)?.name ?? 'Binder plan'}</h1>
          <p>
            {editable
              ? 'Choose a pocket to add a target or manage its physical placement.'
              : 'This archived binder is read-only.'}
          </p>
        </div>
        <div className="binder-header-actions">
          <button className="quiet-button" type="button" onClick={() => window.print()}>
            Print
          </button>
          <button
            className="quiet-button danger-button"
            type="button"
            disabled={pending || !currentBinder}
            onClick={() => {
              setDeleteOpen(true);
              setDeleteName('');
            }}
          >
            Delete binder
          </button>
        </div>
      </header>
      {deleteOpen && currentBinder ? (
        <section
          className="surface binder-delete-confirmation"
          aria-label="Delete binder confirmation"
        >
          <h2>Delete “{currentBinder.name}”?</h2>
          <p>
            This permanently removes this binder and all its pages and versions. Your collection
            cards and quantities stay saved.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (pending || deleteName !== currentBinder.name) return;
              const stillHere = captureNavigation();
              setPending(true);
              void api
                .deleteBinder(currentBinder.id, deleteName)
                .then(async () => {
                  if (stillHere()) showLibrary('replace');
                  await loadBinders();
                  onNotice({
                    kind: 'success',
                    message: 'Binder deleted. Your collection cards are unchanged.',
                  });
                })
                .catch((error: unknown) => onNotice({ kind: 'error', message: userMessage(error) }))
                .finally(() => {
                  if (stillHere()) setPending(false);
                });
            }}
          >
            <label>
              Type the binder name to confirm
              <input
                value={deleteName}
                maxLength={120}
                disabled={pending}
                onChange={(event) => setDeleteName(event.target.value)}
              />
            </label>
            <div className="binder-header-actions">
              <button
                className="quiet-button"
                type="button"
                disabled={pending}
                onClick={() => {
                  setDeleteOpen(false);
                  setDeleteName('');
                }}
              >
                Cancel deletion
              </button>
              <button
                className="quiet-button danger-button"
                type="submit"
                disabled={pending || deleteName !== currentBinder.name}
              >
                Permanently delete binder
              </button>
            </div>
          </form>
        </section>
      ) : null}
      {managementOpen ? (
        <PocketPanel
          anchor={null}
          title="Manage binder"
          wide
          onClose={() => setManagementOpen(false)}
        >
          {mutationError ? <p role="alert">{mutationError}</p> : null}
          {reservedPage && editable && version ? (
            <button
              className="quiet-button"
              type="button"
              disabled={pending}
              onClick={() =>
                void mutate(
                  () => api.reservePage(version.id, page, false, null, version.revision),
                  'Page reservation removed.',
                )
              }
            >
              Unreserve this page
            </button>
          ) : null}{' '}
          {editable && version ? (
            <BinderCapacityControls
              canReservePage={!reservedPage}
              face={face}
              capacity={capacity}
              resize={resize}
              reservation={pageReservation}
              pending={pending}
              onResizeChange={setResize}
              onResize={(value) =>
                void mutate(
                  () => api.resizeBinder(version.id, value, version.revision),
                  'Binder capacity changed deliberately.',
                ).then((resized) => {
                  if (resized) setResize((current) => (current === resize ? '' : current));
                })
              }
              onReservationChange={setPageReservation}
              onReservePage={(label) =>
                void mutate(
                  () => api.reservePage(version.id, page, true, label, version.revision),
                  'Page reserved.',
                ).then((reserved) => {
                  if (reserved)
                    setPageReservation((current) => (current === pageReservation ? '' : current));
                })
              }
              onArrange={() =>
                void mutate(
                  () => api.arrangeBinder(version.id, 'pokedex-number', version.revision),
                  'Targets arranged with reservations anchored.',
                )
              }
            />
          ) : null}
        </PocketPanel>
      ) : null}
      {insertOpen && version ? (
        <BinderInsertDialog
          versionId={version.id}
          revision={version.revision}
          error={mutationError}
          at={insertAt}
          onNotice={onNotice}
          onClose={() => setInsertOpen(false)}
          onInsert={(at, entries, revision) =>
            mutate(
              () => api.insertEntries(version.id, at, entries, revision),
              'Targets inserted.',
              at,
            )
          }
        />
      ) : null}
      <BinderUsage summary={summary} counts={counts} capacity={capacity} />
      <BinderPageToolbar
        key={version?.id}
        onInsert={() => {
          setTool(null);
          setManagementOpen(false);
          setInsertAt(null);
          setInsertOpen(true);
        }}
        onManage={() => {
          setTool(null);
          setInsertOpen(false);
          setManagementOpen((open) => !open);
        }}
        managementOpen={managementOpen}
        pending={pending}
        editable={editable}
        page={page}
        pageCount={version?.pageCount ?? 1}
        canRemove={currentPage !== null}
        status={status}
        onGo={(next) => {
          setTool(null);
          if (version) void load(version.id, next);
        }}
        onPrevious={() => version && void load(version.id, page - 1)}
        onNext={() => version && void load(version.id, page + 1)}
        onEarlier={() => reorderCurrentPage(-1)}
        onLater={() => reorderCurrentPage(1)}
        onArrange={() => {
          if (version)
            void mutate(
              () => api.arrangeBinder(version.id, 'pokedex-number', version.revision),
              'Targets arranged with reservations anchored.',
            );
        }}
        onRemove={() => {
          if (version && currentPage)
            void mutate(
              () => api.deletePage(version.id, currentPage.id, version.revision),
              'Page removed.',
            );
        }}
      />
      <div className="binder-workspace">
        <BinderGrid
          page={page}
          currentPage={currentPage}
          columns={version?.layout.columns ?? 1}
          rows={version?.layout.rows ?? 1}
          pending={pending}
          editable={editable}
          selected={selected}
          moveSource={moveSource}
          cards={cards}
          onNotice={onNotice}
          onSelect={(at) => {
            setTool(null);
            void select(at);
          }}
          onTool={(nextTool) => {
            if (nextTool === 'insert') {
              setTool(null);
              setManagementOpen(false);
              setInsertAt(selected);
              setInsertOpen(true);
              return;
            }
            setTool(nextTool);
            if (nextTool === 'same' || nextTool === 'any') startReplacement(nextTool);
            else setReplacement(null);
          }}
          onMove={moveOrSwap}
          onPickUp={(at) => {
            setMoveSource(at);
            setStatus('Card picked up. Choose a destination pocket.');
          }}
          onUnassign={(at) => {
            if (version)
              void mutate(
                () => api.assignEntry(version.id, at, null, version.revision),
                'Physical placement removed.',
                at,
              );
          }}
          onCancelMove={() => setMoveSource(null)}
        />
        {tool && selected ? (
          <PocketPanel anchor={selected} title="Pocket editor" onClose={() => setTool(null)}>
            {mutationError ? <p role="alert">{mutationError}</p> : null}
            {editable && selected && !reservedPage && replacement !== null ? (
              <section className="slot-picker-panel" aria-labelledby="slot-picker-heading">
                <div className="slot-picker-heading">
                  <div>
                    <h2 id="slot-picker-heading">
                      {replacement === 'same'
                        ? 'Replace with the same type'
                        : replacement
                          ? 'Replace with any card'
                          : `Choose a card for pocket ${selected.row + 1}:${selected.column + 1}`}
                    </h2>
                    <p>
                      {replacement
                        ? 'Choose a replacement for this sleeve. Other sleeves stay in place.'
                        : "Search the catalogue to set this sleeve's exact card target."}
                    </p>
                  </div>
                </div>
                <form
                  className="card-picker"
                  role="search"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void searchLegacyCards();
                  }}
                >
                  <label>
                    Search cards
                    <input
                      value={legacyQuery}
                      placeholder="Pokémon, set, number, rarity, or artist"
                      onChange={(event) => setLegacyQuery(event.target.value)}
                    />
                  </label>
                  <button
                    className="quiet-button"
                    type="submit"
                    disabled={pending || searchState === 'loading'}
                  >
                    Find cards
                  </button>
                </form>
                <p className="card-search-status" role="status">
                  {searchState === 'loading'
                    ? 'Loading cards…'
                    : searchState === 'loaded' && !legacyResults.length
                      ? 'No matching cards found.'
                      : ''}
                </p>
                {legacyResults.length ? (
                  <div className="binder-card-options" aria-label="Exact card targets">
                    {legacyResults.map((card) => (
                      <CardTile
                        className="binder-tray-card"
                        key={card.id}
                        disabled={pending}
                        onClick={() => void chooseExactTarget(card)}
                        art={<CardArt src={card.imageLowUrl} highSrc={card.imageHighUrl} alt="" />}
                        title={card.name}
                        subtitle={`${card.setName} · ${card.number}`}
                        quantity={card.collection?.quantity ?? 0}
                      />
                    ))}
                  </div>
                ) : null}
              </section>
            ) : null}
            {selected ? (
              <>
                <p>
                  {place(selected)}: {selectedSlot ? label(selectedSlot, cards) : 'empty pocket'}.
                </p>
                {editable && !target && tool === 'reserve' ? (
                  <>
                    <label>
                      Reservation label (optional)
                      <input
                        value={reservation}
                        disabled={pending || selectedSlot?.entryKind === 'reserved'}
                        maxLength={120}
                        onChange={(event) => setReservation(event.target.value)}
                      />
                    </label>
                    <button
                      className="quiet-button tone-accent"
                      type="button"
                      disabled={pending || selectedSlot?.entryKind === 'reserved'}
                      onClick={insert}
                    >
                      Reserve this sleeve
                    </button>
                  </>
                ) : null}
                {editable && (target || selectedSlot?.entryKind === 'reserved') && version ? (
                  <>
                    <section className="pocket-action-group" hidden={tool !== 'shift'}>
                      <h3>Insert a gap / shift sleeves</h3>
                      <p>
                        Shift this target and every later target together. Positive numbers leave
                        empty sleeves here; negative numbers need empty sleeves before this target.
                        Page breaks stay on page boundaries.
                      </p>
                      <label>
                        Shift by sleeves
                        <input
                          type="number"
                          value={offset}
                          onChange={(event) => setOffset(event.target.value)}
                        />
                      </label>
                      <button
                        className="quiet-button"
                        type="button"
                        disabled={
                          pending || !Number.isInteger(Number(offset)) || Number(offset) === 0
                        }
                        onClick={() =>
                          void mutate(
                            () =>
                              api.moveEntry(version.id, selected, Number(offset), version.revision),
                            'Selected and later targets shifted.',
                          ).then((shifted) => {
                            if (shifted)
                              setOffset((current) => (current === offset ? '1' : current));
                          })
                        }
                      >
                        Shift targets
                      </button>
                    </section>
                    <section className="pocket-action-group" hidden={tool !== 'remove'}>
                      <h3>Remove card</h3>
                      <button
                        className="quiet-button"
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          void mutate(
                            () =>
                              api.setSlot(version.id, {
                                ...selected,
                                cardId: null,
                                expectedRevision: version.revision,
                              }),
                            'Card removed. The sleeve is now empty.',
                          )
                        }
                      >
                        Remove card and leave gap
                      </button>
                      <button
                        className="quiet-button"
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          void mutate(
                            () => api.removeEntry(version.id, selected, version.revision),
                            'Target removed and later targets closed the gap.',
                          )
                        }
                      >
                        Remove and close gap
                      </button>
                    </section>
                    <section className="pocket-action-group" hidden={tool !== 'placement'}>
                      <h3>Owned copies and page break</h3>
                      <h3>Physical placement</h3>
                      <p>
                        {selectedSlot?.assignedCardId
                          ? 'This target has an assigned owned card.'
                          : 'This target is planned but does not have a physical card assigned.'}
                      </p>
                      {candidateState === 'loading' ? (
                        <p role="status" aria-live="polite">
                          Loading compatible unassigned copies.
                        </p>
                      ) : candidates.length ? (
                        <ul className="binder-candidates">
                          {candidates.map((candidate) => (
                            <li key={candidate.cardId}>
                              <button
                                type="button"
                                disabled={pending || candidate.available === 0}
                                onClick={() =>
                                  void mutate(
                                    () =>
                                      api.assignEntry(
                                        version.id,
                                        selected,
                                        candidate.cardId,
                                        version.revision,
                                      ),
                                    `${candidate.name} assigned.`,
                                  )
                                }
                              >
                                {candidate.name} ({candidate.setName} {candidate.number}) ·{' '}
                                {candidate.available} compatible cop
                                {candidate.available === 1 ? 'y' : 'ies'} remaining
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : candidateState === 'loaded' ? (
                        <p>No compatible unassigned copies are available.</p>
                      ) : null}
                      <button
                        className="quiet-button"
                        type="button"
                        disabled={pending || !selectedSlot?.assignedCardId}
                        onClick={() =>
                          void mutate(
                            () => api.assignEntry(version.id, selected, null, version.revision),
                            'Physical placement removed.',
                          )
                        }
                      >
                        Remove physical placement
                      </button>
                      <label className="checkbox-row">
                        <input
                          type="checkbox"
                          checked={selectedSlot?.startsNewPage === true}
                          onChange={(event) =>
                            void mutate(
                              () =>
                                api.setPageBreak(
                                  version.id,
                                  selected,
                                  event.target.checked,
                                  version.revision,
                                ),
                              event.target.checked
                                ? 'Target starts a new page.'
                                : 'Page break removed.',
                            )
                          }
                        />{' '}
                        Start this target on a new page
                      </label>
                    </section>
                  </>
                ) : null}
              </>
            ) : (
              <p>
                {reservedPage
                  ? 'This page is reserved. Unreserve it before editing pockets.'
                  : 'Select a pocket to edit it.'}
              </p>
            )}
          </PocketPanel>
        ) : null}
      </div>
    </>
  );
}
