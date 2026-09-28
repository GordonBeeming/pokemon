import type { BinderSlotLocation, FrameType } from '@pokedex/shared';
import { NATIONAL_POKEDEX } from '@pokedex/shared';
import type { KeyboardEvent, PointerEvent, ReactElement } from 'react';
import type { BinderSlotView } from '../../api/queries/binders';
import { CardFrame } from '../../cards/CardFrame';
import {
  anyFrameCard,
  frameCardFrom,
  pad4,
  pocketAriaLabel,
  pocketState,
  type CardLookup,
} from './model';

export interface PocketProps {
  slot: BinderSlotView;
  at: BinderSlotLocation;
  cards: CardLookup;
  palette: Record<FrameType, string>;
  showFrame: boolean;
  peekEdge?: 'left' | 'right';
  selected: boolean;
  moveSource: boolean;
  moveCursor: boolean;
  dropHover: boolean;
  inactive: boolean;
  tabIndex: number;
  onClick: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onPointerDown?: (event: PointerEvent<HTMLButtonElement>) => void;
}

/** The art inside a pocket. A placed copy shows solid; a planned exact-card target shows
 * that card faded; an any-printing target shows the ANY frame; reserved and empty
 * sleeves show their words, never a card. */
function PocketContent({
  slot,
  cards,
  palette,
  showFrame,
  peekEdge,
}: Pick<PocketProps, 'slot' | 'cards' | 'palette' | 'showFrame' | 'peekEdge'>): ReactElement {
  const state = pocketState(slot);
  const placed = slot.assignedCardId ? cards.get(slot.assignedCardId) : undefined;
  if (placed)
    return (
      <CardFrame
        card={frameCardFrom(placed)}
        state="placed"
        frame={showFrame}
        peekEdge={peekEdge}
        palette={palette}
      />
    );
  if (slot.entryKind === 'exact-card' && slot.cardId) {
    const target = cards.get(slot.cardId);
    if (target)
      return (
        <CardFrame
          card={frameCardFrom(target)}
          state="unowned"
          frame={showFrame}
          peekEdge={peekEdge}
          palette={palette}
        />
      );
    return <span className="pocket-words">Exact card target</span>;
  }
  if (slot.entryKind === 'pokemon' && slot.pokemonNumber) {
    if (showFrame)
      return (
        <CardFrame
          card={anyFrameCard(slot.pokemonNumber)}
          state="unowned"
          variant="any"
          peekEdge={peekEdge}
          palette={palette}
        />
      );
    const name = NATIONAL_POKEDEX[slot.pokemonNumber - 1]?.name ?? 'Pokémon';
    return (
      <span className="pocket-any">
        <span className="pocket-any-number">#{pad4(slot.pokemonNumber)}</span>
        <span>{name}</span>
        <span className="pocket-any-pill">Any</span>
      </span>
    );
  }
  if (state === 'reserved')
    return (
      <span className="pocket-words pocket-words-reserved">
        <strong>Reserved</strong>
        {slot.label ? <span>{slot.label}</span> : null}
      </span>
    );
  return <span className="pocket-words pocket-words-empty">Empty</span>;
}

export function Pocket(props: PocketProps): ReactElement {
  const { slot, at, cards, selected, moveSource, moveCursor, dropHover, inactive } = props;
  const classes = [
    'pocket',
    `pocket-${pocketState(slot)}`,
    selected ? 'pocket-selected' : '',
    moveSource ? 'pocket-move-source' : '',
    moveCursor ? 'pocket-move-cursor' : '',
    dropHover ? 'pocket-drop-hover' : '',
    inactive ? 'pocket-inactive' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      type="button"
      className={classes}
      data-pocket={`${at.page}:${at.row}:${at.column}`}
      aria-pressed={selected}
      aria-label={`${pocketAriaLabel(slot, at, cards)}${inactive ? ' Needs a new target.' : ''}`}
      tabIndex={props.tabIndex}
      onClick={props.onClick}
      onKeyDown={props.onKeyDown}
      onPointerDown={props.onPointerDown}
      draggable={false}
    >
      <PocketContent
        slot={slot}
        cards={cards}
        palette={props.palette}
        showFrame={props.showFrame}
        peekEdge={props.peekEdge}
      />
      {inactive ? (
        <span className="pocket-flag" aria-hidden="true">
          Retarget
        </span>
      ) : null}
    </button>
  );
}
