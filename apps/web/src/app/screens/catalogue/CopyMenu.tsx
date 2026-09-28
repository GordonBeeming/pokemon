import type { CatalogueCardView } from '@pokedex/shared';
import { useNavigate } from '@tanstack/react-router';
import { useState, type ReactElement } from 'react';
import { CATALOGUE_BULK_CAP, collectAllMatchingCards } from '../../api/queries/catalogue';
import type { CatalogueSearch } from '../../routes/search-params';
import { Icon } from '../../ui/icons';
import { MenuButton, MenuItem } from '../../ui/MenuButton';
import { useToast } from '../../ui/Toast';
import { copyCardsToClipboard } from './card-clipboard';

export const COPY_CAP_MESSAGE = `Narrow the results to ${CATALOGUE_BULK_CAP.toLocaleString('en-AU')} cards or fewer to copy all.`;

/**
 * FEATURES.md's Clipboard & bulk actions section, behind one "Copy" trigger: copy
 * the currently displayed order, copy release-date order regardless of the visible
 * sort, or (above 50 results) copy just this page. The whole-result items are
 * disabled at 0/2,000+ results or before the first search resolves, and each
 * disabled item says why; the cap message only appears when it applies.
 */
export function CopyMenu({
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
  const toast = useToast();
  const navigate = useNavigate();
  const overCap = total > CATALOGUE_BULK_CAP;
  const bulkDisabled = busy || copying || total === 0 || overCap;

  function confirm(count: number): void {
    toast('success', `${count.toLocaleString('en-AU')} ${count === 1 ? 'card' : 'cards'} copied.`, {
      label: 'Open binders',
      onSelect: () => void navigate({ to: '/binders' }),
    });
  }

  async function copyAll(order: 'displayed' | 'release-date', close: () => void): Promise<void> {
    setCopying(true);
    const controller = new AbortController();
    try {
      const results = await collectAllMatchingCards(filters, order, controller.signal);
      copyCardsToClipboard(results);
      close();
      confirm(results.length);
    } catch (cause) {
      toast('error', cause instanceof Error ? cause.message : 'The results changed while copying.');
    } finally {
      setCopying(false);
    }
  }

  function copyPage(close: () => void): void {
    copyCardsToClipboard(cards);
    close();
    confirm(cards.length);
  }

  // Why the whole-result items can't run right now, shown as their hint instead of
  // the usual description so a disabled item is never a silent grey row.
  const bulkReason = copying
    ? 'Copying cards…'
    : busy
      ? 'Waiting for the search to finish.'
      : total === 0
        ? 'No cards match this search.'
        : null;

  return (
    <MenuButton
      className="copy-menu"
      menuLabel="Copy catalogue cards"
      label={
        <>
          <Icon name="copy" /> {copying ? 'Copying…' : 'Copy'}
        </>
      }
    >
      {(close) => (
        <>
          {overCap ? <p className="menu-note">{COPY_CAP_MESSAGE}</p> : null}
          <MenuItem
            label="Displayed order"
            hint={bulkReason ?? 'Every result, in the current arrangement.'}
            disabled={bulkDisabled}
            onSelect={() => void copyAll('displayed', close)}
          />
          <MenuItem
            label="Release-date order"
            hint={bulkReason ?? 'Every result, oldest printing first.'}
            disabled={bulkDisabled}
            onSelect={() => void copyAll('release-date', close)}
          />
          {total > 50 ? (
            <MenuItem
              label="This page"
              hint={
                busy
                  ? 'Waiting for the search to finish.'
                  : `Only the ${cards.length.toLocaleString('en-AU')} cards shown on this page.`
              }
              disabled={busy || copying || cards.length === 0}
              onSelect={() => copyPage(close)}
            />
          ) : null}
        </>
      )}
    </MenuButton>
  );
}
