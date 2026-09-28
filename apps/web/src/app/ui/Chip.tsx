import type { ReactElement, ReactNode } from 'react';
import { Icon } from './icons';
import './primitives.css';

export function Chip({ children }: { children: ReactNode }): ReactElement {
  return <span className="chip">{children}</span>;
}

export interface FilterChipItem {
  key: string;
  label: string;
}

/** Removable "Filtered by" pills — one per active filter, each announcing exactly
 * what it removes rather than a generic "Remove filter". */
export function FilterChips({
  items,
  onRemove,
}: {
  items: FilterChipItem[];
  onRemove: (key: string) => void;
}): ReactElement | null {
  if (items.length === 0) return null;
  return (
    <div className="filter-chips">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          className="filter-chip"
          aria-label={`Remove filter ${item.label}`}
          onClick={() => onRemove(item.key)}
        >
          {item.label}
          <Icon name="close" />
        </button>
      ))}
    </div>
  );
}
