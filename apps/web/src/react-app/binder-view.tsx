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

const binderKinds: BinderLayout['kind'][] = ['2x2', '3x3', '4x3', 'top-loader', 'custom'];

function isBinderKind(value: string): value is BinderLayout['kind'] {
  return binderKinds.some((kind) => kind === value);
}

function fixedLayout(kind: Exclude<BinderLayout['kind'], 'custom'>): BinderLayout {
  if (kind === '2x2') return { kind, rows: 2, columns: 2 };
  if (kind === '3x3') return { kind, rows: 3, columns: 3 };
  if (kind === '4x3') return { kind, rows: 3, columns: 4 };
  return { kind, rows: 2, columns: 2 };
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
        <label>
          Layout
          <select
            value={kind}
            onChange={(event) => {
              const parsed = event.target.value;
              if (isBinderKind(parsed)) setKind(parsed);
            }}
          >
            <option value="2x2">2 × 2</option>
            <option value="3x3">3 × 3</option>
            <option value="4x3">4 × 3</option>
            <option value="top-loader">Top-loader</option>
            <option value="custom">Custom</option>
          </select>
        </label>
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
  const [shortages, setShortages] = useState<Array<{ cardId: string; missing: number }>>([]);
  const [page, setPage] = useState(0);
  const [cardQuery, setCardQuery] = useState('');
  const [cards, setCards] = useState<CatalogueCardView[]>([]);
  const [cardId, setCardId] = useState('');
  const [pending, setPending] = useState(false);
  const [plannerStatus, setPlannerStatus] = useState('');
  const [moveSource, setMoveSource] = useState<BinderSlotLocation | null>(null);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);

  const version = binder?.version ?? null;
  const currentPage = binder?.pages[0] ?? null;
  const editable = version?.status === 'draft';

  async function loadVersion(versionId: string, nextPage: number): Promise<void> {
    const currentGeneration = ++generation.current;
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    setPending(true);
    try {
      const [nextBinder, shortagePage] = await Promise.all([
        api.binder(versionId, nextPage, 1, nextController.signal),
        api.binderShortages(versionId, 0, 100, nextController.signal),
      ]);
      if (currentGeneration !== generation.current) return;
      setBinder(nextBinder);
      setShortages(shortagePage.shortages);
      setPage(nextPage);
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
      const selected = next.find((item) => item.activeVersionId ?? item.latestVersionId);
      const versionId = selected?.activeVersionId ?? selected?.latestVersionId;
      if (versionId) await loadVersion(versionId, 0);
      else setBinder(null);
    } catch (error) {
      const message = userMessage(error);
      if (message) onNotice({ kind: 'error', message });
    } finally {
      setPending(false);
    }
  }

  useEffect(() => {
    void loadBinders();
    return () => controller.current?.abort();
  }, []);

  function mergeMutation(result: BinderMutationResult): void {
    setBinder((current) => {
      if (!current) return { version: result.version, pages: result.pages, nextPage: null };
      const affected = result.pages.find((item) => item.position === page);
      return { ...current, version: result.version, pages: affected ? [affected] : current.pages };
    });
  }

  async function mutate(
    action: () => Promise<BinderMutationResult>,
    success: string,
  ): Promise<void> {
    if (!version) return;
    setPending(true);
    onNotice(null);
    try {
      const result = await action();
      mergeMutation(result);
      setPlannerStatus(success);
      onNotice({ kind: 'success', message: success });
    } catch (error) {
      const message = userMessage(error);
      if (message) onNotice({ kind: 'error', message });
      if (error instanceof ApiError && error.code === 'binder_revision_conflict')
        await loadVersion(version.id, page);
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

  async function searchCards(): Promise<void> {
    const params = new URLSearchParams({ q: cardQuery, limit: '50', offset: '0' });
    try {
      const result = await api.search(params);
      setCards(result.cards);
      setPlannerStatus(`${result.cards.length} card options loaded.`);
    } catch (error) {
      const message = userMessage(error);
      if (message) onNotice({ kind: 'error', message });
    }
  }

  async function swap(source: BinderSlotLocation, target: BinderSlotLocation): Promise<void> {
    if (!version) return;
    await mutate(
      () => api.swapSlots(version.id, { expectedRevision: version.revision, source, target }),
      'Cards moved.',
    );
    setMoveSource(null);
  }

  function slotAction(location: BinderSlotLocation, occupied: boolean): void {
    if (!version || !editable || pending) return;
    if (moveSource) {
      void swap(moveSource, location);
      return;
    }
    if (occupied) {
      setMoveSource(location);
      setPlannerStatus(
        `Picked up the card from row ${location.row + 1}, column ${location.column + 1}. Choose a destination or press Escape to cancel.`,
      );
      return;
    }
    if (cardId)
      void mutate(
        () =>
          api.setSlot(version.id, {
            expectedRevision: version.revision,
            ...location,
            cardId,
          }),
        'Card placed.',
      );
  }

  if (!binder && !pending)
    return (
      <BinderCreate
        pending={pending}
        create={(name, layout) =>
          void api
            .createBinder(name, layout)
            .then((created) => {
              mergeMutation(created);
              return loadBinders();
            })
            .catch((error: unknown) => onNotice({ kind: 'error', message: userMessage(error) }))
        }
      />
    );

  return (
    <>
      <header className="page-heading">
        <div>
          <h1>{binders.find((item) => item.id === version?.binderId)?.name ?? 'Binder plan'}</h1>
          <p>Move cards with drag and drop or the same pick-and-place flow from the keyboard.</p>
        </div>
        <div className="header-actions">
          <button
            className="quiet-button"
            type="button"
            disabled={!version || pending}
            onClick={() =>
              version &&
              void mutate(() => api.cloneBinder(version.id, version.revision), 'Draft cloned.')
            }
          >
            Clone draft
          </button>
          <button
            className="quiet-button"
            type="button"
            disabled={!version || pending || version.status === 'active'}
            onClick={() =>
              version &&
              void mutate(
                () => api.activateBinder(version.id, version.revision),
                'Binder activated.',
              )
            }
          >
            Activate
          </button>
          <button className="quiet-button" type="button" onClick={() => window.print()}>
            Print
          </button>
        </div>
      </header>
      <div className="planner-toolbar">
        <label>
          Binder version
          <select
            value={version?.id ?? ''}
            disabled={pending}
            onChange={(event) => void loadVersion(event.target.value, 0)}
          >
            {binders.map((item) => {
              const id = item.activeVersionId ?? item.latestVersionId;
              return id ? (
                <option key={id} value={id}>
                  {item.name}
                </option>
              ) : null;
            })}
          </select>
        </label>
        <form
          className="card-picker"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            void searchCards();
          }}
        >
          <label>
            Find card to place
            <input
              value={cardQuery}
              maxLength={200}
              onChange={(event) => setCardQuery(event.target.value)}
            />
          </label>
          <button className="quiet-button" type="submit">
            Find cards
          </button>
        </form>
        <label>
          Card target
          <select value={cardId} onChange={(event) => setCardId(event.target.value)}>
            <option value="">Choose a search result</option>
            {cards.map((card) => (
              <option key={card.id} value={card.id}>
                {card.name} · {card.setName} {card.number}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="result-announcement" role="status" aria-live="polite" aria-atomic="true">
        {plannerStatus}
      </p>
      <div className="header-actions page-actions">
        <button
          className="quiet-button"
          type="button"
          disabled={page === 0 || pending}
          onClick={() => version && void loadVersion(version.id, page - 1)}
        >
          Previous page
        </button>
        <span>
          Page {page + 1} of {version?.pageCount ?? 0}
        </span>
        <button
          className="quiet-button"
          type="button"
          disabled={!version || page + 1 >= version.pageCount || pending}
          onClick={() => version && void loadVersion(version.id, page + 1)}
        >
          Next page
        </button>
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
        <button
          className="quiet-button"
          type="button"
          disabled={!editable || pending || !currentPage || (version?.pageCount ?? 0) <= 1}
          onClick={() =>
            version &&
            currentPage &&
            void mutate(
              () => api.deletePage(version.id, currentPage.id, version.revision),
              'Binder page deleted.',
            )
          }
        >
          Delete page
        </button>
        <button
          className="quiet-button"
          type="button"
          disabled={!editable || pending || page === 0}
          onClick={() =>
            version &&
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
            })
          }
        >
          Move page earlier
        </button>
        <button
          className="quiet-button"
          type="button"
          disabled={!editable || pending || !version || page + 1 >= version.pageCount}
          onClick={() =>
            version &&
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
            })
          }
        >
          Move page later
        </button>
        <button
          className="quiet-button"
          type="button"
          disabled={!editable || pending || !version}
          onClick={() =>
            version &&
            void mutate(
              () => api.arrangeBinder(version.id, 'set-number', version.revision),
              'Cards arranged by set number.',
            )
          }
        >
          Arrange set number
        </button>
      </div>
      {!editable ? (
        <p className="notice error">
          This version is active. Clone it before editing pages or slots.
        </p>
      ) : null}
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
              const name = cards.find((card) => card.id === slot.cardId)?.name ?? slot.cardId;
              const moving =
                moveSource?.page === page &&
                moveSource.row === slot.row &&
                moveSource.column === slot.column;
              return (
                <button
                  className={moving ? 'binder-slot move-source' : 'binder-slot'}
                  key={`${slot.row}-${slot.column}`}
                  type="button"
                  disabled={!editable || pending}
                  draggable={slot.cardId !== null && editable}
                  aria-pressed={moving}
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
                      setPlannerStatus('Card move cancelled.');
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
                  <span title={name ?? undefined}>
                    {name ?? `Slot ${slot.row + 1}:${slot.column + 1}`}
                  </span>
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
                  <span>
                    {cards.find((card) => card.id === shortage.cardId)?.name ?? shortage.cardId}
                  </span>
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
