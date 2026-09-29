import type { UserRole } from '@pokedex/shared';
import { useState, type ReactElement } from 'react';
import {
  peopleErrorMessage,
  useInvites,
  usePeople,
  usePeopleMutations,
  type PersonView,
} from '../../api/queries/people';
import { Icon } from '../../ui/icons';
import { SelectField } from '../../ui/SelectField';
import { useToast } from '../../ui/Toast';
import { formatDate } from './format';

const AVATAR_COLOURS = ['#0e7490', '#9d174d', '#3730a3', '#3f6212', '#9a3412', '#6b21a8'];

function avatarColour(id: string): string {
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return AVATAR_COLOURS[hash % AVATAR_COLOURS.length] ?? '#0e7490';
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard access can be refused; the link stays on screen to copy by hand.
    return false;
  }
}

function PersonRow({
  person,
  isMe,
  busy,
  onRole,
  onToggle,
}: {
  person: PersonView;
  isMe: boolean;
  busy: boolean;
  onRole: (role: UserRole) => void;
  onToggle: () => void;
}): ReactElement {
  const disabled = person.disabledAt !== null;
  return (
    <li className={`person-row${disabled ? ' person-row-disabled' : ''}`}>
      <span
        className="person-avatar"
        aria-hidden="true"
        style={{ background: disabled ? '#94a3b8' : avatarColour(person.id) }}
      >
        {person.label.slice(0, 1).toUpperCase()}
      </span>
      <span className="person-main">
        <span className="person-name">
          {person.label} {isMe ? <span className="settings-help">(you)</span> : null}
        </span>
        <span className="settings-help">
          {person.passkeyCount} {person.passkeyCount === 1 ? 'passkey' : 'passkeys'} · joined{' '}
          {formatDate(person.createdAt)}
          {person.lastUsedAt ? ` · last signed in ${formatDate(person.lastUsedAt)}` : ''}
        </span>
      </span>
      <span className={`person-status${disabled ? ' person-status-off' : ''}`}>
        {disabled ? 'Disabled' : 'Active'}
      </span>
      <div className="segmented-control" role="group" aria-label={`Role for ${person.label}`}>
        {(['admin', 'member'] as const).map((role) => (
          <button
            key={role}
            type="button"
            aria-pressed={person.role === role}
            className={person.role === role ? 'segmented-control-option-active' : undefined}
            disabled={busy}
            onClick={() => {
              if (person.role !== role) onRole(role);
            }}
          >
            {role === 'admin' ? 'Admin' : 'Member'}
          </button>
        ))}
      </div>
      <button
        type="button"
        className={disabled ? undefined : 'button-danger'}
        disabled={busy}
        onClick={onToggle}
      >
        {disabled ? 'Enable' : 'Disable'}
      </button>
    </li>
  );
}

export function PeopleTab({ meId }: { meId: string | null }): ReactElement {
  const people = usePeople(true);
  const invites = useInvites(true);
  const { patchPerson, createInvite, cancelInvite } = usePeopleMutations();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [label, setLabel] = useState('');
  const [role, setRole] = useState<UserRole>('member');
  const [created, setCreated] = useState<{ id: string; url: string } | null>(null);

  const busy = patchPerson.isPending;

  function patch(
    person: PersonView,
    change: { role?: UserRole; disabled?: boolean },
    done: string,
  ) {
    setError(null);
    patchPerson.mutate(
      { id: person.id, patch: change },
      {
        onSuccess: () => toast('success', done),
        onError: (cause) => {
          const message = peopleErrorMessage(cause);
          setError(message);
          toast('error', message);
        },
      },
    );
  }

  const pending = (invites.data ?? []).filter(
    (invite) =>
      !invite.redeemedAt && !invite.cancelledAt && Date.parse(invite.expiresAt) > Date.now(),
  );

  return (
    <section className="settings-card" aria-labelledby="people-heading">
      <div className="settings-card-header">
        <h2 id="people-heading">People</h2>
        <span className="settings-help">Admins only</span>
      </div>
      <p className="settings-help">
        Everyone shares the card catalogue. Collections, binders and settings belong to each person,
        and nobody can see or change someone else’s.
      </p>
      {error ? (
        <p role="alert" className="panel-error">
          {error}
        </p>
      ) : null}
      {people.isLoading ? <p role="status">Loading people…</p> : null}
      {people.isError ? (
        <p role="alert" className="panel-error">
          {peopleErrorMessage(people.error)}
        </p>
      ) : null}
      <ul className="people-list">
        {(people.data ?? []).map((person) => (
          <PersonRow
            key={person.id}
            person={person}
            isMe={person.id === meId}
            busy={busy}
            onRole={(next) =>
              patch(
                person,
                { role: next },
                `${person.label} is now ${next === 'admin' ? 'an admin' : 'a member'}.`,
              )
            }
            onToggle={() =>
              patch(
                person,
                { disabled: person.disabledAt === null },
                person.disabledAt === null
                  ? `${person.label} is signed out and can’t sign in. Nothing of theirs was deleted.`
                  : `${person.label} can sign in again. Their cards and binders are as they left them.`,
              )
            }
          />
        ))}
        {pending.map((invite) => {
          // The link exists only in the response that created it (the server keeps a
          // hash), so the new invite's own row carries it until the page is left.
          const link = created?.id === invite.id ? created.url : null;
          return (
            <li key={invite.id} className={link ? 'invite-row invite-row-new' : 'invite-row'}>
              <span className="person-avatar person-avatar-invite" aria-hidden="true">
                +
              </span>
              <span className="person-main">
                <span className="person-name">
                  Invite{invite.label ? ` for ${invite.label}` : ''} ·{' '}
                  {invite.role === 'admin' ? 'admin' : 'member'}
                </span>
                <span className="settings-help">
                  {link ? 'Works once' : 'Waiting'} · expires {formatDate(invite.expiresAt)}
                </span>
                {link ? <code className="invite-url">{link}</code> : null}
              </span>
              {link ? (
                <button
                  type="button"
                  className="button-primary"
                  onClick={() =>
                    void copyText(link).then((copied) =>
                      toast(
                        copied ? 'success' : 'error',
                        copied ? 'Invite link copied.' : 'Copy failed; select the link instead.',
                      ),
                    )
                  }
                >
                  <Icon name="copy" />
                  Copy link
                </button>
              ) : null}
              <button
                type="button"
                disabled={cancelInvite.isPending}
                onClick={() =>
                  cancelInvite.mutate(invite.id, {
                    onSuccess: () => {
                      toast('success', 'Invite cancelled. The link no longer works.');
                      setCreated(null);
                    },
                    onError: (cause) => toast('error', peopleErrorMessage(cause)),
                  })
                }
              >
                Cancel
              </button>
            </li>
          );
        })}
      </ul>
      {inviting ? (
        <form
          className="settings-inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            createInvite.mutate(
              { role, ...(label.trim() ? { label: label.trim() } : {}) },
              {
                onSuccess: (result) => {
                  setCreated({ id: result.id, url: result.inviteUrl });
                  setInviting(false);
                  setLabel('');
                  toast(
                    'success',
                    'Invite created. Copy the link and send it; it’s only shown now.',
                  );
                },
                onError: (cause) => toast('error', peopleErrorMessage(cause)),
              },
            );
          }}
        >
          <label>
            <span>Who is it for? (optional)</span>
            <input
              value={label}
              maxLength={120}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          <SelectField<'admin' | 'member'>
            label="Role"
            value={role}
            options={[
              { value: 'member', label: 'Member' },
              { value: 'admin', label: 'Admin' },
            ]}
            onChange={setRole}
          />
          <button type="submit" className="button-primary" disabled={createInvite.isPending}>
            Create invite link
          </button>
          <button type="button" className="button-text" onClick={() => setInviting(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <button
          type="button"
          className="settings-start button-primary"
          onClick={() => setInviting(true)}
        >
          Invite someone
        </button>
      )}
      <p className="settings-help">
        Disabling someone signs them out and blocks sign-in. Their cards and binders are kept, and
        turning them back on restores everything. There’s always at least one active admin.
      </p>
    </section>
  );
}
