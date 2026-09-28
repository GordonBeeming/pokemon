import { useState, type ReactElement } from 'react';
import { Icon, type IconName } from './icons';
import './primitives.css';

export interface ActionBarItem {
  key: string;
  label: string;
  icon: IconName;
  onSelect: () => void;
  disabled?: boolean;
  /** Visible keyboard hint shown after the label, e.g. "M" for Move. */
  shortcut?: string;
  tone?: 'danger';
}

function ItemContent({ item }: { item: ActionBarItem }): ReactElement {
  return (
    <>
      <Icon name={item.icon} />
      <span>{item.label}</span>
      {item.shortcut ? <kbd className="action-bar-kbd">{item.shortcut}</kbd> : null}
    </>
  );
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
          className={
            item.tone === 'danger' ? 'action-bar-item action-bar-danger' : 'action-bar-item'
          }
          onClick={item.onSelect}
          disabled={item.disabled}
          aria-keyshortcuts={item.shortcut}
        >
          <ItemContent item={item} />
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
                  className={
                    item.tone === 'danger'
                      ? 'action-bar-item action-bar-overflow-item action-bar-danger'
                      : 'action-bar-item action-bar-overflow-item'
                  }
                  onClick={item.onSelect}
                  disabled={item.disabled}
                  aria-keyshortcuts={item.shortcut}
                >
                  <ItemContent item={item} />
                </button>
              ))
            : null}
        </>
      ) : null}
    </div>
  );
}
