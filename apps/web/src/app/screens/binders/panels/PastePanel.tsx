import type { BinderPastePreview, BinderPasteRequest, BinderSlotLocation } from '@pokedex/shared';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { binderApi } from '../../../api/queries/binders';
import type { CardClipboard } from '../../catalogue/card-clipboard';
import { binderErrorMessage } from '../model';
import { Panel } from './Panel';

const LISTED_CARDS = 8;

export function PastePanel({
  versionId,
  revision,
  at,
  clipboard,
  onPaste,
  onClose,
}: {
  versionId: string;
  revision: number;
  at: BinderSlotLocation;
  clipboard: CardClipboard;
  /** Resolves true once the paste has been saved. */
  onPaste: (request: BinderPasteRequest) => Promise<boolean>;
  onClose: () => void;
}): ReactElement {
  const [mode, setMode] = useState<'insert' | 'replace'>('replace');
  const [preview, setPreview] = useState<BinderPastePreview | null>(null);
  const [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const savingRef = useRef(false);
  const count = clipboard.cards.length;
  const noun = count === 1 ? 'card' : 'cards';

  useEffect(() => {
    const controller = new AbortController();
    setPreview(null);
    setError('');
    setConfirmed(false);
    binderApi
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
        if (!controller.signal.aborted) setError(binderErrorMessage(cause));
      });
    return () => controller.abort();
  }, [versionId, revision, at.page, at.row, at.column, mode, clipboard, attempt]);

  async function paste(): Promise<void> {
    if (!preview || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError('');
    try {
      const saved = await onPaste({
        at,
        cardIds: clipboard.cards.map((card) => card.id),
        mode,
        expectedRevision: preview.revision,
        confirmReplace: confirmed,
      });
      if (saved) onClose();
      else {
        setError('The paste was not saved. Check the latest binder before trying again.');
        setPreview(null);
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  const needsConfirm = mode === 'replace' && preview !== null && preview.replacedTargets > 0;
  return (
    <Panel
      title={`Paste ${count} ${noun}`}
      wide
      onClose={() => {
        // A paste that's already saving can't be abandoned half-way from the UI.
        if (!savingRef.current) onClose();
      }}
    >
      <p className="panel-lead">
        Starting at page {at.page + 1}, pocket {at.row + 1}:{at.column + 1}. Cards are pasted in the
        copied order as unplaced targets. Your owned quantities stay unchanged.
      </p>
      <fieldset className="panel-radios" disabled={saving}>
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
      {error ? (
        <div className="panel-actions">
          <p role="alert" className="panel-error">
            {error}
          </p>
          <button type="button" disabled={saving} onClick={() => setAttempt((value) => value + 1)}>
            Refresh preview
          </button>
        </div>
      ) : null}
      {!preview && !error && !saving ? (
        <p role="status">Checking space and affected targets…</p>
      ) : null}
      {preview ? (
        <section aria-label="Paste preview" className="panel-section">
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
              {needsConfirm ? (
                <label className="panel-check">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={saving}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />
                  Confirm replacing these {preview.replacedTargets} targets and releasing their slot
                  assignments
                </label>
              ) : null}
            </>
          )}
        </section>
      ) : null}
      <ol className="paste-list">
        {clipboard.cards.slice(0, LISTED_CARDS).map((card, index) => (
          <li key={`${index}:${card.id}`}>
            {card.name} · {card.setName} · {card.number}
          </li>
        ))}
      </ol>
      {count > LISTED_CARDS ? <p>And {count - LISTED_CARDS} more copied cards.</p> : null}
      <footer className="panel-footer">
        {saving ? (
          <p role="status">
            Saving {count} {noun} to the binder…
          </p>
        ) : null}
        <button
          type="button"
          className="button-primary"
          disabled={!preview || saving || (needsConfirm && !confirmed)}
          onClick={() => void paste()}
        >
          {saving ? 'Pasting…' : `Paste ${count} ${noun}`}
        </button>
      </footer>
    </Panel>
  );
}
