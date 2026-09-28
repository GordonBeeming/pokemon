import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, type ReactElement } from 'react';
import { useSession } from '../api/queries/session';
import { ApiError, RETURN_TO_STORAGE_KEY } from '../api/client';
import { Icon } from '../ui/icons';
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

function Nav(): ReactElement {
  return (
    <>
      {NAV_ITEMS.map((item) => (
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
  const restored = useRef(false);

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
  if (signedOut || !session.data) return <SignIn />;

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

  return (
    <div className="app-shell">
      <nav aria-label="Primary" className="app-rail">
        <div className="app-brand">
          <span className="app-brand-mark">P</span>
          <span>Pokédex</span>
        </div>
        <Nav />
      </nav>
      <main className="app-content">
        <Outlet />
      </main>
      <nav aria-label="Primary" className="app-tabbar">
        <Nav />
      </nav>
    </div>
  );
}
