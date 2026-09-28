import type { BinderBookmark } from '@pokedex/shared';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Icon } from '../../ui/icons';

export interface PageMenuActions {
  reservedPage: boolean;
  canRemove: boolean;
  onReservePage: () => void;
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
  // An unsubmitted jump value is a draft for this binder only; the screen is keyed by
  // binder, so opening another binder always starts with an empty field.
  const [draft, setDraft] = useState('');
  useEffect(() => setDraft(''), [pageIndex]);
  const value = Number(draft);
  const valid = draft !== '' && Number.isInteger(value) && value >= 1 && value <= pageCount;
  return (
    <nav className="page-stepper" aria-label="Binder pages">
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
    <label className="bookmark-jump">
      <span className="sr-only">Jump to bookmark</span>
      <select
        value=""
        disabled={pending || bookmarks.length === 0}
        onChange={(event) => {
          const bookmark = bookmarks.find((item) => item.id === event.target.value);
          if (bookmark) onJump(bookmark);
        }}
      >
        <option value="">{bookmarks.length ? 'Jump to bookmark…' : 'No bookmarks yet'}</option>
        {bookmarks.map((bookmark) => (
          <option key={bookmark.id} value={bookmark.id}>
            {bookmark.name} · page {bookmark.at.page + 1}
          </option>
        ))}
      </select>
    </label>
  );
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
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent): void => {
      if (event.target instanceof Node && !menu.current?.contains(event.target)) setOpen(false);
    };
    const close = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  const act = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  const disabled = !editable || pending;

  return (
    <div className="page-menu" ref={menu}>
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((current) => !current)}
      >
        Manage page
        <Icon name={open ? 'chevron-up' : 'chevron-down'} />
      </button>
      {open ? (
        <div className="page-menu-popover" role="menu" aria-label="Page actions">
          <button
            type="button"
            role="menuitem"
            disabled={disabled}
            onClick={act(actions.onReservePage)}
          >
            {actions.reservedPage ? 'Edit page label' : 'Reserve this page'}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={disabled || pageIndex === 0}
            onClick={act(actions.onEarlier)}
          >
            Move page earlier
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={disabled || pageIndex + 1 >= pageCount}
            onClick={act(actions.onLater)}
          >
            Move page later
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={disabled}
            onClick={act(actions.onArrange)}
          >
            Arrange targets
          </button>
          <button
            type="button"
            role="menuitem"
            className="page-menu-danger"
            disabled={disabled || !actions.canRemove || pageCount <= 1}
            onClick={act(actions.onRemovePage)}
          >
            Remove this page
          </button>
        </div>
      ) : null}
    </div>
  );
}
