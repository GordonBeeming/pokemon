import type { CatalogueCardView } from '@pokedex/shared';
import { useNavigate } from '@tanstack/react-router';
import { useState, type ReactElement } from 'react';
import { CATALOGUE_BULK_CAP, collectAllMatchingCards } from '../../api/queries/catalogue';
import type { CatalogueSearch } from '../../routes/search-params';
import { Icon } from '../../ui/icons';
import { MenuButton, MenuItem } from '../../ui/MenuButton';
import { useOverlayAction } from '../../ui/overlay';
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
      {() => (
        <CopyItems
          filters={filters}
          cards={cards}
          total={total}
          busy={busy}
          copying={copying}
          onCopying={setCopying}
        />
      )}
    </MenuButton>
  );
}

function CopyItems({
  filters,
  cards,
  total,
  busy,
  copying,
  onCopying,
}: {
  filters: CatalogueSearch;
  cards: CatalogueCardView[];
  total: number;
  busy: boolean;
  copying: boolean;
  onCopying: (copying: boolean) => void;
}): ReactElement {
  const action = useOverlayAction();
  const navigate = useNavigate();
  const overCap = total > CATALOGUE_BULK_CAP;
  const bulkDisabled = busy || copying || total === 0 || overCap;
  const openBinders = { label: 'Open binders', onSelect: () => void navigate({ to: '/binders' }) };
  const copied = (count: number): string =>
    `${count.toLocaleString('en-AU')} ${count === 1 ? 'card' : 'cards'} copied.`;

  // The whole-result copies page through every match first, so the menu stays open
  // (showing "Copying…") until they're on the clipboard, then closes and confirms.
  function copyAll(order: 'displayed' | 'release-date'): void {
    onCopying(true);
    void action
      .run(
        async () => {
          const results = await collectAllMatchingCards(
            filters,
            order,
            new AbortController().signal,
          );
          copyCardsToClipboard(results);
          return results.length;
        },
        {
          success: copied,
          successAction: openBinders,
          failure: 'The results changed while copying.',
        },
      )
      .finally(() => onCopying(false));
  }

  // Why the whole-result items can't run right now, shown as their hint instead of
  // the usual description so a disabled item is never a silent grey row.
  const bulkReason = copying
    ? 'Copying cards…'
    : busy
      ? 'Waiting for the search to finish.'
      : total === 0
        ? 'No cards match this search.'
        : overCap
          ? COPY_CAP_MESSAGE
          : null;

  return (
    <>
      <MenuItem
        label="Displayed order"
        hint={bulkReason ?? 'Every result, in the current arrangement.'}
        disabled={bulkDisabled}
        closeOnSelect={false}
        onSelect={() => copyAll('displayed')}
      />
      <MenuItem
        label="Release-date order"
        hint={bulkReason ?? 'Every result, oldest printing first.'}
        disabled={bulkDisabled}
        closeOnSelect={false}
        onSelect={() => copyAll('release-date')}
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
          closeOnSelect={false}
          onSelect={() =>
            void action.run(
              () => {
                copyCardsToClipboard(cards);
                return Promise.resolve(cards.length);
              },
              { success: copied, successAction: openBinders },
            )
          }
        />
      ) : null}
    </>
  );
}
