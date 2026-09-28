import {
  useId,
  useRef,
  useState,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { useFocusTrap } from './useFocusTrap';
import './primitives.css';

const DISMISS_DRAG_PX = 120;

/** The phone equivalent of SidePanel: rises from the bottom, drag the handle down
 * past the threshold (or flick it) to dismiss, same as the platform's own sheets. */
export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}): ReactElement | null {
  const headingId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(containerRef, open, onClose);
  const [dragOffset, setDragOffset] = useState(0);
  const dragStartY = useRef<number | null>(null);

  function handlePointerDown(event: PointerEvent<HTMLDivElement>): void {
    dragStartY.current = event.clientY;
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function handlePointerMove(event: PointerEvent<HTMLDivElement>): void {
    if (dragStartY.current === null) return;
    setDragOffset(Math.max(0, event.clientY - dragStartY.current));
  }
  function handlePointerUp(): void {
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
          className="sheet-handle-row"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          <span className="sheet-handle" aria-hidden="true" />
        </div>
        <h2 id={headingId} className="sheet-title">
          {title}
        </h2>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}
