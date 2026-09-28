import type { ReactElement } from 'react';
import { Icon, type IconName } from './icons';
import './primitives.css';

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: IconName;
  title: string;
  description?: string;
  action?: { label: string; onSelect: () => void };
}): ReactElement {
  return (
    <div className="empty-state">
      <Icon name={icon} className="empty-state-icon" />
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
      {action ? (
        <button type="button" onClick={action.onSelect}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}
