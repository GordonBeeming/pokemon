import { useEffect, useRef, useState, type ReactElement } from 'react';
import {
  api,
  ApiError,
  type CatalogueCardView,
  type CatalogueDetailView,
  type CollectionState,
} from './api';
import { money, userMessage, type Notice } from './ui';

const PAGE_SIZE = 50;

function Art({
  card,
  decorative = false,
}: {
  card: CatalogueCardView | CatalogueDetailView;
  decorative?: boolean;
}): ReactElement {
  return card.imageLowUrl ? (
    <img
      className="card-art"
      src={card.imageLowUrl}
      alt={decorative ? '' : `${card.name} card art`}
      loading="lazy"
    />
  ) : (
    <div className="card-art card-art-missing">Art unavailable</div>
  );
}

function DetailPanel({
  card,
  pending,
  save,
  addOne,
}: {
  card: CatalogueDetailView;
  pending: boolean;
  save: (quantity: number, notes: string | null) => void;
  addOne: () => void;
}): ReactElement {
  const [quantity, setQuantity] = useState(card.collection?.quantity ?? 0);
  const [notes, setNotes] = useState(card.collection?.notes ?? '');
  useEffect(() => {
    setQuantity(card.collection?.quantity ?? 0);
    setNotes(card.collection?.notes ?? '');
  }, [card]);
  return (
    <aside className="card-detail" aria-labelledby="card-detail-heading">
      <Art card={card} />
      <div className="detail-copy">
        <h2 id="card-detail-heading" tabIndex={-1}>
          {card.name}
        </h2>
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
        </div>
      </div>
    </aside>
  );
}

export function CatalogueView({
  initialParams,
  onNotice,
}: {
  initialParams: URLSearchParams;
  onNotice: (notice: Notice) => void;
}): ReactElement {
  const [query, setQuery] = useState(initialParams.get('q') ?? '');
  const [customName, setCustomName] = useState('');
  const [cards, setCards] = useState<CatalogueCardView[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [detail, setDetail] = useState<CatalogueDetailView | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const searchGeneration = useRef(0);
  const searchController = useRef<AbortController | null>(null);
  const detailController = useRef<AbortController | null>(null);
  const detailHeading = useRef<HTMLElement | null>(null);

  async function search(nextOffset: number, params = initialParams): Promise<void> {
    const generation = ++searchGeneration.current;
    searchController.current?.abort();
    const controller = new AbortController();
    searchController.current = controller;
    setLoading(true);
    onNotice(null);
    const next = new URLSearchParams(params);
    if (query.trim()) next.set('q', query.trim());
    else next.delete('q');
    next.set('limit', String(PAGE_SIZE));
    next.set('offset', String(nextOffset));
    try {
      const result = await api.search(next, controller.signal);
      if (generation !== searchGeneration.current) return;
      setCards(result.cards);
      setTotal(result.total);
      setOffset(nextOffset);
      setDetail(null);
    } catch (error) {
      const message = userMessage(error);
      if (message && generation === searchGeneration.current) onNotice({ kind: 'error', message });
    } finally {
      if (generation === searchGeneration.current) setLoading(false);
    }
  }

  useEffect(() => {
    setQuery(initialParams.get('q') ?? '');
    void search(0, initialParams);
    return () => {
      searchController.current?.abort();
      detailController.current?.abort();
    };
  }, [initialParams.toString()]);

  async function openCard(id: string): Promise<void> {
    detailController.current?.abort();
    const controller = new AbortController();
    detailController.current = controller;
    try {
      const next = await api.card(id, controller.signal);
      setDetail(next);
      requestAnimationFrame(() => {
        detailHeading.current = document.getElementById('card-detail-heading');
        detailHeading.current?.focus();
      });
    } catch (error) {
      const message = userMessage(error);
      if (message) onNotice({ kind: 'error', message });
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

  const first = total === 0 ? 0 : offset + 1;
  const last = Math.min(total, offset + cards.length);
  return (
    <>
      <header className="page-heading">
        <div>
          <h1>Find a physical card.</h1>
          <p>Search the catalogue, then update the copy count or notes without leaving the card.</p>
        </div>
      </header>
      <form
        className="filter-bar"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          void search(0, new URLSearchParams());
        }}
      >
        <label>
          Search
          <input value={query} maxLength={200} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <button className="quiet-button" type="submit" disabled={loading}>
          {loading ? 'Searching…' : 'Search'}
        </button>
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
      </form>
      <p className="result-announcement" role="status" aria-live="polite" aria-atomic="true">
        {loading ? 'Loading catalogue results.' : `Showing ${first} to ${last} of ${total} cards.`}
      </p>
      <div className="catalogue-layout" aria-busy={loading}>
        <section className="card-results" aria-label="Catalogue results">
          <div className="result-status">
            <span>
              {first} to {last} of {total}
            </span>
            <span>Page {Math.floor(offset / PAGE_SIZE) + 1}</span>
          </div>
          {cards.length === 0 && !loading ? (
            <div className="empty-state">
              <h2>No cards match this search.</h2>
              <p>Try fewer words or clear the search.</p>
            </div>
          ) : (
            cards.map((card) => (
              <button
                className={detail?.id === card.id ? 'card-row selected' : 'card-row'}
                key={card.id}
                type="button"
                aria-pressed={detail?.id === card.id}
                onClick={() => void openCard(card.id)}
              >
                <Art card={card} decorative />
                <span className="card-row-title">
                  <strong title={card.name}>{card.name}</strong>
                  <small>
                    {card.setName} · {card.number}
                  </small>
                </span>
                <span className={card.collection?.quantity ? 'ownership owned' : 'ownership'}>
                  {card.collection?.quantity ? `${card.collection.quantity} owned` : 'Missing'}
                </span>
              </button>
            ))
          )}
          <div className="pagination-actions">
            <button
              className="quiet-button"
              type="button"
              disabled={offset === 0 || loading}
              onClick={() => void search(Math.max(0, offset - PAGE_SIZE))}
            >
              Previous 50
            </button>
            <button
              className="quiet-button"
              type="button"
              disabled={offset + cards.length >= total || loading}
              onClick={() => void search(offset + PAGE_SIZE)}
            >
              Next 50
            </button>
          </div>
        </section>
        {detail ? (
          <DetailPanel
            card={detail}
            pending={saving}
            save={(quantity, notes) => void save(quantity, notes)}
            addOne={() => void addOne()}
          />
        ) : (
          <aside className="card-detail" aria-label="Card detail">
            <div className="empty-state">
              <h2>Select a card.</h2>
            </div>
          </aside>
        )}
      </div>
    </>
  );
}
