import {
  binderSlotLocationSchema,
  type BinderLayout,
  type BinderSlotLocation,
} from '@pokedex/shared';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import {
  api,
  ApiError,
  type BinderMutationResult,
  type BinderVersionPages,
  type BinderView,
  type CatalogueCardView,
} from './api';
import { userMessage, type Notice } from './ui';
import { CardArt } from './card-art';
import { CardTile } from './card-tile';
import { NATIONAL_POKEDEX } from './national-pokedex';

const binderLayoutOptions: Array<{ value: BinderLayout['kind']; label: string }> = [
  { value: '2x2', label: '2 × 2' },
  { value: '3x3', label: '3 × 3' },
  { value: '4x3', label: '4 × 3' },
  { value: 'top-loader', label: 'Top-loader' },
  { value: 'custom', label: 'Custom' },
];

function fixedLayout(kind: Exclude<BinderLayout['kind'], 'custom'>): BinderLayout {
  if (kind === '2x2') return { kind, rows: 2, columns: 2 };
  if (kind === '3x3') return { kind, rows: 3, columns: 3 };
  if (kind === '4x3') return { kind, rows: 3, columns: 4 };
  return { kind, rows: 2, columns: 2 };
}

export function containsCardSequence(slots: Array<string | null>, sequence: string[]): boolean {
  if (sequence.length === 0 || sequence.length > slots.length) return false;
  for (let start = 0; start <= slots.length - sequence.length; start += 1) {
    if (sequence.every((cardId, offset) => slots[start + offset] === cardId)) return true;
  }
  return false;
}

export function binderMutationPage(
  result: BinderMutationResult,
  currentPage: number,
): { position: number; page: BinderMutationResult['pages'][number] | null } {
  const position = Math.max(0, Math.min(currentPage, result.version.pageCount - 1));
  return {
    position,
    page: result.pages.find((item) => item.position === position) ?? null,
  };
}

async function loadAllShortages(
  versionId: string,
  signal: AbortSignal,
): Promise<Array<{ cardId: string; missing: number }>> {
  const shortages: Array<{ cardId: string; missing: number }> = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const result = await api.binderShortages(versionId, offset, 100, signal);
    shortages.push(...result.shortages);
    offset = result.nextOffset;
  }
  return shortages;
}

async function resolveCardBatches(
  cardIds: string[],
  signal: AbortSignal,
): Promise<CatalogueCardView[]> {
  const cards: CatalogueCardView[] = [];
  for (let offset = 0; offset < cardIds.length; offset += 200)
    cards.push(...(await api.resolveCards(cardIds.slice(offset, offset + 200), signal)));
  return cards;
}

function BinderCardArt({ card }: { card: CatalogueCardView }): ReactElement {
  return (
    <CardArt
      src={card.imageLowUrl}
      highSrc={card.imageHighUrl}
      alt=""
      dimmed={(card.collection?.quantity ?? 0) === 0}
    />
  );
}

function BinderCreate({
  pending,
  create,
}: {
  pending: boolean;
  create: (name: string, layout: BinderLayout) => void;
}): ReactElement {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<BinderLayout['kind']>('3x3');
  const [rows, setRows] = useState(3);
  const [columns, setColumns] = useState(3);
  const layout =
    kind === 'custom'
      ? ({
          kind,
          rows: Math.min(20, Math.max(1, rows)),
          columns: Math.min(20, Math.max(1, columns)),
        } satisfies BinderLayout)
      : fixedLayout(kind);
  return (
    <section className="surface activity-panel" aria-labelledby="create-binder-heading">
      <h1 id="create-binder-heading">Create your first binder.</h1>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          create(name.trim(), layout);
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
          <legend>Page format</legend>
          <div>
            {binderLayoutOptions.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                aria-pressed={kind === value}
                onClick={() => {
                  setKind(value);
                }}
              >
                <span className={`layout-miniature layout-${value}`} aria-hidden="true" />
                <strong>{label}</strong>
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
        <button
          className="quiet-button tone-accent"
          type="submit"
          disabled={!name.trim() || pending}
        >
          {pending ? 'Creating…' : 'Create binder'}
        </button>
      </form>
    </section>
  );
}

export function BinderView({ onNotice }: { onNotice: (notice: Notice) => void }): ReactElement {
  const [binders, setBinders] = useState<BinderView[]>([]);
  const [binder, setBinder] = useState<BinderVersionPages | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [fullPokedexPending, setFullPokedexPending] = useState(false);
  const [shortages, setShortages] = useState<Array<{ cardId: string; missing: number }>>([]);
  const [page, setPage] = useState(0);
  const [cardQuery, setCardQuery] = useState('');
  const [cards, setCards] = useState<CatalogueCardView[]>([]);
  const [cardTotal, setCardTotal] = useState(0);
  const [knownCards, setKnownCards] = useState<Map<string, CatalogueCardView>>(new Map());
  const [selectedSlot, setSelectedSlot] = useState<BinderSlotLocation | null>(null);
  const [pageMenuOpen, setPageMenuOpen] = useState(false);
  const [pageDraft, setPageDraft] = useState('1');
  const [pending, setPending] = useState(false);
  const [plannerStatus, setPlannerStatus] = useState('');
  const [moveSource, setMoveSource] = useState<BinderSlotLocation | null>(null);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const fullPokedexController = useRef<AbortController | null>(null);
  const pageMenu = useRef<HTMLDivElement | null>(null);
  const pageMenuButton = useRef<HTMLButtonElement | null>(null);

  const version = binder?.version ?? null;
  const currentPage = binder?.pages[0] ?? null;
  const editable = version?.status !== 'archived';

  useEffect(() => setPageDraft(String(page + 1)), [page]);

  useEffect(() => {
    if (!pageMenuOpen) return;
    const dismiss = (event: PointerEvent): void => {
      if (pageMenu.current?.contains(event.target as Node)) return;
      setPageMenuOpen(false);
    };
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setPageMenuOpen(false);
        pageMenuButton.current?.focus();
      }
    };
    addEventListener('pointerdown', dismiss);
    addEventListener('keydown', keydown);
    return () => {
      removeEventListener('pointerdown', dismiss);
      removeEventListener('keydown', keydown);
    };
  }, [pageMenuOpen]);

  async function loadVersion(versionId: string, nextPage: number): Promise<void> {
    const currentGeneration = ++generation.current;
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    setPending(true);
    try {
      const [nextBinder, shortagePage] = await Promise.all([
        api.binder(versionId, nextPage, 1, nextController.signal),
        loadAllShortages(versionId, nextController.signal),
      ]);
      const cardIds = [
        ...new Set([
          ...nextBinder.pages.flatMap((item) => item.slots.map((slot) => slot.cardId)),
          ...shortagePage.map((shortage) => shortage.cardId),
        ]),
      ].flatMap((value) => (value ? [String(value)] : []));
      const resolved = await resolveCardBatches(cardIds, nextController.signal);
      if (currentGeneration !== generation.current) return;
      setBinder(nextBinder);
      setShortages(shortagePage);
      setKnownCards((current) => {
        const updated = new Map(current);
        for (const card of resolved) updated.set(card.id, card);
        return updated;
      });
      setPage(nextPage);
      setSelectedSlot(null);
      setPageMenuOpen(false);
      setMoveSource(null);
      setPlannerStatus(`Page ${nextPage + 1} loaded.`);
    } catch (error) {
      const message = userMessage(error);
      if (message && currentGeneration === generation.current) onNotice({ kind: 'error', message });
    } finally {
      if (currentGeneration === generation.current) setPending(false);
    }
  }

  async function loadBinders(): Promise<void> {
    const currentGeneration = ++generation.current;
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    setPending(true);
    try {
      const next = await api.binders(nextController.signal);
      if (currentGeneration !== generation.current) return;
      setBinders(next);
    } catch (error) {
      const message = userMessage(error);
      if (message) onNotice({ kind: 'error', message });
    } finally {
      setPending(false);
    }
  }

  useEffect(() => {
    void loadBinders();
    return () => {
      controller.current?.abort();
      fullPokedexController.current?.abort();
    };
  }, []);

  async function openBinder(item: BinderView): Promise<void> {
    const versionId = item.activeVersionId ?? item.latestVersionId;
    if (!versionId) return;
    await loadVersion(versionId, 0);
  }

  async function mergeMutation(result: BinderMutationResult): Promise<void> {
    const { position: nextPage, page: affected } = binderMutationPage(result, page);
    if (!affected) {
      await loadVersion(result.version.id, nextPage);
      return;
    }
    setBinder((current) =>
      current
        ? { ...current, version: result.version, pages: [affected] }
        : { version: result.version, pages: [affected], nextPage: null },
    );
    setPage(nextPage);
  }

  async function mutate(
    action: () => Promise<BinderMutationResult>,
    success: string,
  ): Promise<boolean> {
    if (!version) return false;
    setPending(true);
    onNotice(null);
    try {
      const result = await action();
      await mergeMutation(result);
      setPlannerStatus(success);
      onNotice({ kind: 'success', message: success });
      return true;
    } catch (error) {
      const message = userMessage(error);
      if (message) onNotice({ kind: 'error', message });
      if (error instanceof ApiError && error.code === 'binder_revision_conflict')
        await loadVersion(version.id, page);
      return false;
    } finally {
      setPending(false);
    }
  }

  async function allPageIds(): Promise<string[]> {
    if (!version) return [];
    const ids: string[] = [];
    for (let offset = 0; offset < version.pageCount; offset += 4) {
      const result = await api.binder(version.id, offset, 4);
      ids.push(...result.pages.map((item) => item.id));
    }
    return ids;
  }

  async function allSlotCardIds(): Promise<Array<string | null>> {
    if (!version) return [];
    const ids: Array<string | null> = [];
    for (let offset = 0; offset < version.pageCount; offset += 4) {
      const result = await api.binder(version.id, offset, 4);
      ids.push(
        ...result.pages.flatMap((item) =>
          item.slots
            .slice()
            .sort((left, right) => left.row - right.row || left.column - right.column)
            .map((slot) => slot.cardId),
        ),
      );
    }
    return ids;
  }

  async function searchCards(): Promise<void> {
    if (!selectedSlot) return;
    const params = new URLSearchParams({ q: cardQuery, limit: '50', offset: '0' });
    try {
      const result = await api.search(params);
      setCards(result.cards);
      setCardTotal(result.total);
      setKnownCards((current) => {
        const updated = new Map(current);
        for (const card of result.cards) updated.set(card.id, card);
        return updated;
      });
      setPlannerStatus(`${result.cards.length} card options found for this pocket.`);
    } catch (error) {
      const message = userMessage(error);
      if (message) onNotice({ kind: 'error', message });
    }
  }

  async function addCardIds(cardIds: string[], success: string): Promise<void> {
    if (!version || cardIds.length === 0) return;
    setPending(true);
    onNotice(null);
    try {
      const result = await api.addCardsToBinder(version.id, cardIds, version.revision);
      await loadVersion(result.binder.version.id, 0);
      await loadBinders();
      setPlannerStatus(success);
      onNotice({ kind: 'success', message: success });
    } catch (error) {
      const message = userMessage(error);
      if (message) onNotice({ kind: 'error', message });
    } finally {
      setPending(false);
    }
  }

  async function addAllSearchResults(): Promise<void> {
    if (cardTotal > 2000) return;
    const cardIds: string[] = [];
    let cursor: string | null = null;
    do {
      const params = new URLSearchParams({ q: cardQuery, limit: '100', offset: '0' });
      if (cursor) params.set('cursor', cursor);
      const result = await api.search(params);
      cardIds.push(...result.cards.map((card) => card.id));
      cursor = result.cursor;
      if (cardIds.length > 2000) throw new Error('A binder can hold at most 2,000 cards.');
    } while (cursor);
    await addCardIds(cardIds, `${cardIds.length} cards added in search order.`);
  }

  async function addFullPokedex(): Promise<void> {
    if (!version) return;
    const jobController = new AbortController();
    fullPokedexController.current?.abort();
    fullPokedexController.current = jobController;
    setPending(true);
    setFullPokedexPending(true);
    onNotice(null);
    try {
      setPlannerStatus('Indexing the exact English card catalogue for all 1,025 species…');
      const previousCoverage = await api.nationalPokedex();
      let coverage = previousCoverage;
      if (previousCoverage.length !== 1025) {
        const previews = await api.nationalPokedexPreviews(
          NATIONAL_POKEDEX.map((entry) => entry.name),
        );
        if (previews.length !== 1025)
          throw new Error(
            `TCGdex currently exposes exact English previews for ${previews.length} of 1,025 species. Nothing was added.`,
          );
        const workflowId = await api.startCatalogueSync(jobController.signal);
        const deadline = Date.now() + 30 * 60 * 1000;
        let delay = 2000;
        let status = await api.catalogueSyncStatus(workflowId, jobController.signal);
        while (status !== 'complete') {
          if (Date.now() >= deadline)
            throw new Error('Catalogue indexing timed out after 30 minutes.');
          setPlannerStatus(
            `Catalogue indexing is ${status}. You can cancel safely and retry from this binder.`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          jobController.signal.throwIfAborted();
          status = await api.catalogueSyncStatus(workflowId, jobController.signal);
          delay = Math.min(10_000, Math.round(delay * 1.5));
        }
        const numberByName = new Map(NATIONAL_POKEDEX.map((entry) => [entry.name, entry.number]));
        await api.resolveNationalRepresentatives(
          previews.map((preview) => ({
            number: numberByName.get(preview.name) ?? 0,
            name: preview.name,
            sourceId: preview.sourceId,
          })),
        );
        for (const entry of previousCoverage.filter((entry) => entry.representative.explicit))
          await api.setNationalRepresentative(entry.number, entry.representative.cardId);
        coverage = await api.nationalPokedex();
      } else {
        setPlannerStatus('Using the 1,025 representatives currently shown in your Pokédex…');
      }
      if (coverage.length !== 1025)
        throw new Error(
          `The English catalogue currently has exact representatives for ${coverage.length} of 1,025 species. Nothing was added.`,
        );
      const cardIds = [...coverage]
        .sort((left, right) => left.number - right.number)
        .map((entry) => entry.representative.cardId);
      if (containsCardSequence(await allSlotCardIds(), cardIds)) {
        setPlannerStatus('This binder already contains the full National Pokédex sequence.');
        onNotice({
          kind: 'success',
          message: 'The full National Pokédex is already in this binder.',
        });
        return;
      }
      const result = await api.addCardsToBinder(version.id, cardIds, version.revision);
      await loadVersion(result.binder.version.id, 0);
      await loadBinders();
      setPlannerStatus('The full National Pokédex was added in Pokédex order.');
      onNotice({ kind: 'success', message: '1,025 representative cards added.' });
    } catch (error) {
      const message = userMessage(error);
      if (message) onNotice({ kind: 'error', message });
    } finally {
      if (fullPokedexController.current === jobController) fullPokedexController.current = null;
      setFullPokedexPending(false);
      setPending(false);
    }
  }

  async function swap(source: BinderSlotLocation, target: BinderSlotLocation): Promise<void> {
    if (!version) return;
    const placed = await mutate(
      () => api.swapSlots(version.id, { expectedRevision: version.revision, source, target }),
      'Cards moved.',
    );
    if (!placed) return;
    setMoveSource(null);
  }

  async function placeCard(card: CatalogueCardView): Promise<void> {
    if (!version || !selectedSlot) return;
    const placed = await mutate(
      () =>
        api.setSlot(version.id, {
          expectedRevision: version.revision,
          ...selectedSlot,
          cardId: card.id,
        }),
      `${card.name} placed in pocket ${selectedSlot.row + 1}:${selectedSlot.column + 1}.`,
    );
    if (!placed) return;
    setSelectedSlot(null);
    setCards([]);
    setCardQuery('');
  }

  function slotAction(location: BinderSlotLocation, occupied: boolean): void {
    if (!version || !editable || pending) return;
    if (moveSource) {
      void swap(moveSource, location);
      return;
    }
    setSelectedSlot(location);
    setCards([]);
    setCardQuery('');
    setPlannerStatus(
      `${occupied ? 'Pocket' : 'Empty pocket'} ${location.row + 1}:${location.column + 1} selected. Search for its card.`,
    );
  }

  function goToDraftPage(): void {
    if (!version) return;
    const requested = Number.parseInt(pageDraft, 10);
    const nextPage = Number.isFinite(requested)
      ? Math.min(version.pageCount, Math.max(1, requested)) - 1
      : page;
    setPageDraft(String(nextPage + 1));
    if (nextPage !== page) void loadVersion(version.id, nextPage);
  }

  if (!binder)
    return (
      <>
        <header className="page-heading binder-library-heading">
          <div>
            <h1>Your binders.</h1>
            <p>Open a binder to arrange its digital twin, or start planning another one.</p>
          </div>
          <button
            className="quiet-button tone-accent"
            type="button"
            disabled={pending}
            onClick={() => setShowCreate((current) => !current)}
          >
            {showCreate ? 'Cancel' : 'New binder'}
          </button>
        </header>
        {pending ? <p className="result-announcement">Loading your binders…</p> : null}
        <section className="binder-library" aria-label="Your binders">
          {binders.map((item) => (
            <button
              key={item.id}
              className="binder-library-card"
              type="button"
              disabled={pending}
              onClick={() => void openBinder(item)}
            >
              <span className="binder-cover" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              <span>
                <strong>{item.name}</strong>
                <small>Open and arrange binder</small>
              </span>
            </button>
          ))}
        </section>
        {showCreate || (!pending && binders.length === 0) ? (
          <BinderCreate
            pending={pending}
            create={(name, layout) => {
              setPending(true);
              void api
                .createBinder(name, layout)
                .then(async (created) => {
                  setBinder({ version: created.version, pages: created.pages, nextPage: null });
                  setShowCreate(false);
                  await loadBinders();
                })
                .catch((error: unknown) => onNotice({ kind: 'error', message: userMessage(error) }))
                .finally(() => setPending(false));
            }}
          />
        ) : null}
      </>
    );

  const selectedPocket = selectedSlot
    ? (currentPage?.slots.find(
        (slot) => slot.row === selectedSlot.row && slot.column === selectedSlot.column,
      ) ?? null)
    : null;
  const selectedPocketCard = selectedPocket?.cardId
    ? (knownCards.get(selectedPocket.cardId) ?? null)
    : null;

  return (
    <>
      <header className="page-heading">
        <div>
          <button
            className="text-button back-link"
            type="button"
            onClick={() => {
              setBinder(null);
              setCards([]);
              setSelectedSlot(null);
            }}
          >
            Back to all binders
          </button>
          <h1>{binders.find((item) => item.id === version?.binderId)?.name ?? 'Binder plan'}</h1>
          <p>Choose a pocket, find its card, then arrange the page to match your real binder.</p>
        </div>
        <div className="header-actions">
          <button
            className="quiet-button binder-bulk-add"
            type="button"
            disabled={!version || pending}
            onClick={() => void addFullPokedex()}
          >
            {fullPokedexPending ? 'Building Pokédex…' : 'Add full Pokédex'}
          </button>
          {fullPokedexPending ? (
            <button
              className="quiet-button"
              type="button"
              onClick={() => fullPokedexController.current?.abort()}
            >
              Cancel
            </button>
          ) : null}
          <button className="quiet-button" type="button" onClick={() => window.print()}>
            Print
          </button>
        </div>
      </header>
      {selectedSlot ? (
        <section className="slot-picker-panel" aria-labelledby="slot-picker-heading">
          <div className="slot-picker-heading">
            <div>
              <h2 id="slot-picker-heading">
                Choose a card for pocket {selectedSlot.row + 1}:{selectedSlot.column + 1}
              </h2>
              <p>
                Search Pokémon, set, number, rarity, or artist. Choosing a result places it
                immediately.
              </p>
            </div>
            <button
              className="icon-button"
              type="button"
              aria-label="Close pocket editor"
              onClick={() => {
                setSelectedSlot(null);
                setCards([]);
                setCardQuery('');
              }}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="m7 7 10 10M17 7 7 17" />
              </svg>
            </button>
          </div>
          {selectedPocketCard ? (
            <div className="selected-pocket-summary">
              <BinderCardArt card={selectedPocketCard} />
              <span>
                <strong>{selectedPocketCard.name}</strong>
                <small>
                  {selectedPocketCard.setName} · {selectedPocketCard.number}
                </small>
              </span>
              <button
                className="quiet-button"
                type="button"
                disabled={pending}
                onClick={() => {
                  setMoveSource(selectedSlot);
                  setSelectedSlot(null);
                  setPlannerStatus('Card picked up. Choose its destination pocket.');
                }}
              >
                Move card
              </button>
              <button
                className="quiet-button"
                type="button"
                disabled={pending || !version}
                onClick={() =>
                  version &&
                  void mutate(
                    () =>
                      api.setSlot(version.id, {
                        expectedRevision: version.revision,
                        ...selectedSlot,
                        cardId: null,
                      }),
                    'Pocket cleared.',
                  ).then((cleared) => {
                    if (cleared) setSelectedSlot(null);
                  })
                }
              >
                Clear pocket
              </button>
            </div>
          ) : null}
          <div className="planner-toolbar">
            <form
              className="card-picker"
              role="search"
              onSubmit={(event) => {
                event.preventDefault();
                void searchCards();
              }}
            >
              <label>
                Search cards
                <input
                  value={cardQuery}
                  maxLength={200}
                  autoFocus
                  placeholder="e.g. Ponyta, Base Set, 60/102, illustrator"
                  disabled={!editable || pending}
                  onChange={(event) => setCardQuery(event.target.value)}
                />
              </label>
              <button className="quiet-button" type="submit" disabled={!editable || pending}>
                Find cards
              </button>
            </form>
          </div>
          <p className="slot-picker-status" role="status" aria-live="polite">
            {plannerStatus}
          </p>
          <section
            className="binder-card-tray"
            aria-label="Cards available to place"
            hidden={!editable}
          >
            <div>
              <strong>{cards.length ? 'Choose a card' : 'Search results'}</strong>
              <span>
                {cards.length
                  ? `${cards.length} search results`
                  : 'Search above to load visual card choices for this pocket.'}
              </span>
            </div>
            {cards.length ? (
              <>
                <div className="binder-card-options">
                  {cards.map((card) => (
                    <CardTile
                      className="binder-tray-card"
                      key={card.id}
                      onClick={() => void placeCard(card)}
                      art={<BinderCardArt card={card} />}
                      title={card.name}
                      subtitle={`${card.setName} · ${card.number}`}
                      quantity={card.collection?.quantity ?? 0}
                    />
                  ))}
                </div>
                <button
                  className="quiet-button tone-accent"
                  type="button"
                  disabled={pending || cardTotal === 0 || cardTotal > 2000}
                  onClick={() => void addAllSearchResults()}
                >
                  {cardTotal > 2000
                    ? `${cardTotal.toLocaleString('en-AU')} results exceed binder capacity`
                    : `Append all ${cardTotal.toLocaleString('en-AU')} results`}
                </button>
              </>
            ) : null}
          </section>
        </section>
      ) : null}
      <div className="binder-page-toolbar">
        <nav className="binder-page-stepper" aria-label="Binder pages">
          <button
            className="quiet-button"
            type="button"
            disabled={pending || page === 0}
            onClick={() => version && void loadVersion(version.id, page - 1)}
          >
            Previous
          </button>
          <label>
            <span>Page</span>
            <input
              type="number"
              min="1"
              max={version?.pageCount ?? 1}
              value={pageDraft}
              disabled={pending}
              aria-label="Page number"
              onChange={(event) => setPageDraft(event.target.value)}
              onBlur={goToDraftPage}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  goToDraftPage();
                }
              }}
            />
            <span>of {version?.pageCount ?? 1}</span>
          </label>
          <button
            className="quiet-button"
            type="button"
            disabled={pending || !version || page + 1 >= version.pageCount}
            onClick={() => version && void loadVersion(version.id, page + 1)}
          >
            Next
          </button>
        </nav>
        <p className="pocket-prompt" role="status" aria-live="polite">
          {moveSource
            ? 'Choose a destination pocket for the card you picked up.'
            : 'Choose a pocket to add or replace its card.'}
        </p>
        <div className="page-management">
          <button
            className="quiet-button"
            type="button"
            disabled={!editable || pending}
            onClick={() =>
              version &&
              void mutate(() => api.addPage(version.id, version.revision), 'Binder page added.')
            }
          >
            Add page
          </button>
          <div className="page-menu" ref={pageMenu}>
            <button
              className="icon-button"
              type="button"
              aria-label="Page actions"
              aria-expanded={pageMenuOpen}
              aria-controls="binder-page-actions"
              ref={pageMenuButton}
              onClick={() => setPageMenuOpen((open) => !open)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M5 12h.01M12 12h.01M19 12h.01" />
              </svg>
            </button>
            {pageMenuOpen ? (
              <div className="page-menu-popover" id="binder-page-actions" aria-label="Page actions">
                <button
                  type="button"
                  disabled={!editable || pending || page === 0}
                  onClick={() => {
                    setPageMenuOpen(false);
                    if (!version) return;
                    void allPageIds().then((ids) => {
                      const before = ids[page - 1];
                      const current = ids[page];
                      if (!before || !current) return;
                      ids[page - 1] = current;
                      ids[page] = before;
                      return mutate(
                        () => api.reorderPages(version.id, ids, version.revision),
                        'Page moved earlier.',
                      );
                    });
                  }}
                >
                  Move page earlier
                </button>
                <button
                  type="button"
                  disabled={!editable || pending || !version || page + 1 >= version.pageCount}
                  onClick={() => {
                    setPageMenuOpen(false);
                    if (!version) return;
                    void allPageIds().then((ids) => {
                      const current = ids[page];
                      const after = ids[page + 1];
                      if (!current || !after) return;
                      ids[page] = after;
                      ids[page + 1] = current;
                      return mutate(
                        () => api.reorderPages(version.id, ids, version.revision),
                        'Page moved later.',
                      );
                    });
                  }}
                >
                  Move page later
                </button>
                <button
                  type="button"
                  disabled={!editable || pending || !version}
                  onClick={() => {
                    setPageMenuOpen(false);
                    if (version)
                      void mutate(
                        () => api.arrangeBinder(version.id, 'set-number', version.revision),
                        'Cards arranged by set number.',
                      );
                  }}
                >
                  Arrange by set number
                </button>
                <button
                  className="danger-menu-item"
                  type="button"
                  disabled={!editable || pending || !currentPage || (version?.pageCount ?? 0) <= 1}
                  onClick={() => {
                    setPageMenuOpen(false);
                    if (version && currentPage)
                      void mutate(
                        () => api.deletePage(version.id, currentPage.id, version.revision),
                        'Binder page deleted.',
                      );
                  }}
                >
                  Delete this page
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      <div className="planner-layout">
        <section className="binder-page" aria-label={`Binder page ${page + 1}`}>
          <div
            className="binder-grid"
            style={{
              gridTemplateColumns: `repeat(${version?.layout.columns ?? 1}, minmax(0, 1fr))`,
            }}
          >
            {(currentPage?.slots ?? []).map((slot) => {
              const location = { page, row: slot.row, column: slot.column };
              const card = slot.cardId ? knownCards.get(slot.cardId) : null;
              const name = card?.name ?? (slot.cardId ? 'Unknown card' : null);
              const moving =
                moveSource?.page === page &&
                moveSource.row === slot.row &&
                moveSource.column === slot.column;
              const selected =
                selectedSlot?.page === page &&
                selectedSlot.row === slot.row &&
                selectedSlot.column === slot.column;
              return (
                <button
                  className={[
                    'binder-slot',
                    slot.cardId ? 'occupied' : '',
                    moving ? 'move-source' : '',
                    selected ? 'selected-slot' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  key={`${slot.row}-${slot.column}`}
                  type="button"
                  disabled={!editable || pending}
                  draggable={slot.cardId !== null && editable}
                  aria-pressed={moving || selected}
                  aria-label={`Page ${page + 1}, row ${slot.row + 1}, column ${slot.column + 1}, ${name ?? 'empty'}`}
                  onDragStart={(event) =>
                    event.dataTransfer.setData('application/json', JSON.stringify(location))
                  }
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    let value: unknown;
                    try {
                      value = JSON.parse(event.dataTransfer.getData('application/json'));
                    } catch (error) {
                      onNotice({ kind: 'error', message: userMessage(error) });
                      return;
                    }
                    const source = binderSlotLocationSchema.safeParse(value);
                    if (!source.success) {
                      onNotice({ kind: 'error', message: 'That card move could not be read.' });
                      return;
                    }
                    void swap(source.data, location);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      setMoveSource(null);
                      setSelectedSlot(null);
                      setPlannerStatus('Card move cancelled.');
                    }
                    if (event.key.toLocaleLowerCase('en-AU') === 'm' && slot.cardId) {
                      event.preventDefault();
                      setMoveSource(location);
                      setSelectedSlot(null);
                    }
                    if (event.key === 'Delete' || event.key === 'Backspace') {
                      event.preventDefault();
                      if (version)
                        void mutate(
                          () =>
                            api.setSlot(version.id, {
                              expectedRevision: version.revision,
                              ...location,
                              cardId: null,
                            }),
                          'Slot cleared.',
                        );
                    }
                  }}
                  onClick={() => slotAction(location, slot.cardId !== null)}
                >
                  {card ? (
                    <>
                      <BinderCardArt card={card} />
                      <span title={`${card.name} · ${card.setName} ${card.number}`}>
                        <strong>{card.name}</strong>
                        <small>
                          {card.setName} · {card.number}
                        </small>
                      </span>
                    </>
                  ) : (
                    <span>{name ?? `Pocket ${slot.row + 1}:${slot.column + 1}`}</span>
                  )}
                </button>
              );
            })}
          </div>
        </section>
        <aside className="surface shortage-panel" aria-labelledby="shortages-heading">
          <h2 id="shortages-heading">Shortages</h2>
          {shortages.length ? (
            <ul>
              {shortages.map((shortage) => (
                <li key={shortage.cardId}>
                  <span>{knownCards.get(shortage.cardId)?.name ?? 'Unknown card'}</span>
                  <span className="state-badge warning">Need {shortage.missing}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p>No shortages.</p>
          )}
        </aside>
      </div>
    </>
  );
}
