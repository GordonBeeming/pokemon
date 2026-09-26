import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { BinderCopyChoice } from '@pokedex/shared';
import { api, type CatalogueCardView } from './api';
import { CardArt } from './card-art';
import { userMessage } from './ui';

export function BinderCopyPrompt({
  card,
  pending,
  onChoose,
  onCancel,
}: {
  card: CatalogueCardView;
  pending: boolean;
  onChoose: (choice: BinderCopyChoice) => void;
  onCancel: () => void;
}): ReactElement {
  const [current, setCurrent] = useState<CatalogueCardView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
    const controller = new AbortController();
    setCurrent(null);
    setError(null);
    void api
      .card(card.id, controller.signal)
      .then((detail) => {
        if (!controller.signal.aborted) setCurrent(detail);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(userMessage(reason));
      });
    return () => controller.abort();
  }, [card.id, attempt]);
  const quantity = current?.collection?.quantity ?? 0;
  return (
    <section className="binder-copy-prompt" aria-label="Choose a collection copy">
      <h3 ref={heading} tabIndex={-1}>
        Which copy are you placing?
      </h3>
      <CardArt src={card.imageLowUrl} highSrc={card.imageHighUrl} alt="" />
      <p>
        <strong>{card.name}</strong> · {card.setName} · {card.number} ·{' '}
        {card.language.toUpperCase()}
      </p>
      {current ? (
        <>
          <p role="status">
            You own {quantity} {quantity === 1 ? 'copy' : 'copies'} of this card.
          </p>
          <div className="binder-header-actions">
            <button
              className="quiet-button"
              type="button"
              disabled={pending || quantity === 0}
              onClick={() => onChoose({ action: 'existing' })}
            >
              Use an existing copy
            </button>
            <button
              className="quiet-button tone-accent"
              type="button"
              disabled={pending || quantity >= 9999}
              onClick={() =>
                onChoose({
                  action: 'add',
                  expectedCollectionRevision: current.collection?.revision ?? 0,
                })
              }
            >
              Add a new copy ({quantity} → {quantity + 1})
            </button>
            <button
              className="quiet-button"
              type="button"
              disabled={pending}
              onClick={() => onChoose({ action: 'none' })}
            >
              Don’t add a copy
            </button>
          </div>
          <p className="form-help">
            Using an existing copy leaves your owned count unchanged. Adding a new copy increases it
            by one. Don’t add a copy saves only the target, without placing an owned copy.
          </p>
        </>
      ) : error ? (
        <p role="alert">{error}</p>
      ) : (
        <p role="status">Checking your collection…</p>
      )}
      <div className="binder-header-actions">
        <button
          className="text-button"
          type="button"
          disabled={pending}
          onClick={() => setAttempt((value) => value + 1)}
        >
          Refresh owned count
        </button>
        <button className="text-button" type="button" disabled={pending} onClick={onCancel}>
          Back to cards
        </button>
      </div>
    </section>
  );
}
