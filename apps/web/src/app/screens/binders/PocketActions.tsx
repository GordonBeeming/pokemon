import type { ReactElement } from 'react';
import type { BinderSlotView } from '../../api/queries/binders';
import { ActionBar, type ActionBarItem } from '../../ui/ActionBar';
import { Icon } from '../../ui/icons';
import { Sheet } from '../../ui/Sheet';
import { isTarget, pocketState } from './model';

export type PocketActionKey =
  'view' | 'find' | 'move' | 'change' | 'insert' | 'reserve' | 'paste' | 'bookmark' | 'remove';

/** Which actions a pocket offers, in the board's order. A read-only (archived) binder
 * keeps only the ones that change nothing: View card and Bookmark. */
export function pocketActionItems({
  slot,
  editable,
  hasCard,
  hasClipboard,
  on,
}: {
  slot: BinderSlotView;
  editable: boolean;
  hasCard: boolean;
  hasClipboard: boolean;
  on: Record<PocketActionKey, () => void>;
}): ActionBarItem[] {
  const state = pocketState(slot);
  const target = isTarget(slot);
  const items: ActionBarItem[] = [];
  if (hasCard) items.push({ key: 'view', label: 'View card', icon: 'eye', onSelect: on.view });
  if (editable && target)
    items.push({ key: 'find', label: 'Find cards', icon: 'magnifier', onSelect: on.find });
  if (editable && state !== 'empty')
    items.push({ key: 'move', label: 'Move', icon: 'move', shortcut: 'M', onSelect: on.move });
  if (editable && target)
    items.push({ key: 'change', label: 'Change target', icon: 'swap', onSelect: on.change });
  if (editable)
    items.push({
      key: 'insert',
      label: state === 'empty' ? 'Insert targets here' : 'Insert / shift',
      icon: 'insert',
      onSelect: on.insert,
    });
  if (editable && state === 'empty')
    items.push({ key: 'reserve', label: 'Reserve sleeve', icon: 'plus', onSelect: on.reserve });
  if (editable && hasClipboard)
    items.push({ key: 'paste', label: 'Paste here', icon: 'paste', onSelect: on.paste });
  items.push({ key: 'bookmark', label: 'Bookmark', icon: 'bookmark', onSelect: on.bookmark });
  if (editable && (target || state === 'reserved'))
    items.push({
      key: 'remove',
      label: state === 'reserved' ? 'Unreserve' : 'Remove',
      icon: 'bin',
      tone: 'danger',
      onSelect: on.remove,
    });
  return items;
}

export interface PocketSummary {
  imageUrl: string | null;
  faded: boolean;
  title: string;
  where: string;
  status: string;
}

// On phone the sheet shows this many actions before the rest fold behind "More", so
// the thumb-reachable top rows hold the everyday ones.
const PHONE_VISIBLE_ACTIONS = 6;

/** The selected pocket's actions: a floating bar under the binder on desktop, a bottom
 * sheet on phone. Same items, same order, same icons in both. */
export function PocketActions({
  summary,
  items,
  phone,
  onClose,
}: {
  summary: PocketSummary;
  items: ActionBarItem[];
  phone: boolean;
  onClose: () => void;
}): ReactElement {
  if (phone)
    return (
      <Sheet open onClose={onClose} title={summary.title}>
        <p className="pocket-sheet-where">
          {summary.where} · {summary.status}
        </p>
        <div className="pocket-sheet-actions binder-panel">
          <ActionBar items={items} maxVisible={PHONE_VISIBLE_ACTIONS} />
        </div>
      </Sheet>
    );
  return (
    <div className="pocket-actions" role="toolbar" aria-label="Pocket actions">
      {summary.imageUrl ? (
        <img
          className="pocket-actions-thumb"
          src={summary.imageUrl}
          alt=""
          style={{ opacity: summary.faded ? 0.45 : 1 }}
        />
      ) : null}
      <span className="pocket-actions-text">
        <span className="pocket-actions-title">{summary.title}</span>
        <span className="pocket-actions-where">
          {summary.where} · {summary.status}
        </span>
      </span>
      <ActionBar items={items} maxVisible={items.length} />
      <button
        type="button"
        className="pocket-actions-close"
        aria-label="Close pocket actions"
        onClick={onClose}
      >
        <Icon name="close" />
      </button>
    </div>
  );
}
