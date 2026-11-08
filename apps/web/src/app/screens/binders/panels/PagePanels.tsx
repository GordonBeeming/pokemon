import { useId, useState, type ReactElement } from 'react';
import { useOverlayAction } from '../../../ui/overlay';
import { SegmentedControl } from '../../../ui/SegmentedControl';
import { Stepper } from '../../../ui/Stepper';
import { Panel } from './Panel';
import type { BinderPageRemovalMode } from '@pokedex/shared';

export const MAX_BLANK_PAGES = 20;

export function RemovePagePanel({
  pageIndex,
  pageCount,
  pocketCount,
  placeholderCount,
  placedCount,
  pending,
  error,
  onRemove,
  onClose,
}: {
  pageIndex: number;
  pageCount: number;
  pocketCount: number;
  placeholderCount: number;
  placedCount: number;
  pending: boolean;
  error: string | null;
  onRemove: (mode: BinderPageRemovalMode) => Promise<boolean>;
  onClose: () => void;
}): ReactElement {
  const [mode, setMode] = useState<BinderPageRemovalMode>(
    placeholderCount > 0 ? 'clear-placeholders' : 'delete-page',
  );
  const action = useOverlayAction();
  const busy = pending || action.pending;
  const blocked = mode === 'delete-page' ? pageCount <= 1 : placeholderCount === 0;
  return (
    <Panel title={`Remove from page ${pageIndex + 1}`} onClose={onClose}>
      <form
        className="panel-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && !blocked) void action.run(() => onRemove(mode));
        }}
      >
        {error ? (
          <p role="alert" className="panel-error">
            {error}
          </p>
        ) : null}
        <SegmentedControl<BinderPageRemovalMode>
          label="What to remove"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'clear-placeholders', label: 'Clear placeholders' },
            { value: 'delete-page', label: 'Remove entire page' },
          ]}
        />
        {mode === 'delete-page' ? (
          <>
            <p className="panel-help">
              Remove page {pageIndex + 1} and its {pocketCount} pockets, including all targets and
              bookmarks on this page. Later pages move forward.
            </p>
            {placedCount > 0 ? (
              <p className="panel-help">
                {placedCount} placed {placedCount === 1 ? 'card will' : 'cards will'} become
                unplaced. Your owned quantities stay the same.
              </p>
            ) : null}
            {pageCount <= 1 ? (
              <p className="panel-error">
                A binder must keep at least one page. You can clear its placeholders instead.
              </p>
            ) : null}
          </>
        ) : (
          <>
            <p className="panel-help">
              Clear {placeholderCount} unfilled{' '}
              {placeholderCount === 1 ? 'placeholder' : 'placeholders'} on this page. Keep the page,
              its pockets and bookmarks, reserved pockets, and all placed cards in their current
              positions.
            </p>
            {placeholderCount === 0 ? (
              <p className="panel-help">There are no unfilled placeholders on this page.</p>
            ) : null}
          </>
        )}
        <div className="panel-actions">
          <button
            type="submit"
            className={mode === 'delete-page' ? 'button-danger' : 'button-primary'}
            disabled={busy || blocked}
          >
            {busy
              ? 'Removing…'
              : mode === 'delete-page'
                ? `Remove page and ${pocketCount} pockets`
                : `Clear ${placeholderCount} placeholders`}
          </button>
          <button type="button" className="button-text" disabled={busy} onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Panel>
  );
}

type Side = 'before' | 'after';

/**
 * "Add blank pages here": whole empty pages, like adding sheets to a physical binder.
 * Later pages move back with their cards, labels and bookmarks. Works on any page,
 * reserved ones included; two pages is simply a count of two.
 */
export function InsertPagesPanel({
  pageIndex,
  pending,
  error,
  onInsert,
  onClose,
}: {
  pageIndex: number;
  pending: boolean;
  error: string | null;
  /** Resolves true once the pages exist (the writer has already confirmed it). */
  onInsert: (beforePosition: number, count: number) => Promise<boolean>;
  onClose: () => void;
}): ReactElement {
  return (
    <Panel title="Add blank pages" onClose={onClose}>
      <InsertPagesForm pageIndex={pageIndex} pending={pending} error={error} onInsert={onInsert} />
    </Panel>
  );
}

function InsertPagesForm({
  pageIndex,
  pending,
  error,
  onInsert,
}: {
  pageIndex: number;
  pending: boolean;
  error: string | null;
  onInsert: (beforePosition: number, count: number) => Promise<boolean>;
}): ReactElement {
  const [side, setSide] = useState<Side>('after');
  const [count, setCount] = useState(1);
  const action = useOverlayAction();
  const busy = pending || action.pending;
  const pageNumber = pageIndex + 1;
  return (
    <form
      className="panel-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        void action.run(() => onInsert(side === 'before' ? pageIndex : pageIndex + 1, count));
      }}
    >
      {error ? (
        <p role="alert" className="panel-error">
          {error}
        </p>
      ) : null}
      <div className="panel-field">
        <span>Where</span>
        <SegmentedControl<Side>
          label="Where to add the blank pages"
          value={side}
          onChange={setSide}
          options={[
            { value: 'before', label: `Before page ${pageNumber}` },
            { value: 'after', label: `After page ${pageNumber}` },
          ]}
        />
      </div>
      <div className="panel-field">
        <span>How many</span>
        <Stepper
          label="blank pages"
          value={count}
          min={1}
          max={MAX_BLANK_PAGES}
          onChange={setCount}
        />
      </div>
      <p className="panel-help">
        Every later page moves back {count === 1 ? 'one page' : `${count} pages`}, with its cards,
        labels and bookmarks.
      </p>
      <div className="panel-actions">
        <button type="submit" className="button-primary" disabled={busy}>
          {busy ? 'Adding…' : `Add ${count === 1 ? 'a blank page' : `${count} blank pages`}`}
        </button>
      </div>
    </form>
  );
}

/** Why a page can't go to `target` (1-based), or null when it can. */
export function movePageProblem({
  pageIndex,
  pageCount,
  target,
  lastPagePartial,
}: {
  pageIndex: number;
  pageCount: number;
  target: number;
  lastPagePartial: boolean;
}): string | null {
  if (!Number.isInteger(target) || target < 1 || target > pageCount)
    return `Choose a page from 1 to ${pageCount}.`;
  if (target === pageIndex + 1) return `This is already page ${target}.`;
  // The binder's capacity ends part-way through its last page, so that short page is
  // always the physical end of the binder and nothing can be moved behind it.
  if (lastPagePartial && pageIndex === pageCount - 1)
    return 'The last page is only partly used by this binder’s capacity, so it has to stay last.';
  if (lastPagePartial && target === pageCount)
    return `The last page is only partly used by this binder’s capacity, so it has to stay last. Choose page ${pageCount - 1} or earlier.`;
  return null;
}

/** The full page order with the page at `from` (0-based) moved to `to` (0-based). */
export function movedPageOrder(pageIds: readonly string[], from: number, to: number): string[] {
  const order = [...pageIds];
  const [moving] = order.splice(from, 1);
  if (moving === undefined) return [...pageIds];
  order.splice(to, 0, moving);
  return order;
}

/** "Move this page to page N": from any page, reserved or not, in one step. */
export function MovePagePanel({
  pageIndex,
  pageCount,
  lastPagePartial,
  pending,
  error,
  onMove,
  onClose,
}: {
  pageIndex: number;
  pageCount: number;
  lastPagePartial: boolean;
  pending: boolean;
  error: string | null;
  /** `to` is 0-based. Resolves true once the page has moved. */
  onMove: (to: number) => Promise<boolean>;
  onClose: () => void;
}): ReactElement {
  return (
    <Panel title={`Move page ${pageIndex + 1}`} onClose={onClose}>
      <MovePageForm
        pageIndex={pageIndex}
        pageCount={pageCount}
        lastPagePartial={lastPagePartial}
        pending={pending}
        error={error}
        onMove={onMove}
      />
    </Panel>
  );
}

function MovePageForm({
  pageIndex,
  pageCount,
  lastPagePartial,
  pending,
  error,
  onMove,
}: {
  pageIndex: number;
  pageCount: number;
  lastPagePartial: boolean;
  pending: boolean;
  error: string | null;
  onMove: (to: number) => Promise<boolean>;
}): ReactElement {
  const inputId = useId();
  const [draft, setDraft] = useState('');
  const action = useOverlayAction();
  const busy = pending || action.pending;
  const target = Number(draft);
  const problem =
    draft === '' ? null : movePageProblem({ pageIndex, pageCount, target, lastPagePartial });
  const stuck =
    lastPagePartial && pageIndex === pageCount - 1
      ? movePageProblem({ pageIndex, pageCount, target: 1, lastPagePartial })
      : null;
  return (
    <form
      className="panel-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy || draft === '' || problem) return;
        void action.run(() => onMove(target - 1));
      }}
    >
      {error ? (
        <p role="alert" className="panel-error">
          {error}
        </p>
      ) : null}
      {stuck ? (
        <p className="panel-help">{stuck}</p>
      ) : (
        <>
          <label className="panel-field" htmlFor={inputId}>
            <span>Move to page (1 to {pageCount})</span>
            <input
              id={inputId}
              type="number"
              inputMode="numeric"
              min={1}
              max={pageCount}
              value={draft}
              placeholder={String(pageIndex + 1)}
              aria-invalid={problem !== null}
              aria-describedby={problem ? `${inputId}-problem` : undefined}
              disabled={busy}
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
          {problem ? (
            <p id={`${inputId}-problem`} role="alert" className="panel-error">
              {problem}
            </p>
          ) : (
            <p className="panel-help">
              The page takes its cards, label and bookmarks with it; the pages in between shift by
              one.
            </p>
          )}
          <div className="panel-actions">
            <button
              type="submit"
              className="button-primary"
              disabled={busy || draft === '' || problem !== null}
            >
              {busy ? 'Moving…' : 'Move page'}
            </button>
          </div>
        </>
      )}
    </form>
  );
}
