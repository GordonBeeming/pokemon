import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { BinderPastePreview, BinderPasteRequest, BinderSlotLocation } from '@pokedex/shared';
import { api } from './api';
import { type CardClipboard } from './card-clipboard';
import { PocketPanel } from './binder-pocket-tools';
import { userMessage } from './ui';

export function BinderPasteDialog({
  versionId,
  revision,
  at,
  clipboard,
  onClose,
  onPaste,
}: {
  versionId: string;
  revision: number;
  at: BinderSlotLocation;
  clipboard: CardClipboard;
  onClose: () => void;
  onPaste: (request: BinderPasteRequest) => Promise<boolean>;
}): ReactElement {
  const [mode, setMode] = useState<'insert' | 'replace'>('replace');
  const [preview, setPreview] = useState<BinderPastePreview | null>(null);
  const [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const saving = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    setPreview(null);
    setError('');
    setConfirmed(false);
    void api
      .previewPaste(
        versionId,
        {
          at,
          cardIds: clipboard.cards.map((card) => card.id),
          mode,
          expectedRevision: revision,
          confirmReplace: false,
        },
        controller.signal,
      )
      .then((result) => {
        if (!controller.signal.aborted) setPreview(result);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(userMessage(cause));
      });
    return () => controller.abort();
  }, [versionId, revision, at.page, at.row, at.column, mode, clipboard, attempt]);
  async function paste(): Promise<void> {
    if (!preview || saving.current) return;
    saving.current = true;
    setPending(true);
    setError('');
    try {
      if (
        await onPaste({
          at,
          cardIds: clipboard.cards.map((card) => card.id),
          mode,
          expectedRevision: preview.revision,
          confirmReplace: confirmed,
        })
      )
        onClose();
      else {
        setError('Could not confirm the paste. Check the latest binder before trying again.');
        setPreview(null);
      }
    } catch (cause) {
      setError(userMessage(cause));
      setPreview(null);
    } finally {
      saving.current = false;
      setPending(false);
    }
  }
  return (
    <PocketPanel
      anchor={at}
      title={`Paste ${clipboard.cards.length} ${clipboard.cards.length === 1 ? 'card' : 'cards'}`}
      wide
      closeDisabled={pending}
      onClose={() => {
        if (!saving.current) onClose();
      }}
      footer={
        <>
          {pending ? (
            <p className="paste-progress" role="status">
              <span className="paste-spinner" aria-hidden="true" />
              Saving {clipboard.cards.length} {clipboard.cards.length === 1 ? 'card' : 'cards'} to
              the binder…
            </p>
          ) : null}
          <button
            className="quiet-button tone-accent"
            type="button"
            disabled={
              !preview ||
              pending ||
              (mode === 'replace' && preview.replacedTargets > 0 && !confirmed)
            }
            onClick={() => void paste()}
          >
            {pending
              ? 'Pasting…'
              : `Paste ${clipboard.cards.length} ${clipboard.cards.length === 1 ? 'card' : 'cards'}`}
          </button>
        </>
      }
    >
      <p>
        Starting at page {at.page + 1}, pocket {at.row + 1}:{at.column + 1}. Cards are pasted in the
        copied order as unplaced targets. Your owned quantities stay unchanged.
      </p>
      <fieldset className="paste-mode-options" disabled={pending}>
        <legend>Paste method</legend>
        <label>
          <input
            type="radio"
            name="paste-mode"
            value="replace"
            checked={mode === 'replace'}
            onChange={() => setMode('replace')}
          />
          Use existing pockets without shifting
        </label>
        <label>
          <input
            type="radio"
            name="paste-mode"
            value="insert"
            checked={mode === 'insert'}
            onChange={() => setMode('insert')}
          />
          Insert and shift later targets
        </label>
      </fieldset>
      <p className="paste-method-help">
        Choosing a method only updates the preview. Use “Paste {clipboard.cards.length}{' '}
        {clipboard.cards.length === 1 ? 'card' : 'cards'}” below to apply it.
      </p>
      {error ? (
        <>
          <p role="alert">{error}</p>
          <button
            type="button"
            className="quiet-button"
            disabled={pending}
            onClick={() => setAttempt((value) => value + 1)}
          >
            Refresh preview
          </button>
        </>
      ) : null}
      {!preview && !error && !pending ? (
        <p className="paste-progress" role="status">
          <span className="paste-spinner" aria-hidden="true" />
          Checking space and affected targets…
        </p>
      ) : null}
      {preview ? (
        <section aria-label="Paste preview">
          <p>
            Through page {preview.end.page + 1}, pocket {preview.end.row + 1}:
            {preview.end.column + 1}.
            {preview.reservedPage ? ' This paste stays on the reserved page.' : ''}
          </p>
          {mode === 'insert' ? (
            <p>
              {preview.shiftedTargets} existing targets will shift along. Their physical-copy
              assignments move with them.
            </p>
          ) : (
            <>
              <p>
                {preview.replacedTargets} occupied targets will be replaced;{' '}
                {preview.unassignedCopies} physical copies will become unassigned. Other pockets
                stay unchanged.
              </p>
              {preview.replacedTargets > 0 ? (
                <label>
                  <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={pending}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />{' '}
                  Confirm replacing these targets and releasing their slot assignments
                </label>
              ) : null}
            </>
          )}
        </section>
      ) : null}
      <ol>
        {clipboard.cards.slice(0, 8).map((card, index) => (
          <li key={`${index}:${card.id}`}>
            {card.name} · {card.setName} · {card.number}
          </li>
        ))}
      </ol>
      {clipboard.cards.length > 8 ? (
        <p>And {clipboard.cards.length - 8} more copied cards.</p>
      ) : null}
    </PocketPanel>
  );
}
