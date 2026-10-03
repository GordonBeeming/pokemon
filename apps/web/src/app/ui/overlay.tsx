import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Dialog as AriaDialog, Heading, Modal, ModalOverlay } from 'react-aria-components';
import { Icon } from './icons';
import { OverlayToasts, useToast, useToastObstacle, type ToastAction } from './Toast';
import './primitives.css';

/**
 * The one modal surface behind Dialog, Sheet and SidePanel. React Aria supplies the
 * behaviour every overlay needs and that is easy to get wrong once per component:
 * focus moves in and returns to the opener, Tab stays inside, Escape and a backdrop
 * press dismiss, the page behind can't scroll, and the rest of the page is hidden
 * from assistive tech. This file adds the app's own rules on top:
 *
 * - Done means closed: an action run through `useOverlayAction` closes the surface
 *   when it succeeds and only then confirms with a toast.
 * - Failure keeps you in place: the same action's error shows inside the surface.
 * - One layer at a time: the surface registers with the toast layer, so a toast is
 *   never drawn over it.
 * - Dismiss is always obvious: every variant has a visible close control.
 */

interface OverlaySurface {
  close: () => void;
  setError: (message: string | null) => void;
}
const OverlaySurfaceContext = createContext<OverlaySurface | null>(null);

export type OverlayVariant = 'dialog' | 'sheet' | 'side';

const DISMISS_DRAG_PX = 120;

// Safari doesn't focus a button when it's tapped, so "whatever had focus when the
// overlay opened" is often just the page. The control a press last landed on stands in
// for it, so closing still hands focus back to what opened the overlay.
let lastPressed: { control: HTMLElement; at: number } | null = null;
let tracking = false;
/** A press this recent is what opened an overlay that's opening now. */
const OPENED_BY_PRESS_MS = 1500;
function trackPresses(): void {
  if (tracking || typeof document === 'undefined') return;
  tracking = true;
  document.addEventListener(
    'pointerdown',
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const control = target?.closest<HTMLElement>(
        'button, a[href], input, select, textarea, [role="button"], [tabindex]',
      );
      if (control) lastPressed = { control, at: performance.now() };
    },
    true,
  );
}

/** Rule 5: focus goes back to what opened the overlay, without scrolling the page. */
function useReturnFocus(open: boolean): void {
  trackPresses();
  useEffect(() => {
    if (!open) return undefined;
    const active = document.activeElement;
    const pressed =
      lastPressed && performance.now() - lastPressed.at < OPENED_BY_PRESS_MS
        ? lastPressed.control
        : null;
    const opener =
      pressed ?? (active instanceof HTMLElement && active !== document.body ? active : null);
    return () => {
      // After React Aria's own restore: only step in when focus was left on the page.
      requestAnimationFrame(() => {
        const focused = document.activeElement;
        if (!opener?.isConnected || (focused && focused !== document.body)) return;
        opener.focus({ preventScroll: true });
      });
    };
  }, [open]);
}

const TYPING_FIELD =
  'textarea:not([disabled]), input:not([disabled]):not([type="checkbox"]):not([type="radio"]):not([type="hidden"]):not([type="button"]):not([type="submit"])';

/**
 * A dialog or sheet opened to type into starts with the cursor in its field, so a
 * search is one press away instead of two. A search box wins over any field above it
 * (Insert's shift count, say). Side panels are left alone: the card panel's first
 * field is its notes, which nobody opens the card to write.
 */
function useFocusFirstField(surface: HTMLElement | null): void {
  useEffect(() => {
    if (!surface) return undefined;
    // After React Aria has moved focus to the dialog itself on open.
    const frame = requestAnimationFrame(() => {
      // A field that focused itself (an autoFocus editor) keeps it.
      const active = document.activeElement;
      if (active instanceof HTMLElement && surface.contains(active) && active.matches(TYPING_FIELD))
        return;
      const body = surface.querySelector<HTMLElement>('.overlay-body');
      const field =
        body?.querySelector<HTMLElement>('input[type="search"]:not([disabled])') ??
        body?.querySelector<HTMLElement>(TYPING_FIELD);
      field?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [surface]);
}

const VARIANT_CLASS: Record<OverlayVariant, { backdrop: string; surface: string }> = {
  dialog: { backdrop: 'dialog-backdrop', surface: 'dialog' },
  sheet: { backdrop: 'sheet-backdrop', surface: 'sheet' },
  side: { backdrop: 'side-panel-backdrop', surface: 'side-panel' },
};

export interface OverlayProps {
  open: boolean;
  onClose: () => void;
  /** Names the dialog for assistive tech; shown as the heading unless `header` or
   * `toolbar` takes the header row. */
  title: string;
  variant: OverlayVariant;
  /** Dialog only: room for a result grid instead of a short form. */
  wide?: boolean;
  /** Sheet: replaces the visible title with richer content (a card summary). */
  header?: ReactNode;
  /** SidePanel: controls that take the header row in place of the visible title. */
  toolbar?: ReactNode;
  /** Extra class on the backdrop: a screen's style scope follows its overlays out of
   * the page, since they render at the end of the document. */
  className?: string;
  children: ReactNode;
}

export function Overlay({
  open,
  onClose,
  title,
  variant,
  wide = false,
  header,
  toolbar,
  className,
  children,
}: OverlayProps): ReactElement {
  const [error, setError] = useState<string | null>(null);
  const [surfaceElement, setSurfaceElement] = useState<HTMLElement | null>(null);
  const obstacle = useToastObstacle();
  const surfaceRef = useCallback(
    (element: HTMLElement | null) => {
      obstacle(element);
      setSurfaceElement(element);
    },
    [obstacle],
  );
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const surface = useMemo<OverlaySurface>(
    () => ({ close: () => onCloseRef.current(), setError }),
    [],
  );

  useEffect(() => {
    if (!open) setError(null);
  }, [open]);
  useReturnFocus(open);
  useFocusFirstField(variant === 'side' ? null : surfaceElement);

  // While a sheet is up nothing behind it may take a pull: React Aria stops the page
  // scrolling, and this stops an overscroll at either end reaching the browser's
  // pull-to-refresh.
  useEffect(() => {
    if (!open) return undefined;
    const root = document.documentElement;
    const previous = root.style.overscrollBehavior;
    root.style.overscrollBehavior = 'none';
    return () => {
      root.style.overscrollBehavior = previous;
    };
  }, [open]);

  const drag = useSheetDrag(variant === 'sheet', () => onCloseRef.current());
  const classes = VARIANT_CLASS[variant];
  const surfaceClass =
    variant === 'dialog' && wide ? `${classes.surface} dialog-wide` : classes.surface;
  const replacesTitle = header !== undefined || toolbar !== undefined;

  return (
    <ModalOverlay
      isOpen={open}
      onOpenChange={(next) => {
        if (!next) onCloseRef.current();
      }}
      isDismissable
      className={className ? `${classes.backdrop} ${className}` : classes.backdrop}
    >
      <Modal className="overlay-modal">
        <AriaDialog
          ref={surfaceRef}
          className={surfaceClass}
          style={drag.offset ? { transform: `translateY(${drag.offset}px)` } : undefined}
        >
          <div className={`${classes.surface}-header overlay-header`} {...drag.handlers}>
            {variant === 'sheet' ? <span className="sheet-handle" aria-hidden="true" /> : null}
            <div className="overlay-title-row">
              <Heading slot="title" className={replacesTitle ? 'sr-only' : 'overlay-title'}>
                {title}
              </Heading>
              {header !== undefined ? <div className="sheet-header-content">{header}</div> : null}
              {toolbar !== undefined ? <div className="side-panel-toolbar">{toolbar}</div> : null}
              <OverlayCloseButton onPress={() => onCloseRef.current()} />
            </div>
          </div>
          <div className={`${classes.surface}-body overlay-body`}>
            <OverlayToasts surface={surfaceElement} />
            {error ? (
              <p role="alert" className="overlay-error">
                {error}
              </p>
            ) : null}
            <OverlaySurfaceContext.Provider value={surface}>
              {children}
            </OverlaySurfaceContext.Provider>
          </div>
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
}

/** The one close control every overlay header carries: 44px, labelled, focus ring. */
export function OverlayCloseButton({
  onPress,
  label = 'Close',
}: {
  onPress: () => void;
  label?: string;
}): ReactElement {
  return (
    <button
      type="button"
      className="overlay-close"
      aria-label={label}
      title={label}
      onClick={onPress}
    >
      <Icon name="close" />
    </button>
  );
}

/** Only the header drags a sheet down; the body scrolls on its own. */
function useSheetDrag(
  enabled: boolean,
  onDismiss: () => void,
): {
  offset: number;
  handlers: Partial<
    Record<
      'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel',
      (event: PointerEvent<HTMLDivElement>) => void
    >
  >;
} {
  const [offset, setOffset] = useState(0);
  const start = useRef<number | null>(null);
  if (!enabled) return { offset: 0, handlers: {} };
  return {
    offset,
    handlers: {
      onPointerDown: (event) => {
        // The × is a button: capturing the pointer here would steal its click.
        if (event.target instanceof Element && event.target.closest('button')) return;
        start.current = event.clientY;
        event.currentTarget.setPointerCapture(event.pointerId);
      },
      onPointerMove: (event) => {
        if (start.current === null) return;
        setOffset(Math.max(0, event.clientY - start.current));
      },
      onPointerUp: () => {
        if (start.current === null) return;
        if (offset > DISMISS_DRAG_PX) onDismiss();
        setOffset(0);
        start.current = null;
      },
      onPointerCancel: () => {
        setOffset(0);
        start.current = null;
      },
    },
  };
}

/** The surface an action runs in, when there is one: popovers and menus provide it
 * too, so the same action code works wherever it's rendered. */
export function useOverlaySurface(): OverlaySurface | null {
  return useContext(OverlaySurfaceContext);
}

export const OverlaySurfaceProvider = OverlaySurfaceContext.Provider;

export interface OverlayActionOptions<T> {
  /** The confirmation toast, shown once the surface has closed. */
  success?: string | ((result: T) => string);
  /** A button in the confirmation toast ("Open binders"). */
  successAction?: ToastAction;
  /** Shown inside the surface when the failure carries no message of its own. */
  failure?: string;
  /** Maps a failure to the message shown inside the surface (a domain wording). */
  describeError?: (cause: unknown) => string;
  /** A step inside a multi-step flow: success confirms but leaves the surface open. */
  keepOpen?: boolean;
}

/**
 * Runs an overlay's action with the app's close/confirm/fail rules. Resolve to
 * finish (the surface closes, then the toast shows); throw to fail (the message shows
 * inside the surface, which stays open); resolve to exactly `false` when the action
 * already reported its own failure inside the surface.
 */
export function useOverlayAction(): {
  run: <T>(action: () => Promise<T>, options?: OverlayActionOptions<T>) => Promise<boolean>;
  pending: boolean;
} {
  const surface = useContext(OverlaySurfaceContext);
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(
    async <T,>(action: () => Promise<T>, options: OverlayActionOptions<T> = {}) => {
      if (mounted.current) setPending(true);
      surface?.setError(null);
      try {
        const result = await action();
        if (result === false) return false;
        if (!options.keepOpen) surface?.close();
        const message =
          typeof options.success === 'function' ? options.success(result) : options.success;
        if (message) toast('success', message, options.successAction);
        return true;
      } catch (cause) {
        const message = options.describeError
          ? options.describeError(cause)
          : cause instanceof Error && cause.message
            ? cause.message
            : (options.failure ?? 'That did not work. Try again.');
        if (!message) return false;
        // Nowhere to show it inside (the surface is gone): a toast is the fallback.
        if (surface && mounted.current) surface.setError(message);
        else toast('error', message);
        return false;
      } finally {
        if (mounted.current) setPending(false);
      }
    },
    [surface, toast],
  );

  return { run, pending };
}
