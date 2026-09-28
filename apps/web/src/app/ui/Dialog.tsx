import { useId, useRef, type ReactElement, type ReactNode } from 'react';
import { useFocusTrap } from './useFocusTrap';
import './primitives.css';

export function Dialog({
  open,
  onClose,
  title,
  children,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Room for a result grid (binder insert/paste pickers) instead of a short form. */
  wide?: boolean;
}): ReactElement | null {
  const headingId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(containerRef, open, onClose);

  if (!open) return null;
  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <div
        ref={containerRef}
        className={wide ? 'dialog dialog-wide' : 'dialog'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id={headingId} className="dialog-title">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}
