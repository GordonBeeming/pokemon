import type { FrameType } from '@pokedex/shared';
import { useEffect, useRef, type ReactElement } from 'react';
import type { ResolvedCard } from '../../../api/queries/binders';
import { CardFrame } from '../../../cards/CardFrame';
import { frameCardFrom } from '../model';

/** Confirms the picked card before Change target writes it: a new target, or (for a
 * typed sleeve in same-type mode) the copy to place. Nothing here adds to the
 * collection. The card is a neutral preview (full colour) because this is a picker. */
export function TargetConfirm({
  card,
  pending,
  palette,
  heading = 'Make this the target?',
  confirmLabel = 'Set as target',
  onConfirm,
  onBack,
}: {
  card: ResolvedCard;
  pending: boolean;
  palette: Record<FrameType, string>;
  heading?: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onBack: () => void;
}): ReactElement {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, [card.id]);

  return (
    <section className="copy-choice" aria-label={heading}>
      <h3 ref={headingRef} tabIndex={-1}>
        {heading}
      </h3>
      <div className="copy-choice-card">
        <CardFrame
          card={frameCardFrom(card)}
          state="owned"
          forceSolid
          palette={palette}
          size="7rem"
        />
        <p>
          <strong>{card.name}</strong>
          <br />
          {card.setName} · {card.number} · {card.language.toUpperCase()}
        </p>
      </div>
      <div className="panel-actions">
        <button type="button" className="button-primary" disabled={pending} onClick={onConfirm}>
          {confirmLabel}
        </button>
        <button type="button" className="button-text" disabled={pending} onClick={onBack}>
          Back to cards
        </button>
      </div>
    </section>
  );
}
