import {
  useEffect,
  useId,
  useRef,
  useState,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Icon } from './icons';
import { useFocusTrap } from './useFocusTrap';
import './primitives.css';

const DISMISS_DRAG_PX = 120;

/**
 * The phone equivalent of SidePanel: rises from the bottom, sized to its content up
 * to 85% of the screen. Only the header (handle, title, ×) drags it down to dismiss;
 * the body scrolls on its own and never hands a pull on to the page, so pulling
 * inside a sheet can't trigger the browser's pull-to-refresh.
 */
export function Sheet({
  open,
  onClose,
  title,
  header,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Replaces the plain title row's visible text (a card summary, say); `title`
   * still names the dialog for assistive tech. */
  header?: ReactNode;
  children: ReactNode;
}): ReactElement | null {
  const headingId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(containerRef, open, onClose);
  const [dragOffset, setDragOffset] = useState(0);
  const dragStartY = useRef<number | null>(null);

  // While a sheet is up the page behind it doesn't scroll, so a swipe that runs past
  // the end of the sheet's own content has nowhere to go.
  useEffect(() => {
    if (!open) return undefined;
    const root = document.documentElement;
    const previous = { overflow: root.style.overflow, overscroll: root.style.overscrollBehavior };
    root.style.overflow = 'hidden';
    root.style.overscrollBehavior = 'none';
    return () => {
      root.style.overflow = previous.overflow;
      root.style.overscrollBehavior = previous.overscroll;
    };
  }, [open]);

  function handlePointerDown(event: PointerEvent<HTMLDivElement>): void {
    // The × is a button: capturing the pointer here would steal its click.
    if (event.target instanceof Element && event.target.closest('button')) return;
    dragStartY.current = event.clientY;
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function handlePointerMove(event: PointerEvent<HTMLDivElement>): void {
    if (dragStartY.current === null) return;
    setDragOffset(Math.max(0, event.clientY - dragStartY.current));
  }
  function handlePointerUp(): void {
    if (dragStartY.current === null) return;
    if (dragOffset > DISMISS_DRAG_PX) onClose();
    setDragOffset(0);
    dragStartY.current = null;
  }

  if (!open) return null;
  return (
    <div className="sheet-backdrop" onMouseDown={onClose}>
      <div
        ref={containerRef}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        style={{ transform: dragOffset ? `translateY(${dragOffset}px)` : undefined }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div
          className="sheet-header"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          <span className="sheet-handle" aria-hidden="true" />
          <div className="sheet-title-row">
            <h2 id={headingId} className={header ? 'sr-only' : 'sheet-title'}>
              {title}
            </h2>
            {header ? <div className="sheet-header-content">{header}</div> : null}
            <button type="button" className="sheet-close" aria-label="Close" onClick={onClose}>
              <Icon name="close" />
            </button>
          </div>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}
