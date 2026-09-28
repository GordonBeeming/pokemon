import { useQueryClient } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';
import { queryKeys } from '../../../api/keys';
import { binderApi, useOwnedUnplacedPreview } from '../../../api/queries/binders';
import { useToast } from '../../../ui/Toast';
import { binderErrorMessage, isRevisionConflict } from '../model';

/**
 * "Cards you own but haven't marked as placed": older placements were saved as
 * exact-card targets with no copy assigned, so they show faded even though the card
 * is owned. Previews the count on open and marks them all in one write. Hidden when
 * there's nothing to mark.
 */
export function AssignOwnedSection({
  versionId,
  revision,
  editable,
}: {
  versionId: string;
  revision: number;
  editable: boolean;
}): ReactElement | null {
  const preview = useOwnedUnplacedPreview(versionId, revision);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const count = preview.data?.count ?? 0;
  if (!editable || preview.isLoading || (count === 0 && !error)) return null;

  async function apply(): Promise<void> {
    setApplying(true);
    setError(null);
    try {
      const result = await binderApi.assignOwned(versionId, revision);
      await queryClient.invalidateQueries({ queryKey: queryKeys.binders.version(versionId) });
      void queryClient.invalidateQueries({ queryKey: ['binders', 'cards'] });
      toast(
        'success',
        `Marked ${result.count.toLocaleString('en-AU')} ${result.count === 1 ? 'card' : 'cards'} as placed.`,
      );
    } catch (cause) {
      if (isRevisionConflict(cause)) {
        // Someone (or another tab) changed the binder since the count was taken:
        // refresh it and let the owner look again rather than marking blind.
        await queryClient.refetchQueries({ queryKey: queryKeys.binders.version(versionId) });
        setError(
          'The binder changed since this count was taken, so nothing was marked. The count is up to date now; check it and try again.',
        );
      } else {
        setError(binderErrorMessage(cause));
      }
    } finally {
      setApplying(false);
    }
  }

  return (
    <section className="panel-section" aria-labelledby="assign-owned-heading">
      <h3 id="assign-owned-heading">Cards you own but haven’t marked as placed</h3>
      {error ? (
        <p role="alert" className="panel-error">
          {error}
        </p>
      ) : null}
      {count > 0 ? (
        <>
          <p className="panel-help">
            {count.toLocaleString('en-AU')} {count === 1 ? 'pocket holds' : 'pockets hold'} a card
            you own. Mark {count === 1 ? 'it' : 'them'} as placed?
          </p>
          <div className="panel-actions">
            <button
              type="button"
              className="button-primary"
              disabled={applying}
              onClick={() => void apply()}
            >
              {applying ? 'Marking…' : `Mark ${count.toLocaleString('en-AU')} as placed`}
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}
