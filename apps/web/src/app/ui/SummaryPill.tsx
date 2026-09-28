import type { ReactElement } from 'react';
import { Icon } from './icons';
import './primitives.css';

/**
 * The phone stand-in for a screen's control bar: one pill that reads back the
 * current search and filters, so the screen opens on its content and the controls
 * only take room once the pill is tapped.
 */
export function SummaryPill({
  summary,
  count,
  expanded,
  controlsId,
  onToggle,
  className,
}: {
  summary: string;
  count: number;
  expanded: boolean;
  controlsId: string;
  onToggle: () => void;
  className?: string;
}): ReactElement {
  return (
    <button
      type="button"
      className={className ? `summary-pill ${className}` : 'summary-pill'}
      aria-expanded={expanded}
      aria-controls={controlsId}
      onClick={onToggle}
    >
      <Icon name="magnifier" />
      <span className="summary-pill-text">{summary}</span>
      <span className="summary-pill-count">{count.toLocaleString('en-AU')}</span>
    </button>
  );
}

/** Closes the expanded phone controls and returns to the results they produced. */
export function SummaryDoneButton({
  count,
  onDone,
  className,
}: {
  count: number;
  onDone: () => void;
  className?: string;
}): ReactElement {
  return (
    <button
      type="button"
      className={className ? `summary-done ${className}` : 'summary-done'}
      onClick={onDone}
    >
      Show {count.toLocaleString('en-AU')}
    </button>
  );
}
