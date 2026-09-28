import { useState, type ReactElement } from 'react';
import { ApiError } from '../../api/client';
import { usePasskeyMutations, usePasskeys, type PasskeyView } from '../../api/queries/settings';
import { authErrorMessage, registerPasskey } from '../../shell/passkeys';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { useToast } from '../../ui/Toast';
import { formatDate } from './format';

function passkeyName(passkey: PasskeyView): string {
  return passkey.name ?? passkey.device_label ?? 'Unnamed passkey';
}

export function PasskeysTab(): ReactElement {
  const passkeys = usePasskeys();
  const { rename, remove, refresh } = usePasskeyMutations();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [removing, setRemoving] = useState<PasskeyView | null>(null);

  async function add(): Promise<void> {
    if (!newName.trim()) {
      setError('Give the new device a name.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      await registerPasskey({ name: newName.trim() });
      await refresh();
      toast('success', `${newName.trim()} can now sign in.`);
      setAdding(false);
      setNewName('');
    } catch (cause) {
      const message = authErrorMessage(cause);
      if (message) setError(message);
    } finally {
      setPending(false);
    }
  }

  const list = passkeys.data ?? [];
  return (
    <section className="settings-card" aria-labelledby="passkeys-heading">
      <div className="settings-card-header">
        <h2 id="passkeys-heading">Your sign-in</h2>
        <span className="settings-help">
          {list.length} {list.length === 1 ? 'passkey' : 'passkeys'}
        </span>
      </div>
      {passkeys.isLoading ? <p role="status">Loading your passkeys…</p> : null}
      {passkeys.isError ? (
        <p role="alert" className="panel-error">
          Your passkeys could not be loaded. Try again.
        </p>
      ) : null}
      <ul className="settings-list">
        {list.map((passkey) => (
          <li key={passkey.id}>
            {editing?.id === passkey.id ? (
              <form
                className="settings-inline-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const name = editing.name.trim();
                  if (!name) return;
                  rename.mutate(
                    { id: passkey.id, name },
                    {
                      onSuccess: () => {
                        toast('success', 'Passkey renamed.');
                        setEditing(null);
                      },
                      onError: () => toast('error', 'The passkey could not be renamed. Try again.'),
                    },
                  );
                }}
              >
                <label>
                  <span className="sr-only">Passkey name</span>
                  <input
                    value={editing.name}
                    maxLength={60}
                    onChange={(event) => setEditing({ id: passkey.id, name: event.target.value })}
                  />
                </label>
                <button type="submit" className="button-primary" disabled={rename.isPending}>
                  Save
                </button>
                <button type="button" className="button-text" onClick={() => setEditing(null)}>
                  Cancel
                </button>
              </form>
            ) : (
              <>
                <span className="settings-list-main">
                  <strong>{passkeyName(passkey)}</strong>
                  <span className="settings-help">
                    Added {formatDate(passkey.created_at)} · last used{' '}
                    {passkey.last_used_at ? formatDate(passkey.last_used_at) : 'never'}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => setEditing({ id: passkey.id, name: passkeyName(passkey) })}
                >
                  Rename
                </button>
                <button
                  type="button"
                  className="button-danger"
                  onClick={() => setRemoving(passkey)}
                >
                  Remove
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      {adding ? (
        <form
          className="settings-inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <label>
            <span>Device name</span>
            <input
              value={newName}
              maxLength={60}
              placeholder="e.g. Work laptop"
              onChange={(event) => setNewName(event.target.value)}
            />
          </label>
          <button type="submit" className="button-primary" disabled={pending}>
            {pending ? 'Waiting for passkey…' : 'Create passkey'}
          </button>
          <button type="button" className="button-text" onClick={() => setAdding(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <button type="button" className="settings-start" onClick={() => setAdding(true)}>
          Add a passkey for another device
        </button>
      )}
      {error ? (
        <p role="alert" className="panel-error">
          {error}
        </p>
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        title="Remove passkey"
        description={`${removing ? passkeyName(removing) : 'This passkey'} will no longer sign in. Removing a passkey also signs you out on this device.`}
        confirmLabel="Remove passkey"
        destructive
        pending={remove.isPending}
        onCancel={() => setRemoving(null)}
        success="Passkey removed."
        describeError={(cause) =>
          cause instanceof ApiError && cause.code === 'last_passkey'
            ? 'This is your only passkey. Add another before removing it.'
            : 'The passkey could not be removed. Try again.'
        }
        onConfirm={() =>
          removing
            ? remove.mutateAsync(removing.id).then(() => {
                // The worker ends this session with the removal; reload into sign-in.
                location.reload();
              })
            : undefined
        }
      />
    </section>
  );
}
