import { useState, type ReactElement } from 'react';
import { Icon, type IconName } from './icons';
import './primitives.css';

export interface ActionBarItem {
  key: string;
  label: string;
  icon: IconName;
  onSelect: () => void;
  disabled?: boolean;
}

/** Icon+label actions for a selection (binder pockets, catalogue results). On phone
 * width there isn't room for every action, so anything past `maxVisible` collapses
 * behind a "More" toggle rather than wrapping into a second row mid-interaction. */
export function ActionBar({
  items,
  maxVisible = 4,
}: {
  items: ActionBarItem[];
  maxVisible?: number;
}): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const visible = items.slice(0, maxVisible);
  const overflow = items.slice(maxVisible);

  return (
    <div className="action-bar" role="group">
      {visible.map((item) => (
        <button
          key={item.key}
          type="button"
          className="action-bar-item"
          onClick={item.onSelect}
          disabled={item.disabled}
        >
          <Icon name={item.icon} />
          <span>{item.label}</span>
        </button>
      ))}
      {overflow.length > 0 ? (
        <>
          <button
            type="button"
            className="action-bar-item action-bar-more"
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            <Icon name={expanded ? 'chevron-up' : 'chevron-down'} />
            <span>More</span>
          </button>
          {expanded
            ? overflow.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className="action-bar-item action-bar-overflow-item"
                  onClick={item.onSelect}
                  disabled={item.disabled}
                >
                  <Icon name={item.icon} />
                  <span>{item.label}</span>
                </button>
              ))
            : null}
        </>
      ) : null}
    </div>
  );
}
