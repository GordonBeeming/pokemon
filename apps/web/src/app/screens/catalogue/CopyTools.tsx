import type { CatalogueCardView } from '@pokedex/shared';
import { Link } from '@tanstack/react-router';
import { useState, type ReactElement } from 'react';
import { CATALOGUE_BULK_CAP, collectAllMatchingCards } from '../../api/queries/catalogue';
import type { CatalogueSearch } from '../../routes/search-params';
import { copyCardsToClipboard, useCardClipboard } from './card-clipboard';

/**
 * FEATURES.md's Clipboard & bulk actions section: copy the currently displayed
 * order, copy release-date order regardless of the visible sort, or (above 50
 * results) copy just this page. Disabled at 0/2,000+ results or before the first
 * search resolves, all sharing one cap message.
 */
export function CopyTools({
  filters,
  cards,
  total,
  busy,
}: {
  filters: CatalogueSearch;
  cards: CatalogueCardView[];
  total: number;
  busy: boolean;
}): ReactElement {
  const [copying, setCopying] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const clipboard = useCardClipboard();
  const overCap = total > CATALOGUE_BULK_CAP;
  const bulkDisabled = busy || copying || total === 0 || overCap;

  async function copyAll(order: 'displayed' | 'release-date'): Promise<void> {
    setCopying(true);
    setCopyError(null);
    const controller = new AbortController();
    try {
      const results = await collectAllMatchingCards(filters, order, controller.signal);
      copyCardsToClipboard(results);
    } catch (cause) {
      setCopyError(cause instanceof Error ? cause.message : 'The results changed while copying.');
    } finally {
      setCopying(false);
    }
  }

  function copyPage(): void {
    copyCardsToClipboard(cards);
  }

  return (
    <section className="copy-tools" aria-label="Copy catalogue cards">
      <div className="copy-tools-actions">
        <button type="button" disabled={bulkDisabled} onClick={() => void copyAll('displayed')}>
          Copy displayed order
        </button>
        <button type="button" disabled={bulkDisabled} onClick={() => void copyAll('release-date')}>
          Copy release-date order
        </button>
        {total > 50 ? (
          <button type="button" disabled={busy || copying || cards.length === 0} onClick={copyPage}>
            Copy this page
          </button>
        ) : null}
      </div>
      <p>
        {copying
          ? 'Copying cards…'
          : overCap
            ? `Narrow the results to ${CATALOGUE_BULK_CAP.toLocaleString('en-AU')} cards or fewer to copy all.`
            : 'Displayed order keeps the current arrangement. Release-date order is oldest first.'}
      </p>
      {copyError ? (
        <p className="notice error" role="alert">
          {copyError}
        </p>
      ) : null}
      {clipboard ? (
        <p className="copy-tools-confirmation">
          {clipboard.cards.length} {clipboard.cards.length === 1 ? 'card' : 'cards'} copied.{' '}
          <Link to="/binders">Open binders</Link>
        </p>
      ) : null}
    </section>
  );
}
