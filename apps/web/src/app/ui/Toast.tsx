import { useRouterState } from '@tanstack/react-router';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
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
      {/* Stays audible while a modal hides the rest of the page from assistive tech. */}
      <p
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-react-aria-top-layer="true"
      >
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
/** Room a toast needs above an overlay's top edge before it can sit there. */
const TOAST_ROOM_ABOVE_PX = 96;
/** Room beside a side panel (desktop) for the toast column. */
const TOAST_ROOM_BESIDE_PX = 380;

// --- One layer at a time --------------------------------------------------------
// Every open Sheet, Dialog and SidePanel registers its surface here. A toast never
// draws over one: it sits just above the surface's top edge, or beside a side panel,
// or, when the surface fills the screen, inside the surface's own flow (the surface
// renders <OverlayToasts /> at the top of its body). Actions that finish close their
// surface before toasting, so in practice the toast lands on the page.

type Placement =
  | { kind: 'page' }
  | { kind: 'above'; bottom: number }
  | { kind: 'beside'; right: number }
  | { kind: 'inside'; surface: HTMLElement };

interface ToastLayer {
  register: (surface: HTMLElement) => () => void;
  placement: Placement;
  toasts: ToastEntry[];
  dismiss: (id: number) => void;
}
const ToastLayerContext = createContext<ToastLayer | null>(null);

function placementFor(surface: HTMLElement | undefined): Placement {
  if (!surface) return { kind: 'page' };
  // offsetTop/offsetLeft rather than the bounding box: an entering sheet is still
  // translated down, and its resting position is what the toast has to clear.
  const top = surface.offsetTop;
  const left = surface.offsetLeft;
  if (top >= TOAST_ROOM_ABOVE_PX) return { kind: 'above', bottom: window.innerHeight - top + 8 };
  if (left >= TOAST_ROOM_BESIDE_PX) return { kind: 'beside', right: window.innerWidth - left + 16 };
  return { kind: 'inside', surface };
}

export function ToastProvider({ children }: { children: ReactNode }): ReactElement {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const [surfaces, setSurfaces] = useState<HTMLElement[]>([]);
  const [placement, setPlacement] = useState<Placement>({ kind: 'page' });
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

  const register = useCallback((surface: HTMLElement) => {
    setSurfaces((current) => [...current.filter((item) => item !== surface), surface]);
    return () => setSurfaces((current) => current.filter((item) => item !== surface));
  }, []);

  const top = surfaces[surfaces.length - 1];
  useLayoutEffect(() => {
    const place = (): void => setPlacement(placementFor(top));
    place();
    if (!top) return undefined;
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    observer?.observe(top);
    window.addEventListener('resize', place);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [top]);

  const layer = useMemo<ToastLayer>(
    () => ({ register, placement, toasts, dismiss }),
    [register, placement, toasts, dismiss],
  );

  return (
    <ToastContext.Provider value={show}>
      <ToastLayerContext.Provider value={layer}>
        {children}
        {placement.kind === 'inside' ? null : (
          <div
            className="toast-viewport"
            role="region"
            aria-label="Notifications"
            // Keeps toasts readable and pressable while a modal hides the rest of the
            // page from assistive tech and treats outside presses as dismissals.
            data-react-aria-top-layer="true"
            data-placement={placement.kind}
            style={
              placement.kind === 'above'
                ? { bottom: placement.bottom }
                : placement.kind === 'beside'
                  ? { right: placement.right, left: 'auto' }
                  : undefined
            }
          >
            <ToastList toasts={toasts} dismiss={dismiss} />
          </div>
        )}
      </ToastLayerContext.Provider>
    </ToastContext.Provider>
  );
}

function ToastList({
  toasts,
  dismiss,
}: {
  toasts: ToastEntry[];
  dismiss: (id: number) => void;
}): ReactElement {
  return (
    <>
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
    </>
  );
}

/** Registers an overlay surface with the toast layer while it's mounted. Returns a
 * ref callback for the surface element. */
export function useToastObstacle(): (surface: HTMLElement | null) => void {
  const layer = useContext(ToastLayerContext);
  const release = useRef<(() => void) | null>(null);
  const register = layer?.register;
  return useCallback(
    (surface: HTMLElement | null) => {
      release.current?.();
      release.current = surface && register ? register(surface) : null;
    },
    [register],
  );
}

/** Where a full-screen surface shows toasts: in its own flow, above its content,
 * so nothing is drawn over it. Renders nothing unless this surface is the one the
 * toasts have nowhere else to go around. */
export function OverlayToasts({ surface }: { surface: HTMLElement | null }): ReactElement | null {
  const layer = useContext(ToastLayerContext);
  if (!layer || layer.placement.kind !== 'inside' || layer.placement.surface !== surface)
    return null;
  if (layer.toasts.length === 0) return null;
  return (
    <div className="toast-inline" role="region" aria-label="Notifications">
      <ToastList toasts={layer.toasts} dismiss={layer.dismiss} />
    </div>
  );
}

export function useToast(): ShowToast {
  const show = useContext(ToastContext);
  if (!show) throw new Error('useToast must be used inside ToastProvider');
  return show;
}
