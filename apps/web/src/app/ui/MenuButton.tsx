import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import './primitives.css';

const ITEM_SELECTOR = '[role="menuitem"]:not(:disabled)';
const FOCUSABLE_SELECTOR =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex="-1"])';

/**
 * One small trigger that opens a popover of secondary actions and collapses again —
 * the progressive-disclosure pattern every control bar uses instead of laying rarely
 * used options out before anyone asks for them. `children` receives `close` so an
 * item can finish its work (an async copy, say) before the popover goes away.
 * `kind="dialog"` is for a small settings popover (form controls rather than menu
 * items): it stays open while its controls change and focuses the first of them.
 */
export function MenuButton({
  label,
  menuLabel,
  children,
  align = 'start',
  triggerLabel,
  className,
  kind = 'menu',
}: {
  /** Visible trigger content (text and/or an icon). */
  label: ReactNode;
  /** Accessible name for the popover itself. */
  menuLabel: string;
  children: (close: () => void) => ReactNode;
  /** Which trigger edge the popover prefers to line up with; it flips to the other
   * edge when the preferred one would run off-screen (a wrapped phone bar can put
   * any trigger at either side). */
  align?: 'start' | 'end';
  /** Accessible name for an icon-only trigger. */
  triggerLabel?: string;
  className?: string;
  kind?: 'menu' | 'dialog';
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState(align);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const close = useCallback(() => setOpen(false), []);

  // Re-placed whenever the surrounding bar reflows (a label changing to "Searching…",
  // fonts arriving, a resize): a wrapping bar can move the trigger to the other side
  // of the screen while the popover is open.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = (): void => {
      const anchor = root.current?.getBoundingClientRect();
      const width = popover.current?.offsetWidth ?? 0;
      if (!anchor) return;
      const gutter = 8;
      const fitsStart = anchor.left + width <= document.documentElement.clientWidth - gutter;
      const fitsEnd = anchor.right - width >= gutter;
      const preferred = align === 'start' ? fitsStart : fitsEnd;
      const other = align === 'start' ? fitsEnd : fitsStart;
      const flipped = align === 'start' ? 'end' : 'start';
      setPlacement(preferred || !other ? align : flipped);
    };
    place();
    const bar = root.current?.parentElement;
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    if (bar) observer?.observe(bar);
    window.addEventListener('resize', place);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [open, align]);

  useEffect(() => {
    if (!open) return undefined;
    const dismiss = (event: PointerEvent): void => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    popover.current
      ?.querySelector<HTMLElement>(kind === 'menu' ? ITEM_SELECTOR : FOCUSABLE_SELECTOR)
      ?.focus();
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [open, kind]);

  function moveFocus(event: KeyboardEvent<HTMLDivElement>): void {
    if (kind !== 'menu' || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
    const items = Array.from(popover.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? []);
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.findIndex((item) => item === document.activeElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    items[(current + step + items.length) % items.length]?.focus();
  }

  return (
    <div className={className ? `menu-button ${className}` : 'menu-button'} ref={root}>
      <button
        ref={trigger}
        type="button"
        className={
          triggerLabel ? 'menu-button-trigger menu-button-trigger-icon' : 'menu-button-trigger'
        }
        aria-haspopup={kind}
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={triggerLabel}
        onClick={() => setOpen((current) => !current)}
      >
        {label}
      </button>
      {open ? (
        <div
          ref={popover}
          id={menuId}
          className={`menu-popover menu-popover-${placement}`}
          role={kind}
          aria-label={menuLabel}
          onKeyDown={moveFocus}
        >
          {children(close)}
        </div>
      ) : null}
    </div>
  );
}

/** A popover row: a label plus an optional one-line hint (or the reason it's disabled). */
export function MenuItem({
  label,
  hint,
  disabled = false,
  tone,
  onSelect,
}: {
  label: string;
  hint?: string;
  disabled?: boolean;
  tone?: 'danger';
  onSelect: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      role="menuitem"
      className={tone === 'danger' ? 'menu-item menu-item-danger' : 'menu-item'}
      disabled={disabled}
      onClick={onSelect}
    >
      <span className="menu-item-label">{label}</span>
      {hint ? <span className="menu-item-hint">{hint}</span> : null}
    </button>
  );
}
