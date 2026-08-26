import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import {
  api,
  ApiError,
  type CatalogueCardView,
  type CatalogueDetailView,
  type CollectionState,
  type BinderView,
} from './api';
import { money, userMessage, type Notice } from './ui';
import { SegmentedControl } from './segmented-control';
import { LoadingOverlay } from './loading-overlay';
import { CardArt } from './card-art';
import { CardTile } from './card-tile';
import { Pagination } from './pagination';

const PAGE_SIZE = 50;

function Art({
  card,
  decorative = false,
  highResolution = false,
}: {
  card: CatalogueCardView | CatalogueDetailView;
  decorative?: boolean;
  highResolution?: boolean;
}): ReactElement {
  const image =
    highResolution && 'imageHighUrl' in card
      ? (card.imageHighUrl ?? card.imageLowUrl)
      : card.imageLowUrl;
  return (
    <CardArt
      src={image}
      highSrc={highResolution ? null : card.imageHighUrl}
      alt={decorative ? '' : `${card.name} card art`}
      eager={highResolution}
      announceLoading={highResolution}
      dimmed={(card.collection?.quantity ?? 0) === 0}
    />
  );
}

function DetailPanel({
  card,
  pending,
  pokedexNumber,
  representativePending,
  save,
  addOne,
  useAsRepresentative,
  previous,
  next,
  position,
  total,
  close,
  binders,
  binderId,
  binderPending,
  chooseBinder,
  addToBinder,
}: {
  card: CatalogueDetailView;
  pending: boolean;
  pokedexNumber: number | null;
  representativePending: boolean;
  save: (quantity: number, notes: string | null) => void;
  addOne: () => void;
  useAsRepresentative: () => void;
  previous: () => void;
  next: () => void;
  position: number;
  total: number;
  close: () => void;
  binders: BinderView[];
  binderId: string;
  binderPending: boolean;
  chooseBinder: (id: string) => void;
  addToBinder: () => void;
}): ReactElement {
  const [quantity, setQuantity] = useState(card.collection?.quantity ?? 0);
  const [notes, setNotes] = useState(card.collection?.notes ?? '');
  const dialog = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setQuantity(card.collection?.quantity ?? 0);
    setNotes(card.collection?.notes ?? '');
  }, [card]);
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButton.current?.focus();
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      const target = event.target;
      const editing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable);
      if (editing && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) return;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        previous();
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        next();
        return;
      }
      if (event.key !== 'Tab' || !dialog.current) return;
      const focusable = Array.from(
        dialog.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled)',
        ),
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    addEventListener('keydown', keydown);
    return () => {
      document.body.style.overflow = previousOverflow;
      removeEventListener('keydown', keydown);
    };
  }, [close, next, previous]);
  return (
    <aside
      className="card-lightbox"
      role="dialog"
      aria-modal="true"
      aria-labelledby="card-detail-heading"
      ref={dialog}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <button
        className="lightbox-nav previous"
        type="button"
        aria-label="Previous card"
        onClick={previous}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m14.5 5-7 7 7 7" />
        </svg>
      </button>
      <div className="card-lightbox-panel">
        <div className="lightbox-visual">
          <Art card={card} highResolution />
          <span className="lightbox-position">
            {position} of {total}
          </span>
        </div>
        <div className="detail-copy">
          <div className="detail-heading-row">
            <h2 id="card-detail-heading" tabIndex={-1}>
              {card.name}
            </h2>
            <button
              className="icon-button"
              type="button"
              aria-label="Close card detail"
              ref={closeButton}
              onClick={close}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="m7 7 10 10M17 7 7 17" />
              </svg>
            </button>
          </div>
          <p>
            {card.setName} · {card.number}
          </p>
          <dl>
            <div>
              <dt>Price</dt>
              <dd>{money(card.price.amountAud)}</dd>
            </div>
            <div>
              <dt>Source</dt>
              <dd>
                {card.source.provider} · {card.source.sourceId}
              </dd>
            </div>
          </dl>
          <label>
            Quantity
            <input
              type="number"
              min="0"
              max="9999"
              value={quantity}
              disabled={pending}
              onChange={(event) =>
                setQuantity(Math.min(9999, Math.max(0, Number(event.target.value))))
              }
            />
          </label>
          <label className="notes-field">
            Notes
            <textarea
              value={notes}
              maxLength={2000}
              disabled={pending}
              onChange={(event) => setNotes(event.target.value)}
            />
            <small>{notes.length.toLocaleString('en-AU')} of 2,000 characters</small>
          </label>
          <div className="detail-actions">
            <button
              className="quiet-button tone-accent"
              type="button"
              disabled={pending}
              onClick={() => save(quantity, notes.trim() || null)}
            >
              {pending ? 'Saving…' : 'Save collection state'}
            </button>
            <button
              className="quiet-button"
              type="button"
              disabled={pending || (card.collection?.quantity ?? 0) >= 9999}
              onClick={addOne}
            >
              Add one copy
            </button>
            {pokedexNumber ? (
              <button
                className="quiet-button"
                type="button"
                disabled={pending || representativePending}
                onClick={useAsRepresentative}
              >
                {representativePending ? 'Saving Pokédex image…' : 'Use as Pokédex image'}
              </button>
            ) : null}
          </div>
          <section className="detail-binder" aria-labelledby="detail-binder-heading">
            <h3 id="detail-binder-heading">Add to binder</h3>
            {binders.length ? (
              <>
                <div className="binder-choice-list">
                  {binders.map((binder) => (
                    <button
                      key={binder.id}
                      className="quiet-button"
                      type="button"
                      aria-pressed={binderId === binder.id}
                      onClick={() => chooseBinder(binder.id)}
                    >
                      {binder.name}
                    </button>
                  ))}
                </div>
                <button
                  className="quiet-button tone-accent"
                  type="button"
                  disabled={!binderId || binderPending}
                  onClick={addToBinder}
                >
                  {binderPending ? 'Adding…' : 'Add to selected binder'}
                </button>
              </>
            ) : (
              <p>Create a binder in Binder Plans first.</p>
            )}
          </section>
        </div>
      </div>
      <button className="lightbox-nav next" type="button" aria-label="Next card" onClick={next}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m9.5 5 7 7-7 7" />
        </svg>
      </button>
    </aside>
  );
}

export function CatalogueView({
  initialParams,
  refreshKey,
  indexing,
  indexingError,
  indexingResult,
  retryIndexing,
  onBackToNational,
  onBackToSets,
  onNotice,
}: {
  initialParams: URLSearchParams;
  refreshKey: number;
  indexing: boolean;
  indexingError: string | null;
  indexingResult: string | null;
  retryIndexing: () => void;
  onBackToNational: () => void;
  onBackToSets: () => void;
  onNotice: (notice: Notice) => void;
}): ReactElement {
  const [query, setQuery] = useState(initialParams.get('q') ?? '');
  const [ownership, setOwnership] = useState<'all' | 'owned' | 'missing'>(
    initialParams.get('owned') === 'true'
      ? 'owned'
      : initialParams.get('owned') === 'false'
        ? 'missing'
        : 'all',
  );
  const [customName, setCustomName] = useState('');
  const [cards, setCards] = useState<CatalogueCardView[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [detail, setDetail] = useState<CatalogueDetailView | null>(null);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [representativePending, setRepresentativePending] = useState(false);
  const [binderChoices, setBinderChoices] = useState<BinderView[]>([]);
  const [binderTarget, setBinderTarget] = useState('');
  const [binderAdding, setBinderAdding] = useState(false);
  const [bulkAdding, setBulkAdding] = useState(false);
  const [completedRefresh, setCompletedRefresh] = useState(refreshKey);
  const searchGeneration = useRef(0);
  const searchController = useRef<AbortController | null>(null);
  const detailController = useRef<AbortController | null>(null);
  const preloadedArt = useRef<Map<string, HTMLImageElement>>(new Map());
  const gallery = useRef<HTMLElement>(null);
  const requestedPokedexNumber = Number.parseInt(initialParams.get('pokedexNumber') ?? '', 10);
  const speciesName = initialParams.get('species')?.trim() || null;
  const setId = initialParams.get('setId')?.trim() || null;
  const setName = initialParams.get('setName')?.trim() || cards[0]?.setName || null;
  const pokedexNumber =
    Number.isInteger(requestedPokedexNumber) &&
    requestedPokedexNumber >= 1 &&
    requestedPokedexNumber <= 1025
      ? requestedPokedexNumber
      : null;

  async function search(nextPage: number, params = initialParams): Promise<void> {
    const moved = nextPage !== page;
    const generation = ++searchGeneration.current;
    searchController.current?.abort();
    const controller = new AbortController();
    searchController.current = controller;
    setLoading(true);
    onNotice(null);
    const next = new URLSearchParams(params);
    if (query.trim()) next.set('q', query.trim());
    else next.delete('q');
    if (ownership === 'owned') next.set('owned', 'true');
    else if (ownership === 'missing') next.set('owned', 'false');
    else next.delete('owned');
    next.set('limit', String(PAGE_SIZE));
    next.delete('cursor');
    if (nextPage) next.set('offset', String(nextPage * PAGE_SIZE));
    else next.delete('offset');
    try {
      const result = await api.search(next, controller.signal);
      if (generation !== searchGeneration.current) return;
      setCards(result.cards);
      setTotal(result.total);
      setPage(nextPage);
      setDetail(null);
      setSelectedCardId(null);
      if (moved) requestAnimationFrame(() => gallery.current?.scrollIntoView({ block: 'start' }));
    } catch (error) {
      const message = userMessage(error);
      if (message && generation === searchGeneration.current) onNotice({ kind: 'error', message });
    } finally {
      if (generation === searchGeneration.current) setLoading(false);
    }
  }

  useEffect(() => {
    setQuery(initialParams.get('q') ?? '');
    setOwnership(
      initialParams.get('owned') === 'true'
        ? 'owned'
        : initialParams.get('owned') === 'false'
          ? 'missing'
          : 'all',
    );
    void search(0, initialParams).finally(() => setCompletedRefresh(refreshKey));
    return () => {
      searchController.current?.abort();
      detailController.current?.abort();
    };
  }, [initialParams.toString(), refreshKey]);

  async function openCard(id: string): Promise<void> {
    setSelectedCardId(id);
    detailController.current?.abort();
    const controller = new AbortController();
    detailController.current = controller;
    try {
      const next = await api.card(id, controller.signal);
      setDetail(next);
    } catch (error) {
      const message = userMessage(error);
      if (message) onNotice({ kind: 'error', message });
    }
  }

  const closeDetail = useCallback((): void => {
    const cardId = selectedCardId;
    setDetail(null);
    setSelectedCardId(null);
    requestAnimationFrame(() => {
      if (cardId) document.querySelector<HTMLButtonElement>(`[data-card-id="${cardId}"]`)?.focus();
    });
  }, [selectedCardId]);

  const moveDetail = useCallback(
    (delta: -1 | 1): void => {
      if (!selectedCardId || cards.length === 0) return;
      const current = cards.findIndex((card) => card.id === selectedCardId);
      const nextIndex = (Math.max(0, current) + delta + cards.length) % cards.length;
      const nextCard = cards[nextIndex];
      if (nextCard) void openCard(nextCard.id);
    },
    [cards, selectedCardId],
  );

  const previousCard = useCallback(() => moveDetail(-1), [moveDetail]);
  const nextCard = useCallback(() => moveDetail(1), [moveDetail]);

  async function loadBinderChoices(): Promise<void> {
    if (binderChoices.length) return;
    try {
      const items = await api.binders();
      setBinderChoices(items);
      setBinderTarget((current) => current || items[0]?.id || '');
    } catch (error) {
      const message = userMessage(error);
      if (message) onNotice({ kind: 'error', message });
    }
  }

  useEffect(() => {
    if (!detail || binderChoices.length) return;
    void loadBinderChoices();
  }, [binderChoices.length, detail]);

  async function addDetailToBinder(): Promise<void> {
    if (!detail || !binderTarget) return;
    const target = binderChoices.find((binder) => binder.id === binderTarget);
    const versionId = target?.activeVersionId ?? target?.latestVersionId;
    if (!versionId) return;
    setBinderAdding(true);
    try {
      const current = await api.binder(versionId);
      await api.addCardsToBinder(current.version.id, [detail.id], current.version.revision);
      onNotice({
        kind: 'success',
        message: `${detail.name} was added to ${target?.name ?? 'the binder'}.`,
      });
    } catch (error) {
      const message = userMessage(error);
      if (message) onNotice({ kind: 'error', message });
    } finally {
      setBinderAdding(false);
    }
  }

  async function addCurrentResultsToBinder(): Promise<void> {
    if (!binderTarget || total > 2000) return;
    const target = binderChoices.find((binder) => binder.id === binderTarget);
    const versionId = target?.activeVersionId ?? target?.latestVersionId;
    if (!versionId) return;
    setBulkAdding(true);
    try {
      const cardIds: string[] = [];
      let cursor: string | null = null;
      do {
        const params = new URLSearchParams(initialParams);
        params.delete('setName');
        if (query.trim()) params.set('q', query.trim());
        else params.delete('q');
        if (ownership === 'owned') params.set('owned', 'true');
        else if (ownership === 'missing') params.set('owned', 'false');
        else params.delete('owned');
        params.set('limit', '100');
        params.delete('offset');
        if (cursor) params.set('cursor', cursor);
        else params.delete('cursor');
        const result = await api.search(params);
        cardIds.push(...result.cards.map((card) => card.id));
        cursor = result.cursor;
        if (cardIds.length > 2000) throw new Error('A binder can hold at most 2,000 cards.');
      } while (cursor);
      const current = await api.binder(versionId);
      await api.addCardsToBinder(current.version.id, cardIds, current.version.revision);
      onNotice({
        kind: 'success',
        message: `${cardIds.length} cards were added to ${target?.name ?? 'the binder'} in catalogue order.`,
      });
    } catch (error) {
      const message = userMessage(error);
      if (message) onNotice({ kind: 'error', message });
    } finally {
      setBulkAdding(false);
    }
  }

  function applyState(state: CollectionState): void {
    setCards((current) =>
      current.map((card) => (card.id === state.cardId ? { ...card, collection: state } : card)),
    );
    setDetail((current) =>
      current?.id === state.cardId
        ? { ...current, collection: state, notes: state.notes }
        : current,
    );
  }

  async function save(quantity: number, notes: string | null): Promise<void> {
    if (!detail) return;
    setSaving(true);
    onNotice(null);
    try {
      const currentQuantity = detail.collection?.quantity ?? 0;
      const expectedRevision = detail.collection?.revision ?? 0;
      const state =
        quantity === currentQuantity
          ? await api.patchCollectionNotes(detail.id, {
              mutationId: crypto.randomUUID(),
              expectedRevision,
              notes,
            })
          : await api.setCollection(detail.id, {
              mutationId: crypto.randomUUID(),
              expectedRevision,
              quantity,
              notes,
            });
      applyState(state);
      onNotice({ kind: 'success', message: 'Collection state saved.' });
    } catch (error) {
      const message = userMessage(error);
      if (message) onNotice({ kind: 'error', message });
      if (error instanceof ApiError && error.code === 'collection_revision_conflict')
        await openCard(detail.id);
    } finally {
      setSaving(false);
    }
  }

  async function addOne(): Promise<void> {
    if (!detail) return;
    setSaving(true);
    onNotice(null);
    try {
      const state = await api.incrementCollection(detail.id, {
        mutationId: crypto.randomUUID(),
        delta: 1,
      });
      applyState(state);
      onNotice({ kind: 'success', message: 'Added one copy.' });
    } catch (error) {
      const message = userMessage(error);
      if (message) onNotice({ kind: 'error', message });
    } finally {
      setSaving(false);
    }
  }

  async function createCustom(): Promise<void> {
    if (!customName.trim()) return;
    setCreating(true);
    try {
      await api.createCustomCard({
        name: customName.trim(),
        language: 'en',
        category: 'special',
        setId: 'custom',
        setName: 'Custom cards',
        number: 'custom',
      });
      setCustomName('');
      await search(0, new URLSearchParams());
      onNotice({ kind: 'success', message: 'Custom card added.' });
    } catch (error) {
      const message = userMessage(error);
      if (message) onNotice({ kind: 'error', message });
    } finally {
      setCreating(false);
    }
  }

  async function useAsRepresentative(): Promise<void> {
    if (!detail || !pokedexNumber) return;
    setRepresentativePending(true);
    onNotice(null);
    try {
      await api.setNationalRepresentative(pokedexNumber, detail.id);
      onNotice({
        kind: 'success',
        message: `${detail.name} from ${detail.setName} is now the National Pokédex image.`,
      });
    } catch (error) {
      const message = userMessage(error);
      if (message) onNotice({ kind: 'error', message });
    } finally {
      setRepresentativePending(false);
    }
  }

  const first = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const last = Math.min(total, page * PAGE_SIZE + cards.length);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const busy = loading || indexing || completedRefresh !== refreshKey;
  const detailIndex = detail ? cards.findIndex((card) => card.id === detail.id) : -1;

  useEffect(() => {
    if (detailIndex < 0 || cards.length < 2) return;
    for (const offset of [-1, 1]) {
      const neighbour = cards[(detailIndex + offset + cards.length) % cards.length];
      const source = neighbour?.imageHighUrl;
      if (!source || preloadedArt.current.has(source)) continue;
      const image = new Image();
      image.decoding = 'async';
      image.src = source;
      preloadedArt.current.set(source, image);
    }
    while (preloadedArt.current.size > 6) {
      const oldest = preloadedArt.current.keys().next().value;
      if (typeof oldest !== 'string') break;
      preloadedArt.current.delete(oldest);
    }
  }, [cards, detailIndex]);
  return (
    <>
      <header className="page-heading catalogue-heading">
        <div>
          {pokedexNumber ? (
            <button className="text-button back-link" type="button" onClick={onBackToNational}>
              Back to National Pokédex
            </button>
          ) : setId ? (
            <button className="text-button back-link" type="button" onClick={onBackToSets}>
              Back to Set checklists
            </button>
          ) : null}
          <h1>
            {speciesName
              ? `${speciesName} card gallery.`
              : setId
                ? `${setName ?? 'Set'} card gallery.`
                : 'Find a physical card.'}
          </h1>
          <p>
            {speciesName
              ? `Choose the exact ${speciesName} printing you own, want, or plan to put in a binder.`
              : setId
                ? `Browsing ${setName ?? 'this set'} (${setId}). Choose a card to update your collection or add it to a binder.`
                : 'Search visually, then update copies or notes without losing your place.'}
          </p>
          {speciesName ? (
            <div className="indexing-status">
              {indexing ? <span>Checking TCGdex for additional printings…</span> : null}
              {!indexing && indexingError ? (
                <span>
                  Printing refresh failed. {indexingError}{' '}
                  <button className="text-button" type="button" onClick={retryIndexing}>
                    Try again
                  </button>
                </span>
              ) : null}
              {!indexing && !indexingError ? (
                <span>{indexingResult ?? 'English physical printings'}</span>
              ) : null}
            </div>
          ) : null}
        </div>
      </header>
      <form
        className="filter-bar"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          void search(0, initialParams);
        }}
      >
        <label>
          Search
          <input value={query} maxLength={200} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <SegmentedControl
          label="Collection state"
          value={ownership}
          options={[
            { value: 'all', label: 'All' },
            { value: 'missing', label: 'Missing' },
            { value: 'owned', label: 'Owned' },
          ]}
          onChange={setOwnership}
        />
        <button className="quiet-button" type="submit" disabled={loading}>
          {loading ? 'Searching…' : 'Search'}
        </button>
      </form>
      {!speciesName ? (
        <details className="custom-card-tools">
          <summary>Add a card that is not in TCGdex</summary>
          <div>
            <label>
              Custom card name
              <input
                value={customName}
                maxLength={200}
                onChange={(event) => setCustomName(event.target.value)}
              />
            </label>
            <button
              className="quiet-button"
              type="button"
              disabled={!customName.trim() || creating}
              onClick={() => void createCustom()}
            >
              {creating ? 'Adding…' : 'Add custom card'}
            </button>
          </div>
        </details>
      ) : null}
      <details
        className="custom-card-tools bulk-binder-tools"
        onToggle={(event) => {
          if (event.currentTarget.open) void loadBinderChoices();
        }}
      >
        <summary>Add these results to a binder</summary>
        <div>
          {binderChoices.length ? (
            <>
              <div className="binder-choice-list">
                {binderChoices.map((binder) => (
                  <button
                    key={binder.id}
                    className="quiet-button"
                    type="button"
                    aria-pressed={binderTarget === binder.id}
                    onClick={() => setBinderTarget(binder.id)}
                  >
                    {binder.name}
                  </button>
                ))}
              </div>
              <button
                className="quiet-button tone-accent"
                type="button"
                disabled={!binderTarget || bulkAdding || total === 0 || total > 2000}
                onClick={() => void addCurrentResultsToBinder()}
              >
                {bulkAdding
                  ? 'Adding in order…'
                  : total > 2000
                    ? `${total.toLocaleString('en-AU')} results exceed binder capacity`
                    : `Add all ${total.toLocaleString('en-AU')} results`}
              </button>
            </>
          ) : (
            <span>Create a binder in Binder Plans first.</span>
          )}
        </div>
      </details>
      <p className="result-announcement" role="status" aria-live="polite" aria-atomic="true">
        {busy ? '' : `Showing ${first} to ${last} of ${total} cards.`}
      </p>
      <div className="catalogue-layout loading-stage" aria-busy={busy}>
        {busy ? (
          <LoadingOverlay
            message={
              indexing && speciesName
                ? `Finding every ${speciesName} printing…`
                : 'Searching the card cabinet…'
            }
          />
        ) : null}
        <section className="card-results card-gallery" aria-label="Catalogue results" ref={gallery}>
          <div className="result-status">
            <span>
              {first} to {last} of {total}
            </span>
            <span>Page {page + 1}</span>
          </div>
          {cards.length === 0 && !busy ? (
            <div className="empty-state">
              <h2>No cards match this search.</h2>
              <p>Try fewer words or clear the search.</p>
            </div>
          ) : (
            cards.map((card) => (
              <CardTile
                className={selectedCardId === card.id ? 'card-row selected' : 'card-row'}
                key={card.id}
                data-card-id={card.id}
                aria-pressed={selectedCardId === card.id}
                onClick={() => void openCard(card.id)}
                art={<Art card={card} decorative />}
                title={card.name}
                subtitle={`${card.setName} · ${card.number}`}
                quantity={card.collection?.quantity ?? 0}
              />
            ))
          )}
          <Pagination
            page={page}
            totalPages={totalPages}
            pending={busy}
            label="Catalogue pages"
            onPage={(nextPage) => void search(nextPage)}
          />
        </section>
      </div>
      {detail ? (
        <DetailPanel
          card={detail}
          pending={saving}
          pokedexNumber={pokedexNumber}
          representativePending={representativePending}
          save={(quantity, notes) => void save(quantity, notes)}
          addOne={() => void addOne()}
          useAsRepresentative={() => void useAsRepresentative()}
          previous={previousCard}
          next={nextCard}
          position={detailIndex + 1}
          total={cards.length}
          close={closeDetail}
          binders={binderChoices}
          binderId={binderTarget}
          binderPending={binderAdding}
          chooseBinder={setBinderTarget}
          addToBinder={() => void addDetailToBinder()}
        />
      ) : null}
    </>
  );
}
