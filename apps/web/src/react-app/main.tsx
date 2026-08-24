import { StrictMode, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { api, ApiError } from './api';
import type {
  Binder,
  BinderVersion,
  BinderLayout,
  CatalogueCardView,
  CatalogueDetailView,
  DesktopToken,
} from './api';
import './styles.css';

type Route = 'dashboard' | 'catalogue' | 'sets' | 'species' | 'binders' | 'devices';
type Notice = { kind: 'error' | 'success'; message: string } | null;
const routes: Array<[Route, string]> = [
  ['dashboard', 'Dashboard'],
  ['catalogue', 'Catalogue'],
  ['sets', 'Set checklists'],
  ['species', 'National Pokédex'],
  ['binders', 'Binder plans'],
  ['devices', 'Devices'],
];
const money = (value: number | null): string =>
  value === null
    ? 'No price'
    : `A$${new Intl.NumberFormat('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}`;
const message = (error: unknown): string =>
  error instanceof ApiError ? error.message : 'The request could not be completed. Try again.';

function Art({ card }: { card: CatalogueCardView | CatalogueDetailView }): ReactElement {
  return card.imageLowUrl ? (
    <img className="card-art" src={card.imageLowUrl} alt={`${card.name} card art`} loading="lazy" />
  ) : (
    <div className="card-art card-art-missing">Art unavailable</div>
  );
}
function Login({ onAuthenticated }: { onAuthenticated: () => void }): ReactElement {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<'login' | 'enrol' | null>(null);
  const [enrolSecret, setEnrolSecret] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const local = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
  async function authenticate(): Promise<void> {
    setPending('login');
    setError(null);
    try {
      const options = await api.authenticationOptions();
      const response = await startAuthentication({ optionsJSON: options });
      await api.verifyAuthentication(response);
      onAuthenticated();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setPending(null);
    }
  }
  async function enrol(): Promise<void> {
    if (!enrolSecret.trim() || !deviceName.trim()) {
      setError('Enter the enrolment secret and a device name.');
      return;
    }
    setPending('enrol');
    setError(null);
    try {
      const options = await api.registrationOptions(enrolSecret);
      const response = await startRegistration({ optionsJSON: options });
      await api.verifyRegistration(response, enrolSecret, deviceName);
      onAuthenticated();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setPending(null);
    }
  }
  return (
    <main className="auth-shell">
      <section className="auth-card">
        <p className="page-overline">Pokédex</p>
        <h1>Open your collection.</h1>
        <p>Use a registered passkey to open this private catalogue.</p>
        <button
          className="quiet-button tone-accent"
          type="button"
          disabled={pending !== null}
          onClick={() => void authenticate()}
        >
          {pending === 'login' ? 'Waiting for passkey…' : 'Continue with passkey'}
        </button>
        <label>
          Enrolment secret
          <input
            type="password"
            value={enrolSecret}
            onChange={(event) => setEnrolSecret(event.target.value)}
          />
        </label>
        <label>
          Device name
          <input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} />
        </label>
        <button
          className="quiet-button"
          type="button"
          disabled={pending !== null}
          onClick={() => void enrol()}
        >
          {pending === 'enrol' ? 'Creating passkey…' : 'Enrol this device'}
        </button>
        {local ? (
          <button
            className="text-button"
            type="button"
            onClick={() =>
              void api
                .devLogin()
                .then(onAuthenticated)
                .catch((reason) => setError(message(reason)))
            }
          >
            Use local development login
          </button>
        ) : null}
        {error ? <p className="notice error">{error}</p> : null}
      </section>
    </main>
  );
}
function Shell({
  route,
  navigate,
  notice,
  children,
}: {
  route: Route;
  navigate: (route: Route) => void;
  notice: Notice;
  children: ReactElement;
}): ReactElement {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#dashboard">
          <span>PK</span>
          <strong>Pokédex</strong>
        </a>
        <nav aria-label="Primary navigation">
          {routes.map(([key, label]) => (
            <button
              className={route === key ? 'nav-item active' : 'nav-item'}
              key={key}
              type="button"
              onClick={() => navigate(key)}
            >
              {label}
            </button>
          ))}
        </nav>
      </aside>
      <main className="workspace">
        {notice ? <p className={`notice ${notice.kind}`}>{notice.message}</p> : null}
        {children}
      </main>
    </div>
  );
}
function Dashboard({ data }: { data: Awaited<ReturnType<typeof api.dashboard>> }): ReactElement {
  return (
    <>
      <header className="page-heading">
        <div>
          <p className="page-overline">Collection overview</p>
          <h1>Your collection, in one place.</h1>
          <p>Prices and shortages come from the current collection state.</p>
        </div>
      </header>
      <section className="metric-grid">
        {[
          ['Owned unique', data.collection.uniqueOwned],
          ['Total quantity', data.collection.totalQuantity],
          ['Collection estimate', money(data.pricing.estimateAud)],
          ['Active shortages', data.activeShortages.reduce((sum, item) => sum + item.missing, 0)],
        ].map(([label, value]) => (
          <article className="metric" key={label as string}>
            <p>{label}</p>
            <strong>{value}</strong>
          </article>
        ))}
      </section>
    </>
  );
}
function Detail({
  card,
  save,
}: {
  card: CatalogueDetailView;
  save: (quantity: number, notes: string | null) => Promise<void>;
}): ReactElement {
  const [quantity, setQuantity] = useState(card.collection?.quantity ?? 0);
  const [notes, setNotes] = useState(card.collection?.notes ?? '');
  useEffect(() => {
    setQuantity(card.collection?.quantity ?? 0);
    setNotes(card.collection?.notes ?? '');
  }, [card]);
  return (
    <aside className="card-detail">
      <Art card={card} />
      <div className="detail-copy">
        <h2>{card.name}</h2>
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
            value={quantity}
            onChange={(event) => setQuantity(Math.max(0, Number(event.target.value)))}
          />
        </label>
        <label className="notes-field">
          Notes
          <textarea value={notes} onChange={(event) => setNotes(event.target.value)} />
        </label>
        <button
          className="quiet-button tone-accent"
          type="button"
          onClick={() => void save(quantity, notes.trim() || null)}
        >
          Save collection state
        </button>
      </div>
    </aside>
  );
}
function Catalogue({
  cards,
  total,
  loading,
  search,
  save,
}: {
  cards: CatalogueCardView[];
  total: number;
  loading: boolean;
  search: (query: string) => void;
  save: (card: CatalogueDetailView, quantity: number, notes: string | null) => Promise<void>;
}): ReactElement {
  const [query, setQuery] = useState('');
  const [customName, setCustomName] = useState('');
  const [detail, setDetail] = useState<CatalogueDetailView | null>(null);
  return (
    <>
      <header className="page-heading">
        <div>
          <p className="page-overline">Catalogue</p>
          <h1>Find a physical card.</h1>
          <p>Server-paginated search with collection and price state.</p>
        </div>
      </header>
      <section className="filter-bar">
        <label>
          Search
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') search(query);
            }}
          />
        </label>
        <button className="quiet-button" type="button" onClick={() => search(query)}>
          Search
        </button>
        <label>
          Custom card name
          <input value={customName} onChange={(event) => setCustomName(event.target.value)} />
        </label>
        <button
          className="quiet-button"
          type="button"
          disabled={!customName.trim()}
          onClick={() =>
            void api
              .createCustomCard({
                name: customName,
                language: 'en',
                category: 'special',
                setId: 'custom',
                setName: 'Custom cards',
                number: 'custom',
              })
              .then(() => {
                setCustomName('');
                search('');
              })
          }
        >
          Add custom card
        </button>
      </section>
      {loading ? (
        <div className="empty-state">
          <h3>Loading catalogue…</h3>
        </div>
      ) : (
        <div className="catalogue-layout">
          <section className="card-results">
            <div className="result-status">
              <span>{total} cards</span>
              <span>Page 1</span>
            </div>
            {cards.length === 0 ? (
              <div className="empty-state">
                <h3>No cards match this search.</h3>
              </div>
            ) : (
              cards.map((card) => (
                <button
                  className="card-row"
                  key={card.id}
                  type="button"
                  onClick={() => void api.card(card.id).then(setDetail)}
                >
                  <Art card={card} />
                  <span className="card-row-title">
                    <strong>{card.name}</strong>
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
          </section>
          {detail ? (
            <Detail card={detail} save={(quantity, notes) => save(detail, quantity, notes)} />
          ) : (
            <div className="card-detail">
              <div className="empty-state">
                <h3>Select a card.</h3>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
function Binders({
  binders,
  version,
  cards,
  update,
  onCreated,
  onActivated,
  onError,
}: {
  binders: Binder[];
  version: BinderVersion | null;
  cards: CatalogueCardView[];
  update: (version: BinderVersion) => void;
  onCreated: (version: BinderVersion) => void;
  onActivated: (version: BinderVersion) => void;
  onError: (error: unknown) => void;
}): ReactElement {
  const [cardId, setCardId] = useState('');
  const [pageIndex, setPageIndex] = useState(0);
  if (!version) return <BinderCreate update={onCreated} onError={onError} />;
  const binderVersion = version;
  const editable = binderVersion.status === 'draft';
  const pageIds = [...new Set(version.slots.map((slot) => slot.pageId))];
  const safePageIndex = Math.min(pageIndex, Math.max(0, pageIds.length - 1));
  const pageId = pageIds[safePageIndex];
  const slots = version.slots.filter((slot) => slot.pageId === pageId);
  async function swap(
    sourceRow: number,
    sourceColumn: number,
    sourceCardId: string,
    targetRow: number,
    targetColumn: number,
    targetCardId: string | null,
  ): Promise<void> {
    const original = binderVersion;
    try {
      await api.setSlot(binderVersion.id, safePageIndex, targetRow, targetColumn, sourceCardId);
      update(
        await api.setSlot(binderVersion.id, safePageIndex, sourceRow, sourceColumn, targetCardId),
      );
    } catch (error) {
      update(original);
      try {
        await api.setSlot(binderVersion.id, safePageIndex, targetRow, targetColumn, targetCardId);
      } catch (rollbackError) {
        onError(rollbackError);
      }
      onError(error);
    }
  }
  return (
    <>
      <header className="page-heading">
        <div>
          <p className="page-overline">Binder planner</p>
          <h1>{binders.find((binder) => binder.id === version.binderId)?.name ?? 'Binder plan'}</h1>
          <p>Drafts can reuse targets. Active versions report shortages.</p>
        </div>
        <button
          className="quiet-button"
          type="button"
          onClick={() => void api.cloneBinder(version.id).then(update).catch(onError)}
        >
          Clone draft
        </button>
        <button
          className="quiet-button"
          type="button"
          onClick={() => void api.activateBinder(version.id).then(onActivated).catch(onError)}
        >
          Activate
        </button>
        <button
          className="quiet-button"
          type="button"
          disabled={!editable}
          onClick={() => void api.addPage(version.id).then(update).catch(onError)}
        >
          Add page
        </button>
        <button
          className="quiet-button"
          type="button"
          disabled={!editable}
          onClick={() =>
            void api.arrangeBinder(version.id, 'set-number').then(update).catch(onError)
          }
        >
          Arrange set number
        </button>
        <button className="quiet-button" type="button" onClick={() => window.print()}>
          Print
        </button>
      </header>
      <div className="header-actions">
        <button
          className="quiet-button"
          type="button"
          disabled={safePageIndex === 0}
          onClick={() => setPageIndex((current) => current - 1)}
        >
          Previous page
        </button>
        <span>
          Page {safePageIndex + 1} of {pageIds.length}
        </span>
        <button
          className="quiet-button"
          type="button"
          disabled={safePageIndex >= pageIds.length - 1}
          onClick={() => setPageIndex((current) => current + 1)}
        >
          Next page
        </button>
        <button
          className="quiet-button"
          type="button"
          disabled={pageIds.length < 2 || pageId === undefined}
          onClick={() => {
            if (pageId) void api.deletePage(version.id, pageId).then(update);
          }}
        >
          Delete page
        </button>
        <button
          className="quiet-button"
          type="button"
          disabled={safePageIndex === 0}
          onClick={() =>
            void api
              .reorderPages(version.id, [
                ...pageIds.slice(0, safePageIndex - 1),
                pageIds[safePageIndex] ?? '',
                pageIds[safePageIndex - 1] ?? '',
                ...pageIds.slice(safePageIndex + 1),
              ])
              .then(update)
          }
        >
          Move page earlier
        </button>
        <button
          className="quiet-button"
          type="button"
          disabled={safePageIndex >= pageIds.length - 1}
          onClick={() =>
            void api
              .reorderPages(version.id, [
                ...pageIds.slice(0, safePageIndex),
                pageIds[safePageIndex + 1] ?? '',
                pageIds[safePageIndex] ?? '',
                ...pageIds.slice(safePageIndex + 2),
              ])
              .then(update)
          }
        >
          Move page later
        </button>
      </div>
      <label>
        Place card
        <select value={cardId} onChange={(event) => setCardId(event.target.value)}>
          <option value="">Choose a card</option>
          {cards.map((card) => (
            <option key={card.id} value={card.id}>
              {card.name}
            </option>
          ))}
        </select>
      </label>
      {!editable ? (
        <p className="notice error">
          This version is active. Clone it before editing slots or pages.
        </p>
      ) : null}
      <div className="planner-layout">
        <section className="binder-page">
          <div
            className="binder-grid"
            style={{ gridTemplateColumns: `repeat(${version.layout.columns}, minmax(0, 1fr))` }}
          >
            {slots.map((slot) => (
              <button
                className="binder-slot"
                key={`${slot.row}-${slot.column}`}
                type="button"
                draggable={slot.cardId !== null}
                onDragStart={(event) =>
                  event.dataTransfer.setData(
                    'text/binder-slot',
                    JSON.stringify({ row: slot.row, column: slot.column, cardId: slot.cardId }),
                  )
                }
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  const value = event.dataTransfer.getData('text/binder-slot');
                  try {
                    const source: unknown = JSON.parse(value);
                    if (
                      typeof source === 'object' &&
                      source !== null &&
                      'row' in source &&
                      'column' in source &&
                      'cardId' in source &&
                      typeof source.row === 'number' &&
                      typeof source.column === 'number' &&
                      typeof source.cardId === 'string'
                    )
                      void swap(
                        source.row,
                        source.column,
                        source.cardId,
                        slot.row,
                        slot.column,
                        slot.cardId,
                      );
                  } catch {
                    return;
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Delete' || event.key === 'Backspace') {
                    event.preventDefault();
                    void api.setSlot(version.id, 0, slot.row, slot.column, null).then(update);
                  }
                  if ((event.key === 'Enter' || event.key === ' ') && cardId) {
                    event.preventDefault();
                    void api.setSlot(version.id, 0, slot.row, slot.column, cardId).then(update);
                  }
                }}
                disabled={!editable}
                onClick={() => {
                  if (cardId)
                    void api
                      .setSlot(version.id, 0, slot.row, slot.column, cardId)
                      .then(update)
                      .catch(onError);
                }}
              >
                {slot.cardId
                  ? (cards.find((card) => card.id === slot.cardId)?.name ?? slot.cardId)
                  : `Slot ${slot.row + 1}:${slot.column + 1}`}
              </button>
            ))}
          </div>
        </section>
        <aside className="surface shortage-panel">
          <h2>Shortages</h2>
          {version.shortages.length ? (
            <ul>
              {version.shortages.map((shortage) => (
                <li key={shortage.cardId}>
                  {cards.find((card) => card.id === shortage.cardId)?.name ?? shortage.cardId}
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
function BinderCreate({
  update,
  onError,
}: {
  update: (version: BinderVersion) => void;
  onError: (error: unknown) => void;
}): ReactElement {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'2x2' | '3x3' | '4x3' | 'top-loader' | 'custom'>('3x3');
  const [rows, setRows] = useState(3);
  const [columns, setColumns] = useState(3);
  const dimensions =
    kind === '2x2'
      ? [2, 2]
      : kind === '3x3'
        ? [3, 3]
        : kind === '4x3'
          ? [3, 4]
          : kind === 'top-loader'
            ? [2, 2]
            : [rows, columns];
  const layout = (): BinderLayout =>
    kind === 'custom'
      ? { kind, rows: Math.max(1, rows), columns: Math.max(1, columns) }
      : { kind, rows: dimensions[0] ?? 1, columns: dimensions[1] ?? 1 };
  return (
    <section className="surface activity-panel">
      <h1>Create your first binder.</h1>
      <label>
        Name
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        Layout
        <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
          <option value="2x2">2 × 2</option>
          <option value="3x3">3 × 3</option>
          <option value="4x3">4 × 3</option>
          <option value="top-loader">Top-loader</option>
          <option value="custom">Custom</option>
        </select>
      </label>
      {kind === 'custom' ? (
        <>
          <label>
            Rows
            <input
              type="number"
              min="1"
              value={rows}
              onChange={(event) => setRows(Number(event.target.value))}
            />
          </label>
          <label>
            Columns
            <input
              type="number"
              min="1"
              value={columns}
              onChange={(event) => setColumns(Number(event.target.value))}
            />
          </label>
        </>
      ) : null}
      <button
        className="quiet-button tone-accent"
        type="button"
        disabled={!name.trim()}
        onClick={() => void api.createBinder(name, layout()).then(update).catch(onError)}
      >
        Create binder
      </button>
    </section>
  );
}
function Facets({
  title,
  items,
  onChoose,
}: {
  title: string;
  items: Array<{ id: string; label: string; detail: string }>;
  onChoose: (id: string) => void;
}): ReactElement {
  return (
    <>
      <header className="page-heading">
        <div>
          <p className="page-overline">Catalogue facets</p>
          <h1>{title}</h1>
          <p>Open a facet to search its physical cards.</p>
        </div>
      </header>
      <section className="set-list">
        {items.length === 0 ? (
          <div className="empty-state">
            <h3>Nothing to show yet.</h3>
          </div>
        ) : (
          items.map((item) => (
            <button
              className="surface set-row"
              key={item.id}
              type="button"
              onClick={() => onChoose(item.id)}
            >
              <div>
                <h2>{item.label}</h2>
                <p>{item.detail}</p>
              </div>
              <span>Open catalogue</span>
            </button>
          ))
        )}
      </section>
    </>
  );
}
function Devices({
  tokens,
  pairCode,
  pair,
  revoke,
}: {
  tokens: DesktopToken[];
  pairCode: string | null;
  pair: () => void;
  revoke: (id: string) => void;
}): ReactElement {
  return (
    <>
      <header className="page-heading">
        <div>
          <p className="page-overline">Trusted devices</p>
          <h1>Pair the scan companion.</h1>
        </div>
        <button className="quiet-button tone-accent" type="button" onClick={pair}>
          Create pairing code
        </button>
      </header>
      {pairCode ? <p className="pair-code">{pairCode}</p> : null}
      {tokens.map((token) => (
        <article className="surface device-row" key={token.id}>
          <div>
            <h2>{token.label}</h2>
            <p>{token.lastUsedAt ?? 'Not used yet'}</p>
          </div>
          <button className="quiet-button" type="button" onClick={() => revoke(token.id)}>
            Revoke
          </button>
        </article>
      ))}
    </>
  );
}
function App(): ReactElement {
  const [session, setSession] = useState(false);
  const [route, setRoute] = useState<Route>(
    () => routes.find(([key]) => `#${key}` === location.hash)?.[0] ?? 'dashboard',
  );
  const [dashboard, setDashboard] = useState<Awaited<ReturnType<typeof api.dashboard>> | null>(
    null,
  );
  const [cards, setCards] = useState<CatalogueCardView[]>([]);
  const [total, setTotal] = useState(0);
  const [binders, setBinders] = useState<Binder[]>([]);
  const [version, setVersion] = useState<BinderVersion | null>(null);
  const [tokens, setTokens] = useState<DesktopToken[]>([]);
  const [sets, setSets] = useState<
    Array<{ setId: string; setName: string; language: string; total: number; owned: number }>
  >([]);
  const [species, setSpecies] = useState<
    Array<{ species: string; total: number; owned: number; languages: string[] }>
  >([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Notice>(null);
  const [pairCode, setPairCode] = useState<string | null>(null);
  const load = async (): Promise<void> => {
    setLoading(true);
    try {
      const [nextDashboard, result, nextBinders, nextTokens, nextSets, nextSpecies] =
        await Promise.all([
          api.dashboard(),
          api.search(new URLSearchParams({ limit: '50', offset: '0' })),
          api.binders(),
          api.tokens(),
          api.sets(),
          api.species(),
        ]);
      setDashboard(nextDashboard);
      setCards(result.cards);
      setTotal(result.total);
      setBinders(nextBinders);
      setTokens(nextTokens);
      setSets(nextSets);
      setSpecies(nextSpecies);
      const active = nextBinders.find((binder) => binder.activeVersionId ?? binder.latestVersionId);
      const versionId = active?.activeVersionId ?? active?.latestVersionId;
      if (versionId) setVersion(await api.binder(versionId));
    } catch (error) {
      setNotice({ kind: 'error', message: message(error) });
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void api
      .me()
      .then(() => {
        setSession(true);
        return load();
      })
      .catch(() => setLoading(false));
  }, []);
  useEffect(() => {
    const update = (): void =>
      setRoute(routes.find(([key]) => `#${key}` === location.hash)?.[0] ?? 'dashboard');
    addEventListener('hashchange', update);
    return () => removeEventListener('hashchange', update);
  }, []);
  if (!session)
    return loading ? (
      <main className="auth-shell">
        <div className="empty-state">
          <h3>Checking your session…</h3>
        </div>
      </main>
    ) : (
      <Login
        onAuthenticated={() =>
          void api.me().then(() => {
            setSession(true);
            return load();
          })
        }
      />
    );
  const save = async (
    card: CatalogueDetailView,
    quantity: number,
    notes: string | null,
  ): Promise<void> => {
    const before = cards;
    setCards((current) =>
      current.map((item) =>
        item.id === card.id
          ? {
              ...item,
              collection: { cardId: item.id, quantity, notes, updatedAt: new Date().toISOString() },
            }
          : item,
      ),
    );
    try {
      await api.setCollection(card.id, quantity, notes, crypto.randomUUID());
      setNotice({ kind: 'success', message: 'Collection state saved.' });
      await load();
    } catch (error) {
      setCards(before);
      setNotice({ kind: 'error', message: message(error) });
    }
  };
  const navigate = (next: Route): void => {
    location.hash = next;
    setRoute(next);
  };
  const content =
    route === 'catalogue' ? (
      <Catalogue
        cards={cards}
        total={total}
        loading={loading}
        search={(query) =>
          void api
            .search(new URLSearchParams({ q: query, limit: '50', offset: '0' }))
            .then((result) => {
              setCards(result.cards);
              setTotal(result.total);
            })
            .catch((error) => setNotice({ kind: 'error', message: message(error) }))
        }
        save={save}
      />
    ) : route === 'sets' ? (
      <Facets
        title="Set checklists"
        items={sets.map((item) => ({
          id: item.setId,
          label: item.setName,
          detail: `${item.owned} of ${item.total} owned · ${item.language}`,
        }))}
        onChoose={(setId) => {
          navigate('catalogue');
          void api
            .search(new URLSearchParams({ setId, limit: '50', offset: '0' }))
            .then((result) => {
              setCards(result.cards);
              setTotal(result.total);
            });
        }}
      />
    ) : route === 'species' ? (
      <Facets
        title="National Pokédex"
        items={species.map((item) => ({
          id: item.species,
          label: item.species,
          detail: `${item.owned} of ${item.total} owned · ${item.languages.join(', ')}`,
        }))}
        onChoose={(selected) => {
          navigate('catalogue');
          void api
            .search(new URLSearchParams({ species: selected, limit: '50', offset: '0' }))
            .then((result) => {
              setCards(result.cards);
              setTotal(result.total);
            });
        }}
      />
    ) : route === 'binders' ? (
      <Binders
        binders={binders}
        version={version}
        cards={cards}
        update={setVersion}
        onCreated={(created) => {
          setVersion(created);
          void api
            .binders()
            .then(setBinders)
            .catch((error) => setNotice({ kind: 'error', message: message(error) }));
        }}
        onActivated={(activated) => {
          setVersion(activated);
          void api
            .dashboard()
            .then(setDashboard)
            .catch((error) => setNotice({ kind: 'error', message: message(error) }));
        }}
        onError={(error) => setNotice({ kind: 'error', message: message(error) })}
      />
    ) : route === 'devices' ? (
      <Devices
        tokens={tokens}
        pairCode={pairCode}
        pair={() =>
          void api
            .pair()
            .then(setPairCode)
            .catch((error) => setNotice({ kind: 'error', message: message(error) }))
        }
        revoke={(id) =>
          void api
            .revokeToken(id)
            .then(() => setTokens((current) => current.filter((token) => token.id !== id)))
            .catch((error) => setNotice({ kind: 'error', message: message(error) }))
        }
      />
    ) : dashboard ? (
      <Dashboard data={dashboard} />
    ) : (
      <div className="empty-state">
        <h3>Loading dashboard…</h3>
      </div>
    );
  return (
    <Shell route={route} navigate={navigate} notice={notice}>
      {content}
    </Shell>
  );
}
const root = document.getElementById('root');
if (!root) throw new Error('The application root is missing');
if ('serviceWorker' in navigator)
  void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
