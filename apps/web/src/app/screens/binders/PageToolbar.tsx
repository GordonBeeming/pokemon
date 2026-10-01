import type { BinderBookmark } from '@pokedex/shared';
import { useEffect, useState, type ReactElement } from 'react';
import { Icon } from '../../ui/icons';
import { MenuButton, MenuItem } from '../../ui/MenuButton';
import { SelectField } from '../../ui/SelectField';

export interface PageMenuActions {
  reservedPage: boolean;
  /** An ordinary page that carries a bookmark name. */
  bookmarkedPage: boolean;
  canRemove: boolean;
  onReservePage: () => void;
  onBookmarkPage: () => void;
  /** Empty pockets on this page that "Reserve page for" would fill. */
  emptyPockets: number;
  onFillPage: () => void;
  onInsertPages: () => void;
  onMoveTo: () => void;
  onEarlier: () => void;
  onLater: () => void;
  onArrange: () => void;
  onRemovePage: () => void;
}

export function PageStepper({
  pageIndex,
  pageCount,
  pending,
  onGo,
}: {
  pageIndex: number;
  pageCount: number;
  pending: boolean;
  onGo: (pageIndex: number) => void;
}): ReactElement {
  return (
    <nav className="binder-pager page-stepper" aria-label="Binder pages">
      <button
        type="button"
        className="button-icon"
        aria-label="First page"
        disabled={pending || pageIndex === 0}
        onClick={() => onGo(0)}
      >
        <Icon name="chevron-left" />
        <Icon name="chevron-left" />
      </button>
      <button
        type="button"
        className="button-icon"
        aria-label="Previous page"
        disabled={pending || pageIndex === 0}
        onClick={() => onGo(pageIndex - 1)}
      >
        <Icon name="chevron-left" />
      </button>
      <PageJumpForm pageIndex={pageIndex} pageCount={pageCount} pending={pending} onGo={onGo} />
      <button
        type="button"
        className="button-icon"
        aria-label="Next page"
        disabled={pending || pageIndex + 1 >= pageCount}
        onClick={() => onGo(pageIndex + 1)}
      >
        <Icon name="chevron-right" />
      </button>
      <button
        type="button"
        className="button-icon"
        aria-label="Last page"
        disabled={pending || pageIndex + 1 >= pageCount}
        onClick={() => onGo(pageCount - 1)}
      >
        <Icon name="chevron-right" />
        <Icon name="chevron-right" />
      </button>
    </nav>
  );
}

/** "Page [n] of total  Go": the desktop stepper's middle, and the phone jump sheet. */
export function PageJumpForm({
  pageIndex,
  pageCount,
  pending,
  onGo,
}: {
  pageIndex: number;
  pageCount: number;
  pending: boolean;
  onGo: (pageIndex: number) => void;
}): ReactElement {
  // An unsubmitted jump value is a draft for this binder only; the screen is keyed by
  // binder, so opening another binder always starts with an empty field.
  const [draft, setDraft] = useState('');
  useEffect(() => setDraft(''), [pageIndex]);
  const value = Number(draft);
  const valid = draft !== '' && Number.isInteger(value) && value >= 1 && value <= pageCount;
  return (
    <form
      className="page-jump"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) onGo(value - 1);
      }}
    >
      <label>
        <span>Page</span>
        <input
          aria-label="Go to page"
          type="number"
          inputMode="numeric"
          min="1"
          max={pageCount}
          value={draft}
          placeholder={String(pageIndex + 1)}
          disabled={pending}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <span className="page-jump-total">of {pageCount}</span>
      <button type="submit" disabled={pending || !valid}>
        Go
      </button>
    </form>
  );
}

/**
 * The phone's pager under the pages: previous, "n / total" (which opens the jump
 * sheet) and next, so the full jump form doesn't crowd a narrow screen.
 */
export function PhonePageStepper({
  pageIndex,
  pageCount,
  pending,
  onGo,
  onOpenJump,
}: {
  pageIndex: number;
  pageCount: number;
  pending: boolean;
  onGo: (pageIndex: number) => void;
  onOpenJump: () => void;
}): ReactElement {
  return (
    <nav className="binder-pager phone-page-stepper" aria-label="Binder pages">
      <button
        type="button"
        className="button-icon"
        aria-label="Previous page"
        disabled={pending || pageIndex === 0}
        onClick={() => onGo(pageIndex - 1)}
      >
        <Icon name="chevron-left" />
      </button>
      <button
        type="button"
        className="phone-page-number"
        aria-label={`Page ${pageIndex + 1} of ${pageCount}. Jump to a page or bookmark`}
        onClick={onOpenJump}
      >
        {pageIndex + 1} / {pageCount}
      </button>
      <button
        type="button"
        className="button-icon"
        aria-label="Next page"
        disabled={pending || pageIndex + 1 >= pageCount}
        onClick={() => onGo(pageIndex + 1)}
      >
        <Icon name="chevron-right" />
      </button>
    </nav>
  );
}

/** Jump to a bookmark or reserved page: a pick-to-go list, so it always reads its
 * placeholder rather than the last place it went. */
export function BookmarkJump({
  bookmarks,
  pending,
  onJump,
}: {
  bookmarks: readonly BinderBookmark[];
  pending: boolean;
  onJump: (bookmark: BinderBookmark) => void;
}): ReactElement {
  return (
    <SelectField
      className="bookmark-jump"
      label="Jump to bookmark"
      hideLabel
      value={null}
      placeholder={bookmarks.length ? 'Jump to bookmark…' : 'No bookmarks yet'}
      disabled={pending || bookmarks.length === 0}
      options={bookmarks.map((bookmark) => ({
        value: bookmark.id,
        label: `${bookmark.name} · page ${bookmark.at.page + 1}`,
      }))}
      onChange={(id) => {
        const bookmark = bookmarks.find((item) => item.id === id);
        if (bookmark) onJump(bookmark);
      }}
    />
  );
}

interface PageAction {
  label: string;
  disabled: boolean;
  danger?: boolean;
  run: () => void;
}

/** The one list of page actions, shown as a popover on desktop and inline in the
 * phone tools sheet, so both always offer the same items under the same rules. */
function pageActions(
  pageIndex: number,
  pageCount: number,
  editable: boolean,
  pending: boolean,
  actions: PageMenuActions,
): PageAction[] {
  const disabled = !editable || pending;
  return [
    {
      label: actions.reservedPage ? 'Edit page label' : 'Reserve this page',
      disabled,
      run: actions.onReservePage,
    },
    // A reserved page is already named; a bookmark is the same name on a page that
    // keeps its pockets.
    ...(actions.reservedPage
      ? []
      : [
          {
            label: actions.bookmarkedPage ? 'Edit page bookmark' : 'Bookmark this page',
            disabled,
            run: actions.onBookmarkPage,
          },
        ]),
    // A wholly reserved page holds no targets, so there's nothing on it to reserve for.
    ...(actions.reservedPage
      ? []
      : [
          {
            label: 'Reserve page for…',
            disabled: disabled || actions.emptyPockets === 0,
            run: actions.onFillPage,
          },
        ]),
    { label: 'Add blank pages here…', disabled, run: actions.onInsertPages },
    {
      label: 'Move this page to…',
      disabled: disabled || pageCount <= 1,
      run: actions.onMoveTo,
    },
    { label: 'Move page earlier', disabled: disabled || pageIndex === 0, run: actions.onEarlier },
    {
      label: 'Move page later',
      disabled: disabled || pageIndex + 1 >= pageCount,
      run: actions.onLater,
    },
    { label: 'Arrange targets', disabled, run: actions.onArrange },
    {
      label: 'Remove this page',
      danger: true,
      disabled: disabled || !actions.canRemove || pageCount <= 1,
      run: actions.onRemovePage,
    },
  ];
}

export function PageMenu({
  pageIndex,
  pageCount,
  editable,
  pending,
  actions,
}: {
  pageIndex: number;
  pageCount: number;
  editable: boolean;
  pending: boolean;
  actions: PageMenuActions;
}): ReactElement {
  return (
    <MenuButton
      className="page-menu"
      menuLabel="Page actions"
      label={
        <>
          Manage page
          <Icon name="chevron-down" className="menu-button-chevron" />
        </>
      }
    >
      {(close) =>
        pageActions(pageIndex, pageCount, editable, pending, actions).map((action) => (
          <MenuItem
            key={action.label}
            label={action.label}
            tone={action.danger ? 'danger' : undefined}
            disabled={action.disabled}
            onSelect={() => {
              close();
              action.run();
            }}
          />
        ))
      }
    </MenuButton>
  );
}

/** The same page actions as a plain list, for the phone tools sheet. */
export function PageActionList({
  pageIndex,
  pageCount,
  editable,
  pending,
  actions,
  onDone,
}: {
  pageIndex: number;
  pageCount: number;
  editable: boolean;
  pending: boolean;
  actions: PageMenuActions;
  onDone: () => void;
}): ReactElement {
  return (
    <div className="page-action-list" role="group" aria-label="Page actions">
      {pageActions(pageIndex, pageCount, editable, pending, actions).map((action) => (
        <button
          key={action.label}
          type="button"
          className={action.danger ? 'button-danger' : undefined}
          disabled={action.disabled}
          onClick={() => {
            onDone();
            action.run();
          }}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}
