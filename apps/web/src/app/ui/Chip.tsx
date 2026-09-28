import type { ReactElement, ReactNode } from 'react';
import { Icon, type IconName } from './icons';
import './primitives.css';

export function Chip({ children }: { children: ReactNode }): ReactElement {
  return <span className="chip">{children}</span>;
}

export interface FilterChipItem {
  key: string;
  label: string;
  /** A symbol standing in for a text prefix (e.g. the illustrator filter's palette
   * icon instead of an "Artist:" label), decorative — `label` alone still carries
   * the removal announcement. */
  icon?: IconName;
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
          {item.icon ? <Icon name={item.icon} /> : null}
          {item.label}
          <Icon name="close" />
        </button>
      ))}
    </div>
  );
}
