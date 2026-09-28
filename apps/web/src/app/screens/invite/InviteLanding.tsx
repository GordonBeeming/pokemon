import { useQueryClient } from '@tanstack/react-query';
import { useId, useState, type ReactElement } from 'react';
import { queryKeys } from '../../api/keys';
import { peopleErrorMessage, useInviteStatus } from '../../api/queries/people';
import { authErrorMessage, registerPasskey } from '../../shell/passkeys';
import { formatDate } from '../settings/format';
import '../../shell/shell.css';

/**
 * Where an invite link lands, signed out. It checks the link, then registers a
 * passkey on this device for a brand-new person: their own collection, binders and
 * settings, separate from whoever invited them.
 */
export function InviteLanding({
  token,
  onJoined,
}: {
  token: string;
  onJoined: () => void;
}): ReactElement {
  const id = useId();
  const queryClient = useQueryClient();
  const status = useInviteStatus(token);
  const [deviceName, setDeviceName] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function join(): Promise<void> {
    if (!deviceName.trim()) {
      setInvalid(true);
      setError('Give this device a name so you can tell your passkeys apart later.');
      return;
    }
    setInvalid(false);
    setPending(true);
    setError(null);
    try {
      await registerPasskey({ name: deviceName.trim(), inviteToken: token });
      await queryClient.invalidateQueries({ queryKey: queryKeys.session() });
      onJoined();
    } catch (reason) {
      const message = authErrorMessage(reason);
      if (message) setError(message);
      void status.refetch();
    } finally {
      setPending(false);
    }
  }

  const invite = status.data;
  return (
    <main className="sign-in-shell">
      <section className="sign-in-card" aria-labelledby={`${id}-heading`}>
        {status.isLoading ? (
          <p role="status">Checking your invite…</p>
        ) : status.isError ? (
          <>
            <h1 id={`${id}-heading`}>This invite can’t be checked</h1>
            <p className="notice error" role="alert">
              {peopleErrorMessage(status.error)}
            </p>
            <button type="button" onClick={() => void status.refetch()}>
              Try again
            </button>
          </>
        ) : !invite?.valid ? (
          <>
            <h1 id={`${id}-heading`}>This invite link no longer works</h1>
            <p role="alert">
              {invite?.used
                ? 'It has already been used or was cancelled. Each link works once.'
                : invite?.expired
                  ? 'It has expired. Invite links last 7 days.'
                  : 'It isn’t a valid invite link. Check you copied all of it.'}{' '}
              Ask the person who invited you for a new link.
            </p>
          </>
        ) : (
          <>
            <h1 id={`${id}-heading`}>You’re invited</h1>
            <p>
              {invite.invitedBy ? (
                <>
                  <strong>{invite.invitedBy}</strong> invited you
                  {invite.label ? (
                    <>
                      {' '}
                      as <strong>{invite.label}</strong>
                    </>
                  ) : null}
                  {invite.role === 'admin' ? ', with admin access' : ''}.{' '}
                </>
              ) : invite.label ? (
                <>
                  This invite is for <strong>{invite.label}</strong>.{' '}
                </>
              ) : null}
              You’ll get your own collection and binders. Nobody else can see or change them.
              {invite.expiresAt
                ? ` The link works once and expires ${formatDate(invite.expiresAt)}.`
                : ''}
            </p>
            <div className="sign-in-alert" role="alert" aria-live="assertive">
              {error ? <p className="notice error">{error}</p> : null}
            </div>
            <form
              className="invite-form"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void join();
              }}
            >
              <label>
                <span>Name this device</span>
                <input
                  value={deviceName}
                  maxLength={60}
                  placeholder="e.g. My phone"
                  aria-invalid={invalid}
                  onChange={(event) => setDeviceName(event.target.value)}
                />
              </label>
              <button type="submit" disabled={pending}>
                {pending ? 'Creating passkey…' : 'Create my passkey'}
              </button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}
