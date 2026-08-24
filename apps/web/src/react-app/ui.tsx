import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { api, ApiError, type Dashboard, type DesktopToken, type PairingCode } from './api';

export type Route = 'dashboard' | 'catalogue' | 'sets' | 'species' | 'binders' | 'devices';
export type Notice = { kind: 'error' | 'success'; message: string } | null;

export const routes: Array<[Route, string]> = [
  ['dashboard', 'Dashboard'],
  ['catalogue', 'Catalogue'],
  ['sets', 'Set checklists'],
  ['species', 'National Pokédex'],
  ['binders', 'Binder plans'],
  ['devices', 'Devices'],
];

const errorMessages: Record<string, string> = {
  invalid_body: 'Check the highlighted values and try again.',
  invalid_filter: 'One of the selected filters is not valid.',
  unauthorized: 'Your session has ended. Sign in again.',
  verification_failed: 'The passkey could not be verified. Try again on this device.',
  challenge_expired: 'That passkey request expired. Start again.',
  unknown_credential: 'This passkey is not registered for the collection.',
  binder_revision_conflict: 'This binder changed elsewhere. The latest page has been reloaded.',
  collection_revision_conflict:
    'This card changed elsewhere. Reopen it before saving your changes.',
  collection_mutation_conflict: 'That save request was already used for different changes.',
  collection_quantity_out_of_bounds: 'Quantity must stay between 0 and 9,999.',
  binder_version_not_draft: 'Clone this binder version before editing it.',
  binder_last_page: 'A binder must keep at least one page.',
  desktop_token_not_found: 'That device was already revoked.',
  rate_limited: 'Too many attempts were made. Wait a moment, then try again.',
  invalid_response: 'The server returned an unreadable response. Try again.',
  internal_error: 'The server could not complete the request. Try again.',
};

export function userMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return '';
  if (!(error instanceof ApiError)) return 'The request could not be completed. Try again.';
  const base = errorMessages[error.code] ?? 'The request could not be completed. Try again.';
  const retry = error.retryAfterSeconds ? ` Try again in ${error.retryAfterSeconds} seconds.` : '';
  const reference = error.requestId ? ` Reference ${error.requestId}.` : '';
  return `${base}${retry}${reference}`;
}

export const money = (value: number | null): string =>
  value === null
    ? 'No price'
    : `A$${new Intl.NumberFormat('en-AU', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(value)}`;

export function Login({ onAuthenticated }: { onAuthenticated: () => void }): ReactElement {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<'login' | 'enrol' | null>(null);
  const [enrolSecret, setEnrolSecret] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [invalid, setInvalid] = useState(false);
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
      const message = userMessage(reason);
      if (message) setError(message);
    } finally {
      setPending(null);
    }
  }

  async function enrol(): Promise<void> {
    const missing = !enrolSecret.trim() || !deviceName.trim();
    setInvalid(missing);
    if (missing) {
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
      const message = userMessage(reason);
      if (message) setError(message);
    } finally {
      setPending(null);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-card" aria-labelledby="login-heading">
        <h1 id="login-heading">Open your collection.</h1>
        <p>Use a registered passkey to open this private catalogue.</p>
        <button
          className="quiet-button tone-accent"
          type="button"
          disabled={pending !== null}
          onClick={() => void authenticate()}
        >
          {pending === 'login' ? 'Waiting for passkey…' : 'Continue with passkey'}
        </button>
        <form
          className="enrol-form"
          aria-labelledby="enrol-heading"
          onSubmit={(event) => {
            event.preventDefault();
            void enrol();
          }}
        >
          <h2 id="enrol-heading">Enrol another device</h2>
          <label>
            Enrolment secret
            <input
              type="password"
              value={enrolSecret}
              maxLength={256}
              required
              aria-invalid={invalid && !enrolSecret.trim()}
              aria-describedby={error ? 'login-error' : undefined}
              onChange={(event) => setEnrolSecret(event.target.value)}
            />
          </label>
          <label>
            Device name
            <input
              value={deviceName}
              maxLength={60}
              required
              aria-invalid={invalid && !deviceName.trim()}
              aria-describedby={error ? 'login-error' : undefined}
              onChange={(event) => setDeviceName(event.target.value)}
            />
          </label>
          <button className="quiet-button" type="submit" disabled={pending !== null}>
            {pending === 'enrol' ? 'Creating passkey…' : 'Enrol this device'}
          </button>
        </form>
        {local ? (
          <button
            className="text-button"
            type="button"
            onClick={() =>
              void api
                .devLogin()
                .then(onAuthenticated)
                .catch((reason: unknown) => setError(userMessage(reason)))
            }
          >
            Use local development login
          </button>
        ) : null}
        <p id="login-error" className="notice error" role="alert" aria-live="assertive">
          {error ?? ''}
        </p>
      </section>
    </main>
  );
}

export function Shell({
  route,
  navigate,
  notice,
  children,
}: {
  route: Route;
  navigate: (route: Route) => void;
  notice: Notice;
  children: ReactNode;
}): ReactElement {
  const main = useRef<HTMLElement>(null);
  useEffect(() => {
    main.current?.focus();
    document.title = `${routes.find(([key]) => key === route)?.[1] ?? 'Pokédex'} · Pokédex`;
  }, [route]);
  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Application navigation">
        <a className="brand" href="#dashboard" onClick={() => navigate('dashboard')}>
          <span aria-hidden="true">PK</span>
          <strong>Pokédex</strong>
        </a>
        <nav aria-label="Primary navigation">
          {routes.map(([key, label]) => (
            <button
              className={route === key ? 'nav-item active' : 'nav-item'}
              key={key}
              type="button"
              aria-current={route === key ? 'page' : undefined}
              onClick={() => navigate(key)}
            >
              {label}
            </button>
          ))}
        </nav>
      </aside>
      <main className="workspace" ref={main} tabIndex={-1}>
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {notice?.kind === 'success' ? notice.message : ''}
        </p>
        <p className="notice error" role="alert" aria-live="assertive" aria-atomic="true">
          {notice?.kind === 'error' ? notice.message : ''}
        </p>
        {notice?.kind === 'success' ? <p className="notice success">{notice.message}</p> : null}
        {children}
      </main>
    </div>
  );
}

export function DashboardView({ data }: { data: Dashboard }): ReactElement {
  return (
    <>
      <header className="page-heading">
        <div>
          <h1>Your collection, in one place.</h1>
          <p>Prices and shortages reflect the latest saved collection state.</p>
        </div>
      </header>
      <section className="metric-grid" aria-label="Collection measures">
        {[
          ['Owned unique', data.collection.uniqueOwned],
          ['Total quantity', data.collection.totalQuantity],
          ['Collection estimate', money(data.pricing.estimateAud)],
          ['Active shortages', data.activeShortages.reduce((sum, item) => sum + item.missing, 0)],
        ].map(([label, value]) => (
          <article className="metric" key={String(label)}>
            <p>{label}</p>
            <strong>{value}</strong>
          </article>
        ))}
      </section>
    </>
  );
}

export function FacetsView({
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
          <h1>{title}</h1>
          <p>Choose a facet to open its physical cards.</p>
        </div>
      </header>
      <section className="set-list" aria-label={title}>
        {items.length === 0 ? (
          <div className="empty-state">
            <h2>Nothing to show yet.</h2>
          </div>
        ) : (
          items.map((item) => (
            <button
              className="surface set-row"
              key={item.id}
              type="button"
              onClick={() => onChoose(item.id)}
            >
              <span>
                <strong>{item.label}</strong>
                <small>{item.detail}</small>
              </span>
              <span>Open catalogue</span>
            </button>
          ))
        )}
      </section>
    </>
  );
}

export function DevicesView({
  tokens,
  pairCode,
  pending,
  pair,
  revoke,
  copied,
  copyFailed,
}: {
  tokens: DesktopToken[];
  pairCode: PairingCode | null;
  pending: boolean;
  pair: () => void;
  revoke: (id: string) => void;
  copied: () => void;
  copyFailed: () => void;
}): ReactElement {
  return (
    <>
      <header className="page-heading">
        <div>
          <h1>Pair the scan companion.</h1>
          <p>Codes are single-use. Create one when the scanner is ready.</p>
        </div>
        <button
          className="quiet-button tone-accent"
          type="button"
          disabled={pending}
          onClick={pair}
        >
          {pending ? 'Creating code…' : 'Create pairing code'}
        </button>
      </header>
      <output className="pair-output" aria-live="polite" aria-atomic="true">
        {pairCode ? (
          <>
            <span>
              Pairing code <strong>{pairCode.code}</strong>
            </span>
            <span>
              {pairCode.expiresAt
                ? `Expires ${new Intl.DateTimeFormat('en-AU', { timeStyle: 'short' }).format(new Date(pairCode.expiresAt))}.`
                : 'Use this code promptly.'}
            </span>
            <button
              className="quiet-button"
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(pairCode.code).then(copied, copyFailed);
              }}
            >
              Copy code
            </button>
          </>
        ) : null}
      </output>
      <section className="device-list" aria-label="Paired devices">
        {tokens.length === 0 ? (
          <div className="empty-state">
            <h2>No scanner is paired.</h2>
          </div>
        ) : (
          tokens.map((token) => (
            <article className="surface device-row" key={token.id}>
              <div>
                <h2>{token.label}</h2>
                <p>
                  {token.lastUsedAt
                    ? `Last used ${new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(token.lastUsedAt))}`
                    : 'Not used yet'}
                </p>
              </div>
              <button
                className="quiet-button"
                type="button"
                aria-label={`Revoke ${token.label}`}
                onClick={() => revoke(token.id)}
              >
                Revoke
              </button>
            </article>
          ))
        )}
      </section>
    </>
  );
}
