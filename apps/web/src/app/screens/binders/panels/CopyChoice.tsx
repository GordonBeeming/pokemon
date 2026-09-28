import type { BinderCopyChoice, FrameType } from '@pokedex/shared';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { fetchOwnedCount, type ResolvedCard } from '../../../api/queries/binders';
import { CardFrame } from '../../../cards/CardFrame';
import { binderErrorMessage, frameCardFrom } from '../model';

/** "Which copy are you placing?" — shown after picking an exact card for a pocket. The
 * card is a neutral preview (full colour) because this is a picker, not the binder. */
export function CopyChoice({
  card,
  pending,
  palette,
  onChoose,
  onBack,
}: {
  card: ResolvedCard;
  pending: boolean;
  palette: Record<FrameType, string>;
  onChoose: (choice: BinderCopyChoice) => void;
  onBack: () => void;
}): ReactElement {
  const [owned, setOwned] = useState<{ quantity: number; revision: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    heading.current?.focus();
  }, [card.id]);

  useEffect(() => {
    const controller = new AbortController();
    setOwned(null);
    setError(null);
    fetchOwnedCount(card.id, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setOwned(value);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(binderErrorMessage(cause));
      });
    return () => controller.abort();
  }, [card.id, attempt]);

  const quantity = owned?.quantity ?? 0;
  return (
    <section className="copy-choice" aria-label="Choose a collection copy">
      <h3 ref={heading} tabIndex={-1}>
        Which copy are you placing?
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
      {owned ? (
        <>
          <p role="status">
            You own {quantity} {quantity === 1 ? 'copy' : 'copies'} of this card.
          </p>
          <div className="panel-actions panel-actions-stack">
            <button
              type="button"
              disabled={pending || quantity === 0}
              onClick={() => onChoose({ action: 'existing' })}
            >
              Use an existing copy
            </button>
            <button
              type="button"
              className="button-primary"
              disabled={pending || quantity >= 9999}
              onClick={() =>
                onChoose({ action: 'add', expectedCollectionRevision: owned.revision })
              }
            >
              Add a new copy ({quantity} → {quantity + 1})
            </button>
            <button type="button" disabled={pending} onClick={() => onChoose({ action: 'none' })}>
              Don’t add a copy
            </button>
          </div>
          <p className="panel-help">
            Using an existing copy leaves your owned count unchanged. Adding a new copy increases it
            by one. Don’t add a copy saves only the target, without placing an owned copy.
          </p>
        </>
      ) : error ? (
        <p role="alert" className="panel-error">
          {error}
        </p>
      ) : (
        <p role="status">Checking your collection…</p>
      )}
      <div className="panel-actions">
        <button
          type="button"
          className="button-text"
          disabled={pending}
          onClick={() => setAttempt((value) => value + 1)}
        >
          Refresh owned count
        </button>
        <button type="button" className="button-text" disabled={pending} onClick={onBack}>
          Back to cards
        </button>
      </div>
    </section>
  );
}
