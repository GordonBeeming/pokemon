import { formatDexNumber, type FrameType, RARITY_LABELS, regionForDex } from '@pokedex/shared';
import type { ReactElement } from 'react';
import type { BinderSlotView } from '../../api/queries/binders';
import { CardFrame, type CardFrameCard, type CardFrameState } from '../../cards/CardFrame';
import { RARITY_VISUALS } from '../../cards/rarity-visuals';
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
  /** The card (or the ANY frame for an any-printing target) the phone sheet shows. */
  frame?: { card: CardFrameCard; variant: 'card' | 'any'; state: CardFrameState } | null;
  palette?: Record<FrameType, string>;
}

/** The phone sheet's header: the card itself and everything a small pocket can't
 * show (name, #dex, region, rarity, set and number), then where it sits. */
function PocketSheetHeader({ summary }: { summary: PocketSummary }): ReactElement {
  const frame = summary.frame;
  const card = frame?.card;
  const region = card?.pokedexNumber ? regionForDex(card.pokedexNumber) : null;
  const rarity = card?.rarityKey ? RARITY_VISUALS[card.rarityKey] : null;
  const rarityName = card?.rarityKey ? RARITY_LABELS[card.rarityKey] : null;
  const code = card ? [card.setCode, card.number].filter(Boolean).join(' · ') : '';
  return (
    <div className="pocket-sheet-card">
      {frame ? (
        <span className="pocket-sheet-thumb">
          <CardFrame
            card={frame.card}
            state={frame.state}
            variant={frame.variant}
            palette={summary.palette}
          />
        </span>
      ) : null}
      <div className="pocket-sheet-info">
        <strong className="pocket-sheet-name">{card?.name ?? summary.title}</strong>
        {card?.pokedexNumber ? (
          <span>
            {formatDexNumber(card.pokedexNumber)}
            {region ? ` · ${region}` : ''}
          </span>
        ) : null}
        {frame?.variant === 'any' ? (
          <span>Any printing</span>
        ) : rarityName || code ? (
          <span>
            {rarity ? (
              <span className="pocket-sheet-rarity" aria-hidden="true">
                {rarity.icon}
              </span>
            ) : null}
            {[rarityName, code].filter(Boolean).join(' · ')}
          </span>
        ) : null}
        <span className="pocket-sheet-where">
          {summary.where} · {summary.status}
        </span>
      </div>
    </div>
  );
}

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
      <Sheet
        open
        className="binder-scope"
        onClose={onClose}
        title={summary.title}
        header={<PocketSheetHeader summary={summary} />}
      >
        {/* Every action shows at once, two to a row: the sheet has the room, and a
            "More" fold would hide half the choices behind one more tap. */}
        <div className="pocket-sheet-actions binder-panel">
          <ActionBar items={items} maxVisible={items.length} />
        </div>
      </Sheet>
    );
  return (
    <div className="pocket-actions" role="toolbar" aria-label="Pocket actions">
      {summary.imageUrl ? (
        <img
          // Keyed by URL so a thumb hidden after a failed load comes back for the next card.
          key={summary.imageUrl}
          className="pocket-actions-thumb"
          src={summary.imageUrl}
          alt=""
          onError={(event) => {
            event.currentTarget.hidden = true;
          }}
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
