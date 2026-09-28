import { useQueryClient } from '@tanstack/react-query';
import { useId, useState, type ReactElement } from 'react';
import { Button, Disclosure, DisclosurePanel, Heading } from 'react-aria-components';
import { queryKeys } from '../api/keys';
import { Icon } from '../ui/icons';
import {
  authErrorMessage,
  devLogin,
  isLocalHost,
  registerPasskey,
  signInWithPasskey,
} from './passkeys';

type Pending = 'login' | 'enrol' | 'dev' | null;

/**
 * The gate every real route sits behind: sign in with a passkey, or enrol this device
 * with the enrolment secret (only ever works for the first passkey on a fresh deploy;
 * everyone else joins through an invite link). Both share one alert area.
 */
export function SignIn(): ReactElement {
  const queryClient = useQueryClient();
  const id = useId();
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<string | null>(null);
  const [enrolSecret, setEnrolSecret] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [invalid, setInvalid] = useState(false);
  const local = isLocalHost(location.hostname);

  async function attempt(kind: Exclude<Pending, null>, action: () => Promise<void>): Promise<void> {
    setPending(kind);
    setError(null);
    try {
      await action();
      await queryClient.invalidateQueries({ queryKey: queryKeys.session() });
    } catch (reason) {
      const message = authErrorMessage(reason);
      if (message) setError(message);
    } finally {
      setPending(null);
    }
  }

  function enrol(): void {
    const missing = !enrolSecret.trim() || !deviceName.trim();
    setInvalid(missing);
    if (missing) {
      setError('Enter the enrolment secret and a device name.');
      return;
    }
    void attempt('enrol', () =>
      registerPasskey({ name: deviceName.trim(), enrolSecret: enrolSecret.trim() }),
    );
  }

  return (
    <main className="sign-in-shell">
      <section className="sign-in-card" aria-labelledby={`${id}-heading`}>
        <h1 id={`${id}-heading`}>Sign in</h1>
        <p>Use the passkey registered for your collection.</p>
        <div className="sign-in-alert" role="alert" aria-live="assertive">
          {error ? <p className="notice error">{error}</p> : null}
        </div>
        <button
          type="button"
          onClick={() => void attempt('login', signInWithPasskey)}
          disabled={pending !== null}
        >
          {pending === 'login' ? 'Waiting for passkey…' : 'Continue with passkey'}
        </button>
        {local ? (
          <button
            type="button"
            className="sign-in-secondary"
            onClick={() => void attempt('dev', devLogin)}
            disabled={pending !== null}
          >
            Use local development login
          </button>
        ) : null}
        <Disclosure className="sign-in-enrol">
          <Heading className="sign-in-enrol-heading">
            <Button slot="trigger" className="sign-in-enrol-trigger">
              <Icon name="chevron-down" className="sign-in-enrol-chevron" />
              Enrol another device
            </Button>
          </Heading>
          <DisclosurePanel>
            <form
              aria-labelledby={`${id}-enrol`}
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                enrol();
              }}
            >
              <h2 id={`${id}-enrol`} className="sr-only">
                Enrol another device
              </h2>
              <label>
                <span>Enrolment secret</span>
                <input
                  type="password"
                  autoComplete="off"
                  value={enrolSecret}
                  aria-invalid={invalid && !enrolSecret.trim()}
                  onChange={(event) => setEnrolSecret(event.target.value)}
                />
              </label>
              <label>
                <span>Device name</span>
                <input
                  value={deviceName}
                  maxLength={60}
                  aria-invalid={invalid && !deviceName.trim()}
                  onChange={(event) => setDeviceName(event.target.value)}
                />
              </label>
              <button type="submit" disabled={pending !== null}>
                {pending === 'enrol' ? 'Creating passkey…' : 'Enrol this device'}
              </button>
            </form>
          </DisclosurePanel>
        </Disclosure>
      </section>
    </main>
  );
}
