import { useState, type ReactElement } from 'react';
import type { BinderSlotView, BinderCandidate } from '../../../api/queries/binders';
import { Panel } from './Panel';

function PanelError({ error }: { error: string | null }): ReactElement | null {
  return error ? (
    <p role="alert" className="panel-error">
      {error}
    </p>
  ) : null;
}

export function BookmarkPanel({
  initialName,
  hasBookmark,
  pending,
  error,
  onSave,
  onRemove,
  onClose,
}: {
  initialName: string;
  hasBookmark: boolean;
  pending: boolean;
  error: string | null;
  onSave: (name: string) => void;
  onRemove: () => void;
  onClose: () => void;
}): ReactElement {
  const [name, setName] = useState(initialName.slice(0, 120));
  return (
    <Panel title="Bookmark this pocket" onClose={onClose}>
      <form
        className="panel-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!pending && name.trim()) onSave(name.trim());
        }}
      >
        <PanelError error={error} />
        <label className="panel-field">
          <span>Bookmark name</span>
          <input
            value={name}
            maxLength={120}
            disabled={pending}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <div className="panel-actions">
          <button type="submit" className="button-primary" disabled={pending || !name.trim()}>
            Save bookmark
          </button>
          {hasBookmark ? (
            <button type="button" className="button-text" disabled={pending} onClick={onRemove}>
              Remove bookmark
            </button>
          ) : null}
        </div>
      </form>
    </Panel>
  );
}

/** A reserved sleeve is unreserved, not "removed": the wording follows what's there. */
export function RemovePanel({
  slot,
  pending,
  error,
  onLeaveGap,
  onCloseGap,
  onClose,
}: {
  slot: BinderSlotView;
  pending: boolean;
  error: string | null;
  onLeaveGap: () => void;
  onCloseGap: () => void;
  onClose: () => void;
}): ReactElement {
  const reserved = slot.entryKind === 'reserved';
  return (
    <Panel title={reserved ? 'Unreserve this sleeve' : 'Remove card'} onClose={onClose}>
      <PanelError error={error} />
      <p className="panel-help">
        {reserved
          ? 'The sleeve becomes empty. Closing the gap moves later targets back by one.'
          : 'Removing the target keeps any owned copy in your collection. Closing the gap moves later targets back by one.'}
      </p>
      <div className="panel-actions panel-actions-stack">
        <button type="button" disabled={pending} onClick={onLeaveGap}>
          {reserved ? 'Unreserve this sleeve' : 'Remove card and leave gap'}
        </button>
        <button type="button" className="button-danger" disabled={pending} onClick={onCloseGap}>
          {reserved ? 'Unreserve and close gap' : 'Remove and close gap'}
        </button>
      </div>
    </Panel>
  );
}

export function ReserveSleevePanel({
  pending,
  error,
  onReserve,
  onClose,
}: {
  pending: boolean;
  error: string | null;
  onReserve: (label: string | null) => void;
  onClose: () => void;
}): ReactElement {
  const [label, setLabel] = useState('');
  return (
    <Panel title="Reserve sleeve" onClose={onClose}>
      <form
        className="panel-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!pending) onReserve(label.trim() || null);
        }}
      >
        <PanelError error={error} />
        <label className="panel-field">
          <span>Reservation label (optional)</span>
          <input
            value={label}
            maxLength={120}
            disabled={pending}
            onChange={(event) => setLabel(event.target.value)}
          />
        </label>
        <div className="panel-actions">
          <button type="submit" className="button-primary" disabled={pending}>
            Reserve this sleeve
          </button>
        </div>
      </form>
    </Panel>
  );
}

export function PageReservePanel({
  reserved,
  initialLabel,
  pending,
  error,
  onSave,
  onUnreserve,
  onClose,
}: {
  reserved: boolean;
  initialLabel: string;
  pending: boolean;
  error: string | null;
  onSave: (label: string | null) => void;
  onUnreserve: () => void;
  onClose: () => void;
}): ReactElement {
  const [label, setLabel] = useState(initialLabel);
  return (
    <Panel title={reserved ? 'Edit page label' : 'Reserve this page'} onClose={onClose}>
      <form
        className="panel-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!pending) onSave(label.trim() || null);
        }}
      >
        <PanelError error={error} />
        <label className="panel-field">
          <span>Page reservation label (optional)</span>
          <input
            value={label}
            maxLength={120}
            disabled={pending}
            onChange={(event) => setLabel(event.target.value)}
          />
        </label>
        <p className="panel-help">
          Reserved pages appear automatically in the bookmark list. Automatic arrangement, inserts
          and shifts leave their pockets alone.
        </p>
        <div className="panel-actions">
          <button type="submit" className="button-primary" disabled={pending}>
            {reserved ? 'Save page label' : 'Reserve this page'}
          </button>
          {reserved ? (
            <button type="button" className="button-text" disabled={pending} onClick={onUnreserve}>
              Unreserve this page
            </button>
          ) : null}
        </div>
      </form>
    </Panel>
  );
}

/** Find cards for a pocket: the owned copies that fit (assign one), take the placed copy
 * out, the page-break toggle, and a jump to the catalogue for anything not owned yet. */
export function FindCardsPanel({
  slot,
  title,
  reservedPage,
  editable,
  candidates,
  candidatesLoading,
  candidatesError,
  pending,
  error,
  onAssign,
  onUnassign,
  onPageBreak,
  onSearchCatalogue,
  onClose,
}: {
  slot: BinderSlotView;
  title: string;
  reservedPage: boolean;
  editable: boolean;
  candidates: BinderCandidate[] | undefined;
  candidatesLoading: boolean;
  candidatesError: string | null;
  pending: boolean;
  error: string | null;
  onAssign: (candidate: BinderCandidate) => void;
  onUnassign: () => void;
  onPageBreak: (startsNewPage: boolean) => void;
  onSearchCatalogue: () => void;
  onClose: () => void;
}): ReactElement {
  return (
    <Panel title={`Find cards · ${title}`} onClose={onClose}>
      <PanelError error={error} />
      <section className="panel-section" aria-labelledby="owned-copies-heading">
        <h3 id="owned-copies-heading">Owned copies that fit</h3>
        <p className="panel-help">
          {slot.assignedCardId
            ? 'This target has an owned copy placed in it.'
            : 'This target is planned but has no physical copy placed.'}
        </p>
        {candidatesLoading ? (
          <p role="status">Loading compatible unassigned copies…</p>
        ) : candidatesError ? (
          <p role="alert" className="panel-error">
            {candidatesError}
          </p>
        ) : candidates && candidates.length > 0 ? (
          <ul className="candidate-list">
            {candidates.map((candidate) => (
              <li key={candidate.cardId}>
                <button
                  type="button"
                  disabled={!editable || pending || candidate.available === 0}
                  onClick={() => onAssign(candidate)}
                >
                  <strong>Place {candidate.name}</strong>
                  <span>
                    {candidate.setCode ?? candidate.setName} · {candidate.number} ·{' '}
                    {candidate.available} compatible {candidate.available === 1 ? 'copy' : 'copies'}{' '}
                    remaining
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : candidates ? (
          <p>You have no spare copy of this yet.</p>
        ) : null}
        <div className="panel-actions">
          <button
            type="button"
            disabled={!editable || pending || !slot.assignedCardId}
            onClick={onUnassign}
          >
            Remove physical placement
          </button>
          <button type="button" className="button-primary" onClick={onSearchCatalogue}>
            Search the catalogue for this pocket
          </button>
        </div>
      </section>
      {!reservedPage ? (
        <label className="panel-check">
          <input
            type="checkbox"
            checked={slot.startsNewPage === true}
            disabled={!editable || pending}
            onChange={(event) => onPageBreak(event.target.checked)}
          />
          Start this target on a new page
        </label>
      ) : null}
    </Panel>
  );
}
