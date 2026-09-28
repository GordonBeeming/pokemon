import { useRouterState } from '@tanstack/react-router';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Icon } from './icons';
import './Toast.css';

// --- Route-scoped live region -------------------------------------------------
// One live region per route, not a global "Loading…" that keeps talking after the
// screen it described is gone. A route change clears whatever the previous screen
// last announced before the new one gets a chance to announce its own.

type Announce = (message: string) => void;
const RouteStatusContext = createContext<Announce | null>(null);

export function RouteLiveRegionProvider({ children }: { children: ReactNode }): ReactElement {
  const [status, setStatus] = useState('');
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  useEffect(() => {
    setStatus('');
  }, [pathname]);

  const announce = useMemo<Announce>(() => (message) => setStatus(message), []);

  return (
    <RouteStatusContext.Provider value={announce}>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {status}
      </p>
      {children}
    </RouteStatusContext.Provider>
  );
}

export function useRouteAnnounce(): Announce {
  const announce = useContext(RouteStatusContext);
  if (!announce) throw new Error('useRouteAnnounce must be used inside RouteLiveRegionProvider');
  return announce;
}

// --- Toast --------------------------------------------------------------------
// A transient, dismissible notice (save confirmed, action failed). Unlike the live
// region above, a toast is allowed to outlive the route it was raised from — the
// user asked for the confirmation, not the screen.

export interface ToastAction {
  label: string;
  onSelect: () => void;
}
export interface ToastEntry {
  id: number;
  kind: 'success' | 'error';
  message: string;
  action?: ToastAction;
}
type ShowToast = (kind: ToastEntry['kind'], message: string, action?: ToastAction) => void;
const ToastContext = createContext<ShowToast | null>(null);

const TOAST_LIFETIME_MS = 5000;

export function ToastProvider({ children }: { children: ReactNode }): ReactElement {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback<ShowToast>(
    (kind, message, action) => {
      const id = nextId.current++;
      setToasts((current) => [...current, { id, kind, message, action }]);
      setTimeout(() => dismiss(id), TOAST_LIFETIME_MS);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toast-viewport" role="region" aria-label="Notifications">
        {toasts.map((toast) => (
          <p
            key={toast.id}
            className={`toast toast-${toast.kind}`}
            role={toast.kind === 'error' ? 'alert' : 'status'}
          >
            <span className="toast-message">
              {toast.message}
              {toast.action ? (
                <>
                  {' '}
                  <button
                    type="button"
                    className="toast-action"
                    onClick={() => {
                      dismiss(toast.id);
                      toast.action?.onSelect();
                    }}
                  >
                    {toast.action.label}
                  </button>
                </>
              ) : null}
            </span>
            <button
              type="button"
              className="toast-dismiss"
              aria-label="Dismiss"
              onClick={() => dismiss(toast.id)}
            >
              <Icon name="close" />
            </button>
          </p>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ShowToast {
  const show = useContext(ToastContext);
  if (!show) throw new Error('useToast must be used inside ToastProvider');
  return show;
}
