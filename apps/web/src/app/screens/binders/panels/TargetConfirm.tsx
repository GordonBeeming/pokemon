import type { FrameType } from '@pokedex/shared';
import { useEffect, useRef, type ReactElement } from 'react';
import type { ResolvedCard } from '../../../api/queries/binders';
import { CardFrame } from '../../../cards/CardFrame';
import { frameCardFrom } from '../model';

/** Confirms a new target for a pocket after picking it. Change target only changes what
 * the binder wants here; placing a copy is Find cards' job, so nothing here touches the
 * collection. The card is a neutral preview (full colour) because this is a picker. */
export function TargetConfirm({
  card,
  pending,
  palette,
  onConfirm,
  onBack,
}: {
  card: ResolvedCard;
  pending: boolean;
  palette: Record<FrameType, string>;
  onConfirm: () => void;
  onBack: () => void;
}): ReactElement {
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    heading.current?.focus();
  }, [card.id]);

  return (
    <section className="copy-choice" aria-label="Confirm the new target">
      <h3 ref={heading} tabIndex={-1}>
        Make this the target?
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
          Set as target
        </button>
        <button type="button" className="button-text" disabled={pending} onClick={onBack}>
          Back to cards
        </button>
      </div>
    </section>
  );
}
