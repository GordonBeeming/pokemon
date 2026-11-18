import { useState, type ReactElement } from 'react';
import type { BinderSlotView } from '../../../api/queries/binders';
import { useRemoveCollectionCopy } from '../../../api/queries/collection';
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

export function MoveCardPanel({
  target,
  hasPlacement = true,
  pending,
  error,
  onMove,
  onClose,
}: {
  target: string;
  hasPlacement?: boolean;
  pending: boolean;
  error: string | null;
  onMove: () => Promise<boolean>;
  onClose: () => void;
}): ReactElement {
  const busy = pending;
  return (
    <Panel title="Move card" onClose={onClose}>
      <PanelError error={error} />
      <p>
        {hasPlacement
          ? 'Are you sure you want to move this card?'
          : 'This card is no longer placed in this slot.'}
      </p>
      <p className="panel-help">
        This will unplace the card without removing your owned copy. The slot will still target{' '}
        <strong>{target}</strong>.
      </p>
      <div className="panel-actions">
        <button
          type="button"
          className="button-primary"
          disabled={busy || !hasPlacement}
          onClick={() => {
            if (!busy && hasPlacement) void onMove();
          }}
        >
          {busy ? 'Moving…' : 'Move card'}
        </button>
        <button type="button" disabled={busy} onClick={onClose}>
          Cancel
        </button>
      </div>
    </Panel>
  );
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

/** Removing a placement preserves the binder plan; deleting a target is separate. */
export function RemovePanel({
  slot,
  slotId,
  target,
  canRemoveCopy,
  pending,
  error,
  onUnassign,
  onCopyRemoved,
  onLeaveGap,
  onCloseGap,
  onClose,
}: {
  slot: BinderSlotView;
  slotId: string;
  target: string;
  canRemoveCopy: boolean;
  pending: boolean;
  error: string | null;
  onUnassign: () => void;
  onCopyRemoved: () => void;
  onLeaveGap: () => void;
  onCloseGap: () => void;
  onClose: () => void;
}): ReactElement {
  const reserved = slot.entryKind === 'reserved';
  const [removeCopy, setRemoveCopy] = useState(false);
  const remove = useRemoveCollectionCopy(slot.assignedCardId ?? '');
  const busy = pending || remove.isPending;
  return (
    <Panel
      title={reserved ? 'Unreserve this sleeve' : 'Remove from binder'}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <PanelError error={error ?? (remove.isError ? binderErrorMessage(remove.error) : null)} />
      {slot.assignedCardId ? (
        <section className="panel-section">
          <h3>Remove the placed card</h3>
          <p className="panel-help">
            Keep this pocket targeting <strong>{target}</strong>.
          </p>
          <label className="panel-check">
            <input
              type="checkbox"
              checked={removeCopy}
              disabled={busy || !canRemoveCopy}
              onChange={(e) => setRemoveCopy(e.target.checked)}
            />
            Also remove one owned copy from my collection
          </label>
          {!canRemoveCopy ? (
            <p className="panel-help">
              Collection copies can only be removed from the active binder.
            </p>
          ) : null}
          <p className="panel-help">
            {removeCopy
              ? 'The placement and one owned copy will be removed together.'
              : 'Your owned copy will remain in your collection, available to place elsewhere.'}
          </p>
          <button
            type="button"
            className="button-primary"
            disabled={busy}
            onClick={() => {
              if (removeCopy) {
                if (canRemoveCopy)
                  void remove
                    .mutateAsync({ source: 'pocket', slotId })
                    .then(onCopyRemoved)
                    .catch(() => {});
              } else onUnassign();
            }}
          >
            {busy ? 'Removing…' : 'Remove card · keep target'}
          </button>
        </section>
      ) : null}
      {slot.assignedCardId ? <h3>Remove the target instead</h3> : null}
      <p className="panel-help">
        {reserved
          ? 'The sleeve becomes empty. Closing the gap moves later targets back by one.'
          : 'These options delete the pocket target. Any owned copy stays in your collection. Closing the gap moves later targets back by one.'}
      </p>
      <div className="panel-actions panel-actions-stack">
        <button type="button" disabled={busy} onClick={onLeaveGap}>
          {reserved ? 'Unreserve this sleeve' : 'Remove target and leave gap'}
        </button>
        <button type="button" className="button-danger" disabled={busy} onClick={onCloseGap}>
          {reserved ? 'Unreserve and close gap' : 'Remove target and close gap'}
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

/** Names an ordinary page so it shows in the bookmark list and heads its section, the
 * way a reserved page does, while its pockets stay in use. */
export function PageBookmarkPanel({
  initialName,
  pending,
  error,
  onSave,
  onRemove,
  onClose,
}: {
  initialName: string;
  pending: boolean;
  error: string | null;
  onSave: (name: string) => void;
  onRemove: () => void;
  onClose: () => void;
}): ReactElement {
  const [name, setName] = useState(initialName);
  const bookmarked = initialName !== '';
  return (
    <Panel title={bookmarked ? 'Edit page bookmark' : 'Bookmark this page'} onClose={onClose}>
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
        <p className="panel-help">
          The page shows this name, joins the bookmark list, and its pockets stay in use.
        </p>
        <div className="panel-actions">
          <button type="submit" className="button-primary" disabled={pending || !name.trim()}>
            {bookmarked ? 'Save bookmark' : 'Bookmark this page'}
          </button>
          {bookmarked ? (
            <button type="button" className="button-text" disabled={pending} onClick={onRemove}>
              Remove bookmark
            </button>
          ) : null}
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
