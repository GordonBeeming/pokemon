import { useState, type ReactElement } from 'react';
import { z } from 'zod';
import { apiFetch } from '../../api/client';
import { fetchBinderPage, useBinders } from '../../api/queries/binders';
import { CATALOGUE_BULK_CAP, collectAllMatchingCards } from '../../api/queries/catalogue';
import type { CatalogueSearch } from '../../routes/search-params';
import { useOverlayAction } from '../../ui/overlay';
import { SelectField } from '../../ui/SelectField';

const addCardsResponseSchema = z.object({ ok: z.literal(true), added: z.number() }).passthrough();

/** "Add these results to a binder" — every matching result in catalogue order,
 * capped at 2,000 with the same wording the copy tools use. Rendered inside the
 * Catalogue's More menu dialog, which closes itself once the cards are in. */
export function BulkAddToBinder({
  filters,
  total,
  onClose,
}: {
  filters: CatalogueSearch;
  total: number;
  onClose: () => void;
}): ReactElement {
  const [binderId, setBinderId] = useState<string | null>(null);
  const binders = useBinders();
  const action = useOverlayAction();
  const overCap = total > CATALOGUE_BULK_CAP;
  const choices = (binders.data ?? []).filter((binder) => binder.activeVersionId !== null);

  function addAll(): void {
    const target = choices.find((binder) => binder.id === binderId);
    const versionId = target?.activeVersionId;
    if (!target || !versionId) return;
    void action.run(
      async () => {
        const controller = new AbortController();
        const [cards, page] = await Promise.all([
          collectAllMatchingCards(filters, 'displayed', controller.signal),
          fetchBinderPage(versionId, 0),
        ]);
        return apiFetch(
          `/api/binders/versions/${encodeURIComponent(versionId)}/cards`,
          addCardsResponseSchema,
          {
            method: 'POST',
            body: {
              cardIds: cards.map((card) => card.id),
              expectedRevision: page.version.revision,
            },
          },
        );
      },
      {
        success: (result) =>
          `${result.added} cards were added to ${target.name} in catalogue order.`,
        failure: 'Could not add these results.',
      },
    );
  }

  return (
    <div className="catalogue-dialog-form">
      {choices.length === 0 ? (
        <p>Create a binder in Binders first.</p>
      ) : (
        <>
          <p className="catalogue-dialog-hint">
            {overCap
              ? `Narrow the results to ${CATALOGUE_BULK_CAP.toLocaleString('en-AU')} cards or fewer to add all.`
              : `Every one of the ${total.toLocaleString('en-AU')} results goes in, in catalogue order.`}
          </p>
          <SelectField
            label="Binder"
            value={binderId}
            placeholder="Choose a binder"
            options={choices.map((binder) => ({ value: binder.id, label: binder.name }))}
            onChange={setBinderId}
          />
          <div className="dialog-actions">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="dialog-action-primary"
              disabled={!binderId || action.pending || total === 0 || overCap}
              onClick={addAll}
            >
              {action.pending
                ? 'Adding in order…'
                : `Add all ${total.toLocaleString('en-AU')} results`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
