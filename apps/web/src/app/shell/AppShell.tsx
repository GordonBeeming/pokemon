import { useQueryClient } from '@tanstack/react-query';
import { PriceVisibilityProvider } from '../cards/PriceVisibility';
import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, type ReactElement } from 'react';
import { queryKeys } from '../api/keys';
import { useSession } from '../api/queries/session';
import { ApiError, AUTH_LOST_EVENT, RETURN_TO_STORAGE_KEY } from '../api/client';
import { Icon } from '../ui/icons';
import { LogoutButton } from './LogoutButton';
import { NAV_ITEMS } from './nav-items';
import { SignIn } from './SignIn';
import './shell.css';

function consumeReturnTo(): string | null {
  try {
    const value = sessionStorage.getItem(RETURN_TO_STORAGE_KEY);
    if (value) sessionStorage.removeItem(RETURN_TO_STORAGE_KEY);
    return value;
  } catch {
    return null;
  }
}

function Nav({ variant }: { variant: 'rail' | 'tabbar' }): ReactElement {
  const items = variant === 'tabbar' ? NAV_ITEMS.filter((item) => !item.railOnly) : NAV_ITEMS;
  return (
    <>
      {items.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          className="nav-item"
          activeProps={{ className: 'nav-item nav-item-active', 'aria-current': 'page' }}
          activeOptions={{ exact: item.to === '/' }}
        >
          <Icon name={item.icon} />
          <span>{item.label}</span>
        </Link>
      ))}
    </>
  );
}

export function AppShell(): ReactElement {
  const session = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const restored = useRef(false);

  // apiFetch raises this on any 401 (a revoked session, a restore, a disabled
  // account). Every other cached query is dropped so the previous user's data leaves
  // memory, and the session query is reset so it refetches and lands on sign-in.
  // Once the session itself has no data this is a no-op, so the session check's own
  // 401 can't set off another reset.
  useEffect(() => {
    function onAuthLost(): void {
      const sessionKey = queryKeys.session();
      if (queryClient.getQueryData(sessionKey) === undefined) return;
      restored.current = false;
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== sessionKey[0] });
      void queryClient.resetQueries({ queryKey: sessionKey });
    }
    globalThis.addEventListener(AUTH_LOST_EVENT, onAuthLost);
    return () => globalThis.removeEventListener(AUTH_LOST_EVENT, onAuthLost);
  }, [queryClient]);

  useEffect(() => {
    if (!session.data || restored.current) return;
    restored.current = true;
    const returnTo = consumeReturnTo();
    if (returnTo) void navigate({ href: returnTo });
  }, [session.data, navigate]);

  if (session.isLoading)
    return (
      <main className="sign-in-shell" aria-busy="true">
        <p>Checking your session…</p>
      </main>
    );

  const signedOut =
    session.isError && session.error instanceof ApiError && session.error.status === 401;
  if (signedOut) return <SignIn />;

  if (session.isError)
    return (
      <main className="sign-in-shell">
        <section className="sign-in-card">
          <h1>Pokédex could not start.</h1>
          <p className="notice error" role="alert">
            Reload the page and try again.
          </p>
          <button type="button" onClick={() => location.reload()}>
            Reload
          </button>
        </section>
      </main>
    );

  if (!session.data) return <SignIn />;

  return (
    <div className="app-shell">
      <nav aria-label="Primary" className="app-rail">
        <div className="app-brand">
          <span className="app-brand-mark">P</span>
          <span>Pokédex</span>
        </div>
        <Nav variant="rail" />
        <div className="rail-footer">
          <LogoutButton className="nav-item rail-logout" icon={<Icon name="logout" />} />
        </div>
      </nav>
      <main className="app-content">
        <PriceVisibilityProvider>
          <Outlet />
        </PriceVisibilityProvider>
      </main>
      <nav aria-label="Primary" className="app-tabbar">
        <Nav variant="tabbar" />
      </nav>
    </div>
  );
}
