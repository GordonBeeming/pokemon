import { useId, useRef, type ReactElement, type ReactNode } from 'react';
import { Icon } from './icons';
import { useFocusTrap } from './useFocusTrap';
import './primitives.css';

/** A panel that slides in from the right — the card inspector, filters, and similar
 * secondary surfaces that stay anchored to the edge instead of centering like Dialog. */
export function SidePanel({
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

  if (!open) return null;
  return (
    <div className="side-panel-backdrop" onMouseDown={onClose}>
      <div
        ref={containerRef}
        className="side-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="side-panel-header">
          <h2 id={headingId}>{title}</h2>
          <button type="button" aria-label="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="side-panel-body">{children}</div>
      </div>
    </div>
  );
}
