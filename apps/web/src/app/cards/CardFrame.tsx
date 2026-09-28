import {
  DEFAULT_FRAME_PALETTE,
  RARITY_LABELS,
  regionForDex,
  type FrameType,
  type RarityKey,
} from '@pokedex/shared';
import { useState, type CSSProperties, type ReactElement } from 'react';
import { bestTextColor, contrastWithDark, contrastWithWhite, mix } from './color';
import { RARITY_VISUALS, rarityToneColour } from './rarity-visuals';
import './CardFrame.css';

// Cards with no computed frame type (custom/manual cards, category 'special') get a
// neutral that isn't the special-energy token, so the two "no strong colour" cases
// stay visually distinct.
const NEUTRAL_FRAME_COLOR = '#94a3b8';
// The board's own missing-art fill (independent of any frame colour) — used with
// frame=false, where there's no coloured chrome around the art to tie a tint to.
const NEUTRAL_PLACEHOLDER_BG = '#e2e8f0';

export interface CardFrameCard {
  id: string;
  name: string;
  frameType: FrameType | null;
  setCode: string | null;
  number: string | null;
  rarityKey: RarityKey | null;
  pokedexNumber: number | null;
  imageUrl: string | null;
}

export type CardFrameState = 'owned' | 'placed' | 'unowned';

export interface CardFrameProps {
  card: CardFrameCard;
  /** Owned vs not owned is the whole story a frame tells (solid vs pale dashed); the
   * copy count lives only in the card inspector. */
  state: CardFrameState;
  /** 'any' renders an ANY-printing binder target: the Pokémon, no set/number/rarity. */
  variant?: 'card' | 'any';
  /** false renders raw art only (still at the 245:337 aspect ratio) with no chrome. */
  frame?: boolean;
  size?: number | string;
  onView?: () => void;
  selected?: boolean;
  /** Only this edge stays square, for a card peeking in from off-screen in a binder row. */
  peekEdge?: 'left' | 'right';
  /** The card inspector always shows full colour, even for a card that isn't owned. */
  forceSolid?: boolean;
  /** A fully-resolved palette (DEFAULT_FRAME_PALETTE merged with the owner's overrides). */
  palette?: Record<FrameType, string>;
  className?: string;
}

export function CardFrame({
  card,
  state,
  variant = 'card',
  frame = true,
  size = '100%',
  onView,
  selected = false,
  peekEdge,
  forceSolid = false,
  palette = DEFAULT_FRAME_PALETTE,
  className = '',
}: CardFrameProps): ReactElement {
  const solid = card.frameType ? palette[card.frameType] : NEUTRAL_FRAME_COLOR;
  const light = mix(solid, '#ffffff', 0.88);
  // A pale frame colour (the special-energy neutral, or a light custom override)
  // reads better with dark text even in its "owned" solid state.
  const lightFrame = contrastWithWhite(solid) < 4.5 && contrastWithDark(solid) >= 4.5;
  const onSolid = lightFrame ? '#0f172a' : '#ffffff';
  const ink = lightFrame ? '#334155' : mix(solid, '#000000', 0.25);

  // The art URL is lazy: the server hands one out before it knows whether the
  // provider has a scan (brand-new sets often don't yet), so a failed load falls
  // back to the named placeholder instead of the browser's broken-image icon.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const imageUrl = card.imageUrl && card.imageUrl !== failedUrl ? card.imageUrl : null;

  const isSolid = forceSolid || state !== 'unowned';
  const textColor = isSolid ? onSolid : ink;
  const region = card.pokedexNumber ? regionForDex(card.pokedexNumber) : null;
  const rarity = card.rarityKey ? RARITY_VISUALS[card.rarityKey] : null;
  const rarityName = card.rarityKey ? RARITY_LABELS[card.rarityKey] : null;
  const rarityColor = rarity ? rarityToneColour(rarity.tone, isSolid, textColor) : textColor;

  const codeNum =
    variant === 'any' ? 'ANY' : [card.setCode, card.number].filter(Boolean).join(' · ');

  const ariaLabel = [
    card.name,
    variant === 'any' ? 'any printing' : codeNum || null,
    card.pokedexNumber ? `Pokédex #${String(card.pokedexNumber).padStart(4, '0')}` : null,
    rarityName,
    state === 'unowned' ? 'not owned' : 'owned',
  ]
    .filter(Boolean)
    .join(', ');

  // A missing-art placeholder is tinted by the frame colour when a frame is drawn
  // around it, but frame=false has no coloured chrome to tie a tint to — it gets the
  // same neutral fill the CardFrames board uses. Either way the text colour is
  // chosen against *this* background, not borrowed from the frame's own text colour,
  // which was computed against the (usually much more saturated) frame fill.
  const placeholderBg = frame ? light : NEUTRAL_PLACEHOLDER_BG;
  const placeholderTextColor = bestTextColor(placeholderBg);

  const art = imageUrl ? (
    <img
      className="card-frame-art"
      src={imageUrl}
      alt=""
      onError={() => setFailedUrl(imageUrl)}
      style={{ opacity: isSolid ? 1 : 0.45 }}
    />
  ) : (
    <div
      className="card-frame-art card-frame-art-placeholder"
      style={{
        background: placeholderBg,
        color: placeholderTextColor,
        opacity: isSolid ? 1 : 0.45,
      }}
    >
      <span>{card.name}</span>
    </div>
  );

  const peekClass =
    peekEdge === 'left'
      ? 'card-frame-peek-left'
      : peekEdge === 'right'
        ? 'card-frame-peek-right'
        : '';

  const content = !frame ? (
    art
  ) : (
    <>
      <span className="card-frame-row">
        <span className="card-frame-dex">
          {card.pokedexNumber ? `#${String(card.pokedexNumber).padStart(3, '0')}` : ''}
        </span>
        <span className="card-frame-region">{region ?? ''}</span>
      </span>
      {art}
      <span className="card-frame-row">
        <span className="card-frame-code">
          {variant === 'card' && rarity ? (
            <span className="card-frame-rarity" style={{ color: rarityColor }} aria-hidden="true">
              {rarity.icon}
            </span>
          ) : null}
          {variant === 'any' ? (
            <span>ANY</span>
          ) : (
            <span className="card-frame-codenum">
              <span>
                {card.setCode}
                <span className="card-frame-dot">·</span>
              </span>
              <span>{card.number}</span>
            </span>
          )}
        </span>
      </span>
    </>
  );

  const style: CSSProperties = frame
    ? {
        width: size,
        background: isSolid ? solid : light,
        borderColor: solid,
        borderStyle: isSolid ? 'solid' : 'dashed',
        color: textColor,
      }
    : { width: size };

  const classes = [
    'card-frame',
    frame ? '' : 'card-frame-raw',
    frame ? peekClass : '',
    selected ? 'card-frame-selected' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  // A card with no onView is display-only (e.g. a filled binder pocket rendered for
  // print/export); it shouldn't sit in the tab order or read as a button.
  if (!onView)
    return (
      <div className={classes} style={style} aria-label={ariaLabel} role="img">
        {content}
      </div>
    );

  return (
    <button
      type="button"
      className={classes}
      style={style}
      onClick={onView}
      aria-label={ariaLabel}
      aria-pressed={selected}
    >
      {content}
    </button>
  );
}
