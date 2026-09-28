import { useState, type ReactElement } from 'react';
import type { BinderSlotView } from '../../../api/queries/binders';
import { useOverlayAction } from '../../../ui/overlay';
import { binderErrorMessage } from '../model';
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
  onSave,
  onRemove,
  onClose,
}: {
  initialName: string;
  hasBookmark: boolean;
  onSave: (name: string) => Promise<unknown>;
  onRemove: () => Promise<unknown>;
  onClose: () => void;
}): ReactElement {
  return (
    <Panel title="Bookmark this pocket" onClose={onClose}>
      <BookmarkForm
        initialName={initialName}
        hasBookmark={hasBookmark}
        onSave={onSave}
        onRemove={onRemove}
      />
    </Panel>
  );
}

function BookmarkForm({
  initialName,
  hasBookmark,
  onSave,
  onRemove,
}: {
  initialName: string;
  hasBookmark: boolean;
  onSave: (name: string) => Promise<unknown>;
  onRemove: () => Promise<unknown>;
}): ReactElement {
  const [name, setName] = useState(initialName.slice(0, 120));
  const action = useOverlayAction();
  const pending = action.pending;
  return (
    <form
      className="panel-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending && name.trim())
          void action.run(() => onSave(name.trim()), {
            success: 'Bookmark saved.',
            describeError: binderErrorMessage,
          });
      }}
    >
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
          <button
            type="button"
            className="button-text"
            disabled={pending}
            onClick={() =>
              void action.run(onRemove, {
                success: 'Bookmark removed.',
                describeError: binderErrorMessage,
              })
            }
          >
            Remove bookmark
          </button>
        ) : null}
      </div>
    </form>
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
