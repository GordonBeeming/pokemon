import { collectionRemoveCandidateSchema } from '@pokedex/shared';
import { useState, type ReactElement } from 'react';
import type { z } from 'zod';
import { ApiError } from '../../api/client';
import { useRemoveCollectionCopy } from '../../api/queries/collection';
import { Dialog } from '../../ui/Dialog';

type Candidate = z.infer<typeof collectionRemoveCandidateSchema>;
type Source =
  | { source: 'pocket'; slotId: string }
  | { source: 'loose' }
  | { source: 'miscount'; slotId?: string };

export interface WhereFromDialogProps {
  open: boolean;
  onClose: () => void;
  cardId: string;
  cardName: string;
  /** Pockets this exact printing currently fills, from the binder-matches list. */
  placedIn: Array<{
    binderId: string;
    binderName: string;
    slotId: string;
    page: number;
    row: number;
    col: number;
  }>;
  looseCopies: number;
  onRemoved: () => void;
}

/**
 * FEATURES.md's "Lowering a card's owned quantity always asks where the copy comes
 * from": a specific pocket (unassigns it), loose (disabled at 0 loose), or
 * "I miscounted" (which the server can also turn into a slot picker via
 * `collection_remove_slot_required` when nothing is loose).
 */
export function WhereFromDialog({
  open,
  onClose,
  cardId,
  cardName,
  placedIn,
  looseCopies,
  onRemoved,
}: WhereFromDialogProps): ReactElement {
  const [selected, setSelected] = useState<Source | null>(null);
  const [miscountCandidates, setMiscountCandidates] = useState<Candidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const remove = useRemoveCollectionCopy(cardId);

  function reset(): void {
    setSelected(null);
    setMiscountCandidates(null);
    setError(null);
  }

  async function confirm(): Promise<void> {
    if (!selected) return;
    setError(null);
    try {
      await remove.mutateAsync(selected);
      reset();
      onRemoved();
    } catch (cause) {
      if (
        cause instanceof ApiError &&
        cause.code === 'collection_remove_slot_required' &&
        cause.details &&
        'candidates' in cause.details
      ) {
        setMiscountCandidates(cause.details.candidates);
        return;
      }
      setError(cause instanceof Error ? cause.message : 'That copy could not be removed.');
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Where is this copy coming from?"
    >
      <p>
        {cardName} — you have {placedIn.length + looseCopies} ({placedIn.length} in a binder ·{' '}
        {looseCopies} loose).
      </p>
      {miscountCandidates ? (
        <div role="radiogroup" aria-label="Which pocket to empty">
          <p>Every copy is placed. Choose which pocket "I miscounted" should empty.</p>
          {miscountCandidates.map((candidate) => (
            <label key={candidate.slotId} className="where-from-option">
              <input
                type="radio"
                name="miscount-slot"
                checked={selected?.source === 'miscount' && selected.slotId === candidate.slotId}
                onChange={() => setSelected({ source: 'miscount', slotId: candidate.slotId })}
              />
              <span>
                {candidate.binderName} · page {candidate.page + 1}, row {candidate.row + 1}, pocket{' '}
                {candidate.column + 1}
              </span>
            </label>
          ))}
        </div>
      ) : (
        <div role="radiogroup" aria-label="Where the copy comes from">
          {placedIn.map((pocket) => (
            <label key={pocket.slotId} className="where-from-option">
              <input
                type="radio"
                name="remove-source"
                checked={selected?.source === 'pocket' && selected.slotId === pocket.slotId}
                onChange={() => setSelected({ source: 'pocket', slotId: pocket.slotId })}
              />
              <span>
                Take it out of {pocket.binderName} — page {pocket.page + 1}, row {pocket.row + 1},
                pocket {pocket.col + 1}. The pocket goes back to waiting for a copy.
              </span>
            </label>
          ))}
          <label className="where-from-option">
            <input
              type="radio"
              name="remove-source"
              disabled={looseCopies === 0}
              checked={selected?.source === 'loose'}
              onChange={() => setSelected({ source: 'loose' })}
            />
            <span>
              From my loose cards
              {looseCopies === 0
                ? ' — every copy is in a binder, so choose the pocket it comes out of.'
                : ` — ${looseCopies} not in any binder.`}
            </span>
          </label>
          <label className="where-from-option">
            <input
              type="radio"
              name="remove-source"
              checked={selected?.source === 'miscount'}
              onChange={() => setSelected({ source: 'miscount' })}
            />
            <span>I miscounted — just correct the number.</span>
          </label>
        </div>
      )}
      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="dialog-actions">
        <button
          type="button"
          onClick={() => {
            reset();
            onClose();
          }}
          disabled={remove.isPending}
        >
          Keep it
        </button>
        <button
          type="button"
          className="dialog-action-destructive"
          onClick={() => void confirm()}
          disabled={remove.isPending || !selected}
        >
          {remove.isPending ? 'Removing…' : 'Remove 1 copy'}
        </button>
      </div>
    </Dialog>
  );
}
