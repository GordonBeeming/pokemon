import { useState, type ReactElement } from 'react';
import { useApiTokenMutations, useApiTokens, type ApiToken } from '../../api/queries/tokens';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { Icon } from '../../ui/icons';
import { useToast } from '../../ui/Toast';
import { formatDateTime } from './format';

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard access can be refused (permissions, insecure origin); the code stays
    // on screen to copy by hand.
    return false;
  }
}

export function ApiTokensTab(): ReactElement {
  const tokens = useApiTokens();
  const { createPairingCode, revoke } = useApiTokenMutations();
  const toast = useToast();
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [revoking, setRevoking] = useState<ApiToken | null>(null);

  const active = (tokens.data ?? []).filter((token) => !token.revokedAt);
  return (
    <section className="settings-card" aria-labelledby="tokens-heading">
      <div className="settings-card-header">
        <h2 id="tokens-heading">API tokens</h2>
        <span className="settings-help">{active.length} active</span>
      </div>
      <p className="settings-help">
        For the AI card skill and scripts. Create a pairing code, enter it in the tool within 10
        minutes, and it receives its own token. Revoke a token to cut that tool off at once.
      </p>
      {code ? (
        <div className="pairing-code" role="status">
          <span className="settings-help">
            Pairing code · expires {formatDateTime(code.expiresAt)}
          </span>
          <code>{code.code}</code>
          <button
            type="button"
            onClick={() =>
              void copyText(code.code).then((copied) =>
                toast(
                  copied ? 'success' : 'error',
                  copied ? 'Pairing code copied.' : 'Copy failed; select the code instead.',
                ),
              )
            }
          >
            <Icon name="copy" />
            Copy code
          </button>
        </div>
      ) : null}
      <button
        type="button"
        className="settings-start button-primary"
        disabled={createPairingCode.isPending}
        onClick={() =>
          createPairingCode.mutate(undefined, {
            onSuccess: setCode,
            onError: () => toast('error', 'A pairing code could not be created. Try again.'),
          })
        }
      >
        <Icon name="key" />
        {code ? 'Create another pairing code' : 'Create pairing code'}
      </button>
      {tokens.isLoading ? <p role="status">Loading tokens…</p> : null}
      {tokens.isError ? (
        <p role="alert" className="panel-error">
          Tokens could not be loaded. Try again.
        </p>
      ) : null}
      {tokens.data && tokens.data.length === 0 ? (
        <p className="settings-help">No tokens issued yet.</p>
      ) : null}
      <ul className="settings-list">
        {(tokens.data ?? []).map((token) => (
          <li key={token.id}>
            <span className="settings-list-main">
              <strong>{token.label}</strong>
              <span className="settings-help">
                {token.revokedAt
                  ? `Revoked ${formatDateTime(token.revokedAt)}`
                  : `Last used ${token.lastUsedAt ? formatDateTime(token.lastUsedAt) : 'never'}${token.expiresAt ? ` · expires ${formatDateTime(token.expiresAt)}` : ''}`}
              </span>
            </span>
            {!token.revokedAt ? (
              <button type="button" className="button-danger" onClick={() => setRevoking(token)}>
                Revoke
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={revoking !== null}
        title="Revoke token"
        description={`${revoking?.label ?? 'This tool'} will stop working immediately. It needs a new pairing code to connect again.`}
        confirmLabel="Revoke token"
        destructive
        pending={revoke.isPending}
        onCancel={() => setRevoking(null)}
        success={`${revoking?.label ?? 'The token'} was revoked.`}
        describeError={() => 'That token could not be revoked. Try again.'}
        onConfirm={() => (revoking ? revoke.mutateAsync(revoking.id) : undefined)}
      />
    </section>
  );
}
