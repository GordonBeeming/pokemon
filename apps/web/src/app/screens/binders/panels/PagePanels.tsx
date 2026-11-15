import { useId, useState, type ReactElement } from 'react';
import { useOverlayAction } from '../../../ui/overlay';
import { SegmentedControl } from '../../../ui/SegmentedControl';
import { Stepper } from '../../../ui/Stepper';
import { Panel } from './Panel';

export const MAX_BLANK_PAGES = 20;

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

/** Moves a whole page by a chosen distance, including its cards and reservations. */
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
  const [direction, setDirection] = useState<'left' | 'right'>(pageIndex === 0 ? 'right' : 'left');
  const [draft, setDraft] = useState('1');
  const action = useOverlayAction();
  const busy = pending || action.pending;
  const distance = Number(draft);
  const lastMovableIndex = pageCount - (lastPagePartial ? 2 : 1);
  const maxDistance = direction === 'left' ? pageIndex : Math.max(0, lastMovableIndex - pageIndex);
  const target = pageIndex + (direction === 'left' ? -distance : distance);
  const problem =
    draft === ''
      ? null
      : !Number.isInteger(distance) || distance < 1
        ? 'Enter a whole number of pages, at least 1.'
        : maxDistance === 0
          ? `This page cannot move ${direction}.`
          : distance > maxDistance
            ? `You can move up to ${maxDistance} ${maxDistance === 1 ? 'page' : 'pages'} ${direction}.`
            : movePageProblem({ pageIndex, pageCount, target: target + 1, lastPagePartial });
  const stuck =
    lastPagePartial && pageIndex === pageCount - 1
      ? movePageProblem({ pageIndex, pageCount, target: 1, lastPagePartial })
      : null;
  return (
    <form
      className="panel-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy || draft === '' || problem || stuck) return;
        void action.run(() => onMove(target));
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
          <p>Are you sure you want to move page {pageIndex + 1}?</p>
          <div className="panel-field">
            <span>Direction</span>
            <SegmentedControl<'left' | 'right'>
              label="Move page direction"
              disabled={busy}
              value={direction}
              onChange={setDirection}
              options={[
                { value: 'left', label: 'Left' },
                { value: 'right', label: 'Right' },
              ]}
            />
          </div>
          <label className="panel-field" htmlFor={inputId}>
            <span>How many pages</span>
            <input
              id={inputId}
              type="number"
              inputMode="numeric"
              min={1}
              max={Math.max(1, maxDistance)}
              value={draft}
              aria-invalid={problem !== null}
              aria-describedby={problem ? `${inputId}-problem` : `${inputId}-preview`}
              disabled={busy}
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
          {problem ? (
            <p id={`${inputId}-problem`} role="alert" className="panel-error">
              {problem}
            </p>
          ) : (
            <p id={`${inputId}-preview`} className="panel-help">
              {draft !== '' ? (
                <>
                  Page {pageIndex + 1} will move {distance} {distance === 1 ? 'page' : 'pages'}{' '}
                  {direction}, becoming page {target + 1}.{' '}
                </>
              ) : null}
              Its cards, targets, labels and bookmarks move with it. The pages in between shift by
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
