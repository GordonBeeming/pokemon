import {
  cardIdSchema,
  binderCapacityErrorSchema,
  binderSlotLocationSchema,
  NATIONAL_POKEDEX,
  type BinderAssignmentCandidate,
  type BinderEntry,
  type BinderLayout,
  type BinderSlot,
  type BinderSlotLocation,
  type CardId,
} from '@pokedex/shared';
import { useEffect, useMemo, useRef, useState, type ReactElement, type RefObject } from 'react';
import {
  api,
  ApiError,
  type BinderMutationResult,
  type BinderFullPokedexPreview,
  type BinderPlannerSummary,
  type BinderVersionPages,
  type BinderView,
  type CatalogueCardView,
} from './api';
import { userMessage, type Notice } from './ui';
import { CardArt } from './card-art';
import { CardTile } from './card-tile';

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
  if (!Number.isInteger(capacity) || capacity < 1) return 'Enter at least 1 pocket.';
  const pages = Math.ceil(capacity / face);
  const finalPage = capacity % face || face;
  const pageLabel = pages === 1 ? 'page face' : 'page faces';
  const pocketLabel = finalPage === 1 ? 'pocket' : 'pockets';
  const partial = finalPage < face ? ` The final page has ${finalPage} ${pocketLabel}.` : '';
  return `${capacity.toLocaleString('en-AU')} maximum pockets across ${pages.toLocaleString('en-AU')} ${pageLabel}.${partial}`;
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
          Maximum pockets
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

function FullPokedexConfirmation({
  requirement,
  regionBreaks,
  pending,
  cancelRef,
  onRegionBreaks,
  onCancel,
  onConfirm,
  onGrow,
}: {
  requirement: BinderFullPokedexPreview | null;
  regionBreaks: boolean;
  pending: boolean;
  cancelRef: RefObject<HTMLButtonElement | null>;
  onRegionBreaks: (value: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
  onGrow: () => void;
}): ReactElement {
  return (
    <section
      className="surface activity-panel"
      role="dialog"
      aria-modal="false"
      aria-labelledby="full-pokedex-heading"
      aria-busy={requirement === null}
    >
      <h2 id="full-pokedex-heading">Insert the full National Pokédex?</h2>
      <p>
        This adds 1,025 Pokémon targets at the selected pocket. It does not synchronise the
        catalogue.
      </p>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={regionBreaks}
          onChange={(event) => onRegionBreaks(event.target.checked)}
        />{' '}
        Start each region on a new page
      </label>
      {requirement === null ? (
        <p role="status" aria-live="polite">
          Checking the capacity needed for this insert.
        </p>
      ) : null}
      {requirement ? (
        <p>
          Current capacity: {requirement.currentCapacity}. Required capacity:{' '}
          {requirement.requiredCapacity}. Additional pockets: {requirement.additionalPockets}.
          Generated padding: {requirement.generatedPadding}.
        </p>
      ) : null}
      <div className="header-actions">
        <button ref={cancelRef} className="quiet-button" type="button" onClick={onCancel}>
          Cancel
        </button>
        <button
          className="quiet-button tone-accent"
          type="button"
          disabled={!requirement || pending || requirement.additionalPockets > 0}
          onClick={onConfirm}
        >
          Confirm insert
        </button>
        {requirement?.additionalPockets ? (
          <button className="quiet-button" type="button" disabled={pending} onClick={onGrow}>
            Grow binder first
          </button>
        ) : null}
      </div>
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
  onNext: () => void;
  onEarlier: () => void;
  onLater: () => void;
  onArrange: () => void;
  onRemove: () => void;
}): ReactElement {
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
      <nav className="binder-page-stepper" aria-label="Binder pages">
        <button
          className="quiet-button"
          type="button"
          disabled={pending || page === 0}
          onClick={onPrevious}
        >
          Previous
        </button>
        <span>
          Page {page + 1} of {pageCount}
        </span>
        <button
          className="quiet-button"
          type="button"
          disabled={pending || page + 1 >= pageCount}
          onClick={onNext}
        >
          Next
        </button>
      </nav>
      <div className="page-menu" ref={menu}>
        <button
          className="icon-button"
          type="button"
          aria-label="Page actions"
          aria-expanded={open}
          ref={trigger}
          onClick={() => setOpen((current) => !current)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 12h.01M12 12h.01M19 12h.01" />
          </svg>
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
      <p role="status" aria-live="polite">
        {status}
      </p>
    </div>
  );
}

function BinderGrid({
  page,
  currentPage,
  columns,
  pending,
  editable,
  selected,
  moveSource,
  candidateState,
  candidates,
  cards,
  onNotice,
  onSelect,
  onMove,
  onPickUp,
  onUnassign,
  onCancelMove,
}: {
  page: number;
  currentPage: BinderVersionPages['pages'][number] | null;
  columns: number;
  pending: boolean;
  editable: boolean;
  selected: BinderSlotLocation | null;
  moveSource: BinderSlotLocation | null;
  candidateState: 'idle' | 'loading' | 'loaded';
  candidates: BinderAssignmentCandidate[];
  cards: Map<string, CatalogueCardView>;
  onNotice: (notice: Notice) => void;
  onSelect: (at: BinderSlotLocation) => void;
  onMove: (source: BinderSlotLocation, target: BinderSlotLocation) => void;
  onPickUp: (at: BinderSlotLocation) => void;
  onUnassign: (at: BinderSlotLocation) => void;
  onCancelMove: () => void;
}): ReactElement {
  const reservedPage = currentPage?.kind === 'reserved';
  return (
    <section
      className={`binder-page ${reservedPage ? 'reserved-binder-page' : ''}`}
      aria-label={reservedPage ? `Reserved binder page ${page + 1}` : `Binder page ${page + 1}`}
    >
      {reservedPage ? (
        <p className="reserved-page-label">
          Reserved page{currentPage.label ? `: ${currentPage.label}` : ''}
        </p>
      ) : null}
      <div
        className="binder-grid"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(4rem, 1fr))` }}
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
                : selectedTarget && candidateState === 'loaded'
                  ? candidates.some((candidate) => candidate.available > 0)
                    ? 'ready'
                    : 'missing'
                  : 'target';
          const card = slot.assignedCardId
            ? cards.get(slot.assignedCardId)
            : slot.cardId
              ? cards.get(slot.cardId)
              : null;
          return (
            <button
              key={`${slot.row}-${slot.column}`}
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
              {card ? <CardArt src={card.imageLowUrl} highSrc={card.imageHighUrl} alt="" /> : null}
              <strong title={label(slot, cards)}>{visualLabel(slot, cards)}</strong>
              <small>
                {slot.assignedCardId
                  ? `Placed: ${card?.name ?? 'owned card'}`
                  : selectedTarget && candidateState === 'loading'
                    ? 'Checking owned copies'
                    : state === 'ready'
                      ? 'Ready to place'
                      : state === 'missing'
                        ? 'No unassigned copy'
                        : state === 'target'
                          ? 'Target planned'
                          : state}
              </small>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function BinderCapacityControls({
  face,
  capacity,
  resize,
  reservation,
  pending,
  canInsertFull,
  fullPreviewTrigger,
  onResizeChange,
  onResize,
  onReservationChange,
  onReservePage,
  onArrange,
  onInsertFull,
}: {
  face: number;
  capacity: number;
  resize: string;
  reservation: string;
  pending: boolean;
  canInsertFull: boolean;
  fullPreviewTrigger: RefObject<HTMLButtonElement | null>;
  onResizeChange: (value: string) => void;
  onResize: (value: number) => void;
  onReservationChange: (value: string) => void;
  onReservePage: (label: string | null) => void;
  onArrange: () => void;
  onInsertFull: () => void;
}): ReactElement {
  const value = Number(resize || capacity);
  const invalid = !Number.isInteger(value) || value < 1;
  return (
    <>
      <hr />
      <h3>Binder capacity</h3>
      <label htmlFor="binder-capacity-input">
        Maximum pockets
        <input
          id="binder-capacity-input"
          type="number"
          min="1"
          step="1"
          value={resize || capacity}
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
          maxLength={120}
          onChange={(event) => onReservationChange(event.target.value)}
        />
      </label>
      <button
        className="quiet-button"
        type="button"
        disabled={pending}
        onClick={() => onReservePage(reservation.trim() || null)}
      >
        Reserve this page
      </button>
      <button className="quiet-button" type="button" disabled={pending} onClick={onArrange}>
        Arrange targets
      </button>
      <button
        ref={fullPreviewTrigger}
        className="quiet-button"
        type="button"
        disabled={pending || !canInsertFull}
        onClick={onInsertFull}
      >
        Insert full National Pokédex
      </button>
    </>
  );
}

function useBinderPlanner(onNotice: (notice: Notice) => void) {
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
  const [kind, setKind] = useState<BinderEntry['kind']>('exact-card');
  const [number, setNumber] = useState(1);
  const [cardId, setCardId] = useState('');
  const [reservation, setReservation] = useState('');
  const [offset, setOffset] = useState('1');
  const [resize, setResize] = useState('');
  const [regionBreaks, setRegionBreaks] = useState(true);
  const [fullPreview, setFullPreview] = useState(false);
  const [moveSource, setMoveSource] = useState<BinderSlotLocation | null>(null);
  const [summary, setSummary] = useState<BinderPlannerSummary | null>(null);
  const [fullRequirement, setFullRequirement] = useState<BinderFullPokedexPreview | null>(null);
  const [legacyQuery, setLegacyQuery] = useState('');
  const [legacyResults, setLegacyResults] = useState<CatalogueCardView[]>([]);
  const pendingPocketFocus = useRef<BinderSlotLocation | null>(null);
  const candidateController = useRef<AbortController | null>(null);
  const candidateGeneration = useRef(0);
  const fullPreviewTrigger = useRef<HTMLButtonElement | null>(null);
  const fullPreviewCancel = useRef<HTMLButtonElement | null>(null);
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
  async function loadBinders(): Promise<void> {
    setBinders(await api.binders());
  }
  async function load(id: string, next: number): Promise<void> {
    setPending(true);
    try {
      const data = await api.binder(id, next, 1);
      const ids: CardId[] = [];
      for (const slot of data.pages.flatMap((item) => item.slots)) {
        if (slot.cardId) ids.push(slot.cardId);
        if (slot.assignedCardId) ids.push(slot.assignedCardId);
      }
      const [resolved, nextSummary] = await Promise.all([
        ids.length ? api.resolveCards([...new Set(ids)]) : Promise.resolve([]),
        api.plannerSummary(id),
      ]);
      setCards(
        (current) => new Map([...current, ...resolved.map((card) => [card.id, card] as const)]),
      );
      setBinder(data);
      setSummary(nextSummary);
      setPage(next);
      setSelected(null);
      setCandidates([]);
      setCandidateState('idle');
      setStatus(`Page ${next + 1} loaded.`);
    } catch (error) {
      onNotice({ kind: 'error', message: userMessage(error) });
    } finally {
      setPending(false);
    }
  }
  useEffect(() => {
    void loadBinders().catch((error: unknown) =>
      onNotice({ kind: 'error', message: userMessage(error) }),
    );
  }, []);
  useEffect(() => () => candidateController.current?.abort(), []);
  useEffect(() => {
    const at = pendingPocketFocus.current;
    if (!at) return;
    if (at.page !== page) {
      pendingPocketFocus.current = null;
      return;
    }
    pendingPocketFocus.current = null;
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLButtonElement>(`[data-binder-slot="${at.page}-${at.row}-${at.column}"]`)
        ?.focus();
    });
  }, [binder, page]);
  useEffect(() => {
    if (!fullPreview) return;
    requestAnimationFrame(() => fullPreviewCancel.current?.focus());
  }, [fullPreview]);
  useEffect(() => {
    if (!fullPreview || !version || !selected) return;
    const controller = new AbortController();
    setFullRequirement(null);
    void api
      .previewFullPokedex(version.id, selected, regionBreaks, version.revision, controller.signal)
      .then((preview) => setFullRequirement(preview))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        onNotice({ kind: 'error', message: userMessage(error) });
        setFullPreview(false);
        fullPreviewTrigger.current?.focus();
      });
    return () => controller.abort();
  }, [fullPreview, onNotice, regionBreaks, selected, version]);
  useEffect(() => {
    if (!fullPreview) return;
    const close = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setFullPreview(false);
      fullPreviewTrigger.current?.focus();
    };
    addEventListener('keydown', close);
    return () => removeEventListener('keydown', close);
  }, [fullPreview]);
  async function mutate(
    action: () => Promise<BinderMutationResult>,
    message: string,
    focusAt: BinderSlotLocation | null = selected,
  ): Promise<boolean> {
    if (!version) return false;
    setPending(true);
    try {
      const result = await action();
      pendingPocketFocus.current = focusAt;
      await load(result.version.id, binderMutationPage(result, page).position);
      setStatus(message);
      onNotice({ kind: 'success', message });
      return true;
    } catch (error) {
      pendingPocketFocus.current = null;
      if (error instanceof ApiError && error.code === 'binder_capacity_exceeded') {
        const details = binderCapacityErrorSchema.safeParse(error.details);
        const required = details.success ? details.data.requiredCapacity : capacity + face;
        setResize(String(required + ((face - (required % face)) % face)));
        setStatus('This action needs more capacity. Resize is ready below.');
      }
      onNotice({ kind: 'error', message: userMessage(error) });
      return false;
    } finally {
      setPending(false);
    }
  }
  async function select(at: BinderSlotLocation): Promise<void> {
    if (!version) return;
    candidateController.current?.abort();
    const generation = ++candidateGeneration.current;
    setSelected(at);
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
        setStatus(`Loading compatible copies for ${place(at)}.`);
        const found = await api.assignmentCandidates(version.id, at, controller.signal);
        if (generation === candidateGeneration.current) {
          setCandidates(found);
          setCandidateState('loaded');
          setStatus(`${found.length} compatible copies loaded.`);
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
  const matchingPokemon = NATIONAL_POKEDEX.filter((entry) =>
    `${entry.number} ${entry.name} ${entry.discoveryCategory}`
      .toLocaleLowerCase('en-AU')
      .includes(cardId.trim().toLocaleLowerCase('en-AU')),
  ).slice(0, 12);
  async function searchLegacyCards(): Promise<void> {
    try {
      const result = await api.search(
        new URLSearchParams({ q: legacyQuery, limit: '24', offset: '0' }),
      );
      setLegacyResults(result.cards);
    } catch (error) {
      onNotice({ kind: 'error', message: userMessage(error) });
    }
  }
  async function chooseExactTarget(card: CatalogueCardView): Promise<void> {
    if (!version || !selected) return;
    const placed = await mutate(
      () =>
        api.insertEntries(
          version.id,
          selected,
          [{ kind: 'exact-card', cardId: card.id, startsNewPage: false }],
          version.revision,
        ),
      `${card.name} is now the exact target for pocket ${selected.row + 1}:${selected.column + 1}.`,
    );
    if (placed) {
      setSelected(null);
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
    const exactCardId = kind === 'exact-card' ? cardIdSchema.safeParse(cardId.trim()) : null;
    if (exactCardId && !exactCardId.success) {
      onNotice({ kind: 'error', message: 'Choose an exact card from the search results.' });
      return;
    }
    const entry: BinderEntry =
      kind === 'reserved'
        ? { kind, label: reservation.trim() || null }
        : kind === 'exact-card' && exactCardId?.success
          ? { kind, cardId: exactCardId.data, startsNewPage: false }
          : { kind: 'pokemon', pokemonNumber: number, startsNewPage: false };
    void mutate(
      () => api.insertEntries(version.id, selected, [entry], version.revision),
      'Pocket inserted.',
    );
  };
  const dismissPocketEditor = (): void => {
    const anchor = selected
      ? document.querySelector<HTMLButtonElement>(
          `[data-binder-slot="${selected.page}-${selected.row}-${selected.column}"]`,
        )
      : null;
    setSelected(null);
    setCandidates([]);
    setCandidateState('idle');
    setLegacyResults([]);
    requestAnimationFrame(() => anchor?.focus());
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
    setStatus,
    kind,
    setKind,
    number,
    setNumber,
    cardId,
    setCardId,
    reservation,
    setReservation,
    offset,
    setOffset,
    resize,
    setResize,
    regionBreaks,
    setRegionBreaks,
    fullPreview,
    setFullPreview,
    moveSource,
    setMoveSource,
    summary,
    fullRequirement,
    legacyQuery,
    setLegacyQuery,
    legacyResults,
    fullPreviewTrigger,
    fullPreviewCancel,
    version,
    currentPage,
    reservedPage,
    editable,
    face,
    capacity,
    counts,
    loadBinders,
    load,
    mutate,
    select,
    selectedSlot,
    target,
    matchingPokemon,
    searchLegacyCards,
    chooseExactTarget,
    moveOrSwap,
    reorderCurrentPage,
    insert,
    dismissPocketEditor,
  };
}

export function BinderView({ onNotice }: { onNotice: (notice: Notice) => void }): ReactElement {
  const {
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
    setStatus,
    kind,
    setKind,
    number,
    setNumber,
    cardId,
    setCardId,
    reservation,
    setReservation,
    offset,
    setOffset,
    resize,
    setResize,
    regionBreaks,
    setRegionBreaks,
    fullPreview,
    setFullPreview,
    moveSource,
    setMoveSource,
    summary,
    fullRequirement,
    legacyQuery,
    setLegacyQuery,
    legacyResults,
    fullPreviewTrigger,
    fullPreviewCancel,
    version,
    currentPage,
    reservedPage,
    editable,
    face,
    capacity,
    counts,
    loadBinders,
    load,
    mutate,
    select,
    selectedSlot,
    target,
    matchingPokemon,
    searchLegacyCards,
    chooseExactTarget,
    moveOrSwap,
    reorderCurrentPage,
    insert,
    dismissPocketEditor,
  } = useBinderPlanner(onNotice);
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
              setPending(true);
              void api
                .createBinder(name, layout, total)
                .then(async (created) => {
                  setBinder({ version: created.version, pages: created.pages, nextPage: null });
                  await loadBinders();
                  setShowCreate(false);
                })
                .catch((error: unknown) => onNotice({ kind: 'error', message: userMessage(error) }))
                .finally(() => setPending(false));
            }}
          />
        ) : null}
      </>
    );
  return (
    <>
      <header className="page-heading">
        <div>
          <button
            className="text-button back-link"
            type="button"
            onClick={() => {
              setBinder(null);
              setSelected(null);
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
        <button className="quiet-button" type="button" onClick={() => window.print()}>
          Print
        </button>
      </header>
      {editable && selected && !reservedPage && !target && kind === 'exact-card' ? (
        <section className="slot-picker-panel" aria-labelledby="slot-picker-heading">
          <div className="slot-picker-heading">
            <div>
              <h2 id="slot-picker-heading">
                Choose a card for pocket {selected.row + 1}:{selected.column + 1}
              </h2>
              <p>Search the catalogue to set this sleeve's exact card target.</p>
            </div>
            <button
              className="icon-button"
              type="button"
              aria-label="Close pocket editor"
              onClick={dismissPocketEditor}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="m7 7 10 10M17 7 7 17" />
              </svg>
            </button>
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
                autoFocus
                value={legacyQuery}
                placeholder="Pokémon, set, number, rarity, or artist"
                onChange={(event) => setLegacyQuery(event.target.value)}
              />
            </label>
            <button className="quiet-button" type="submit" disabled={pending}>
              Find cards
            </button>
          </form>
          {legacyResults.length ? (
            <div className="binder-card-options" aria-label="Exact card targets">
              {legacyResults.map((card) => (
                <CardTile
                  className="binder-tray-card"
                  key={card.id}
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
      <BinderUsage summary={summary} counts={counts} capacity={capacity} />
      <BinderPageToolbar
        pending={pending}
        editable={editable}
        page={page}
        pageCount={version?.pageCount ?? 1}
        canRemove={currentPage !== null}
        status={status}
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
      <div className="planner-layout">
        <BinderGrid
          page={page}
          currentPage={currentPage}
          columns={version?.layout.columns ?? 1}
          pending={pending}
          editable={editable}
          selected={selected}
          moveSource={moveSource}
          candidateState={candidateState}
          candidates={candidates}
          cards={cards}
          onNotice={onNotice}
          onSelect={(at) => void select(at)}
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
        <aside className="surface shortage-panel" aria-labelledby="binder-actions-heading">
          <h2 id="binder-actions-heading">Pocket editor</h2>
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
          ) : null}
          {selected ? (
            <>
              <p>
                {place(selected)}: {selectedSlot ? label(selectedSlot, cards) : 'empty pocket'}.
              </p>
              {editable && !target ? (
                <>
                  <fieldset className="binder-picker">
                    <legend>
                      {selectedSlot?.entryKind === 'reserved'
                        ? 'Insert before this reserved sleeve'
                        : 'Add to this empty pocket'}
                    </legend>
                    <div>
                      {(['exact-card', 'pokemon', 'reserved'] as const).map((value) => (
                        <button
                          key={value}
                          type="button"
                          aria-pressed={kind === value}
                          onClick={() => setKind(value)}
                        >
                          {value === 'exact-card'
                            ? 'Exact card'
                            : value === 'pokemon'
                              ? 'Pokémon target'
                              : 'Reserve sleeve'}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                  {kind === 'pokemon' ? (
                    <>
                      <label>
                        Find Pokémon
                        <input
                          value={cardId}
                          placeholder="Name, number, or region"
                          onChange={(event) => setCardId(event.target.value)}
                        />
                      </label>
                      <div className="binder-card-options" aria-label="Matching Pokémon">
                        {matchingPokemon.map((entry) => (
                          <button
                            key={entry.number}
                            type="button"
                            className={number === entry.number ? 'selected' : ''}
                            onClick={() => setNumber(entry.number)}
                          >
                            #{String(entry.number).padStart(4, '0')} {entry.name} ·{' '}
                            {entry.discoveryCategory}
                          </button>
                        ))}
                      </div>
                    </>
                  ) : null}
                  {kind === 'exact-card' ? (
                    <p>Use the exact-card search above to choose this sleeve's target.</p>
                  ) : null}
                  {kind === 'reserved' ? (
                    <label>
                      Reservation label (optional)
                      <input
                        value={reservation}
                        maxLength={120}
                        onChange={(event) => setReservation(event.target.value)}
                      />
                    </label>
                  ) : null}
                  <button
                    className="quiet-button tone-accent"
                    type="button"
                    disabled={pending || (kind === 'exact-card' && !cardId.trim())}
                    onClick={insert}
                  >
                    Insert and shift later targets
                  </button>
                  {selectedSlot?.entryKind === 'reserved' && version ? (
                    <button
                      className="quiet-button"
                      type="button"
                      disabled={pending}
                      onClick={() =>
                        void mutate(
                          () => api.removeEntry(version.id, selected, version.revision),
                          'Reserved sleeve removed and later entries closed the gap.',
                        )
                      }
                    >
                      Remove reserved sleeve and close gap
                    </button>
                  ) : null}
                </>
              ) : null}
              {editable && target && version ? (
                <>
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
                  <label>
                    Move signed sleeve offset
                    <input
                      type="number"
                      value={offset}
                      onChange={(event) => setOffset(event.target.value)}
                    />
                  </label>
                  <button
                    className="quiet-button"
                    type="button"
                    disabled={pending || !Number.isInteger(Number(offset)) || Number(offset) === 0}
                    onClick={() =>
                      void mutate(
                        () => api.moveEntry(version.id, selected, Number(offset), version.revision),
                        'Target moved.',
                      )
                    }
                  >
                    Move target
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
          {editable && version && !reservedPage ? (
            <BinderCapacityControls
              face={face}
              capacity={capacity}
              resize={resize}
              reservation={reservation}
              pending={pending}
              canInsertFull={selected !== null}
              fullPreviewTrigger={fullPreviewTrigger}
              onResizeChange={setResize}
              onResize={(value) =>
                void mutate(
                  () => api.resizeBinder(version.id, value, version.revision),
                  'Binder capacity changed deliberately.',
                )
              }
              onReservationChange={setReservation}
              onReservePage={(label) =>
                void mutate(
                  () => api.reservePage(version.id, page, true, label, version.revision),
                  'Page reserved.',
                )
              }
              onArrange={() =>
                void mutate(
                  () => api.arrangeBinder(version.id, 'pokedex-number', version.revision),
                  'Targets arranged with reservations anchored.',
                )
              }
              onInsertFull={() => setFullPreview(true)}
            />
          ) : null}
        </aside>
      </div>
      {fullPreview && version && selected ? (
        <FullPokedexConfirmation
          requirement={fullRequirement}
          regionBreaks={regionBreaks}
          pending={pending}
          cancelRef={fullPreviewCancel}
          onRegionBreaks={setRegionBreaks}
          onCancel={() => {
            setFullPreview(false);
            fullPreviewTrigger.current?.focus();
          }}
          onConfirm={() => {
            setFullPreview(false);
            void mutate(
              () => api.insertFullPokedex(version.id, selected, regionBreaks, version.revision),
              'Full National Pokédex targets inserted.',
            );
          }}
          onGrow={() =>
            void mutate(
              () =>
                api.resizeBinder(version.id, fullRequirement!.requiredCapacity, version.revision),
              'Binder grew to fit the National Pokédex.',
            )
          }
        />
      ) : null}
    </>
  );
}
