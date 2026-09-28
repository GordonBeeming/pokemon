import { useState, type ReactElement } from 'react';
import { z } from 'zod';
import { apiFetch } from '../../api/client';
import { fetchBinderPage, useBinders } from '../../api/queries/binders';
import { CATALOGUE_BULK_CAP, collectAllMatchingCards } from '../../api/queries/catalogue';
import type { CatalogueSearch } from '../../routes/search-params';
import { useToast } from '../../ui/Toast';

const addCardsResponseSchema = z.object({ ok: z.literal(true), added: z.number() }).passthrough();

/** "Add these results to a binder" — every matching result in catalogue order,
 * capped at 2,000 with the same wording the copy tools use. */
export function BulkAddToBinder({
  filters,
  total,
}: {
  filters: CatalogueSearch;
  total: number;
}): ReactElement {
  const [binderId, setBinderId] = useState('');
  const [adding, setAdding] = useState(false);
  const binders = useBinders();
  const toast = useToast();
  const overCap = total > CATALOGUE_BULK_CAP;

  async function addAll(): Promise<void> {
    const target = binders.data?.find((binder) => binder.id === binderId);
    const versionId = target?.activeVersionId;
    if (!versionId) return;
    setAdding(true);
    try {
      const controller = new AbortController();
      const [cards, page] = await Promise.all([
        collectAllMatchingCards(filters, 'displayed', controller.signal),
        fetchBinderPage(versionId, 0),
      ]);
      const result = await apiFetch(
        `/api/binders/versions/${encodeURIComponent(versionId)}/cards`,
        addCardsResponseSchema,
        {
          method: 'POST',
          body: { cardIds: cards.map((card) => card.id), expectedRevision: page.version.revision },
        },
      );
      toast(
        'success',
        `${result.added} cards were added to ${target?.name ?? 'the binder'} in catalogue order.`,
      );
    } catch (cause) {
      toast('error', cause instanceof Error ? cause.message : 'Could not add these results.');
    } finally {
      setAdding(false);
    }
  }

  return (
    <details className="custom-card-tools">
      <summary>Add these results to a binder</summary>
      {(binders.data ?? []).length === 0 ? (
        <p>Create a binder in Binders first.</p>
      ) : (
        <div>
          <select value={binderId} onChange={(event) => setBinderId(event.target.value)}>
            <option value="">Choose a binder</option>
            {(binders.data ?? []).map((binder) => (
              <option key={binder.id} value={binder.id}>
                {binder.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!binderId || adding || total === 0 || overCap}
            onClick={() => void addAll()}
          >
            {adding
              ? 'Adding in order…'
              : overCap
                ? `Narrow the results to ${CATALOGUE_BULK_CAP.toLocaleString('en-AU')} cards or fewer to add all.`
                : `Add all ${total.toLocaleString('en-AU')} results`}
          </button>
        </div>
      )}
    </details>
  );
}
