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
  toolbar,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Controls that take the header row in place of the visible title (the
   * inspector's previous/next), so they don't cost a second row above the content.
   * The title still names the dialog for assistive tech. */
  toolbar?: ReactNode;
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
          <h2 id={headingId} className={toolbar ? 'sr-only' : undefined}>
            {title}
          </h2>
          {toolbar ? <div className="side-panel-toolbar">{toolbar}</div> : null}
          <button type="button" aria-label="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="side-panel-body">{children}</div>
      </div>
    </div>
  );
}
