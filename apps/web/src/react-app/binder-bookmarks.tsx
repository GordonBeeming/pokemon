import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { BinderBookmark } from '@pokedex/shared';

export function BookmarkJump({
  bookmarks,
  pending,
  onJump,
}: {
  bookmarks: readonly BinderBookmark[];
  pending: boolean;
  onJump: (id: string) => void;
}): ReactElement {
  return (
    <label className="binder-bookmark-jump">
      <span className="sr-only">Jump to bookmark</span>
      <select
        value=""
        disabled={pending || bookmarks.length === 0}
        onChange={(event) => {
          if (event.target.value) onJump(event.target.value);
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

export function BookmarkEditor({
  initialName,
  pending,
  onSave,
  onRemove,
  onClose,
}: {
  initialName: string;
  pending: boolean;
  onSave: (name: string) => Promise<boolean>;
  onRemove?: () => Promise<boolean>;
  onClose: () => void;
}): ReactElement {
  const [name, setName] = useState(initialName.slice(0, 120));
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (pending || !name.trim()) return;
        void onSave(name.trim()).then((saved) => {
          if (saved) onClose();
        });
      }}
    >
      <h3>Bookmark this pocket</h3>
      <label>
        Bookmark name
        <input
          ref={input}
          value={name}
          maxLength={120}
          disabled={pending}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <div className="binder-header-actions">
        <button
          className="quiet-button tone-accent"
          type="submit"
          disabled={pending || !name.trim()}
        >
          Save bookmark
        </button>
        {onRemove ? (
          <button
            className="text-button"
            type="button"
            disabled={pending}
            onClick={() =>
              void onRemove().then((removed) => {
                if (removed) onClose();
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

export function PageReservationEditor({
  reserved,
  initialLabel,
  pending,
  onSave,
  onUnreserve,
  onClose,
}: {
  reserved: boolean;
  initialLabel: string;
  pending: boolean;
  onSave: (label: string | null) => Promise<boolean>;
  onUnreserve: () => Promise<boolean>;
  onClose: () => void;
}): ReactElement {
  const [label, setLabel] = useState(initialLabel);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending)
          void onSave(label.trim() || null).then((saved) => {
            if (saved) onClose();
          });
      }}
    >
      <label>
        Page reservation label (optional)
        <input
          value={label}
          maxLength={120}
          disabled={pending}
          onChange={(event) => setLabel(event.target.value)}
        />
      </label>
      <p className="form-help">Reserved pages appear automatically in the bookmark list.</p>
      <div className="binder-header-actions">
        <button className="quiet-button tone-accent" type="submit" disabled={pending}>
          {reserved ? 'Save page label' : 'Reserve this page'}
        </button>
        {reserved ? (
          <button
            className="text-button"
            type="button"
            disabled={pending}
            onClick={() =>
              void onUnreserve().then((saved) => {
                if (saved) onClose();
              })
            }
          >
            Unreserve this page
          </button>
        ) : null}
      </div>
    </form>
  );
}
