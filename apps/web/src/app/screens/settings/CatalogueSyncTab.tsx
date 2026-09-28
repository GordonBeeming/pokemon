import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactElement } from 'react';
import { ApiError } from '../../api/client';
import {
  startCatalogueSync,
  useCatalogueLastSynced,
  useCatalogueSyncProgress,
} from '../../api/queries/settings';
import { Icon } from '../../ui/icons';
import { useToast } from '../../ui/Toast';
import { formatDateTime } from './format';

// Remembered for this tab only, so a reload during a long sync still shows its progress.
const WORKFLOW_KEY = 'pokedex:catalogue-sync-workflow';

function readWorkflow(): string | null {
  try {
    return sessionStorage.getItem(WORKFLOW_KEY);
  } catch {
    return null;
  }
}
function writeWorkflow(id: string | null): void {
  try {
    if (id) sessionStorage.setItem(WORKFLOW_KEY, id);
    else sessionStorage.removeItem(WORKFLOW_KEY);
  } catch {
    // Unavailable storage only costs resuming progress after a reload.
  }
}

const STATUS_LABELS: Record<string, string> = {
  queued: 'Queued…',
  running: 'Syncing cards from TCGdex…',
  waiting: 'Waiting for TCGdex…',
  paused: 'Paused',
  complete: 'Sync complete.',
};

export function CatalogueSyncTab(): ReactElement {
  const queryClient = useQueryClient();
  const toast = useToast();
  const lastSynced = useCatalogueLastSynced();
  const [workflowId, setWorkflowId] = useState<string | null>(readWorkflow);
  const [starting, setStarting] = useState(false);
  const progress = useCatalogueSyncProgress(workflowId);

  useEffect(() => {
    if (progress.data === 'complete') {
      writeWorkflow(null);
      void queryClient.invalidateQueries({ queryKey: ['settings', 'catalogue-last-synced'] });
      void queryClient.invalidateQueries({ queryKey: ['catalogue'] });
      toast('success', 'The catalogue sync finished.');
      setWorkflowId(null);
    }
  }, [progress.data, queryClient, toast]);

  useEffect(() => {
    if (progress.isError) writeWorkflow(null);
  }, [progress.isError]);

  async function start(): Promise<void> {
    setStarting(true);
    try {
      const id = await startCatalogueSync();
      writeWorkflow(id);
      setWorkflowId(id);
    } catch (cause) {
      toast(
        'error',
        cause instanceof ApiError && cause.code === 'rate_limited'
          ? `A full sync can run twice a day. Try again${cause.retryAfterSeconds ? ` in ${Math.ceil(cause.retryAfterSeconds / 3600)} hours` : ' later'}.`
          : 'The sync could not be started. Try again.',
      );
    } finally {
      setStarting(false);
    }
  }

  const running = workflowId !== null && !progress.isError && progress.data !== 'complete';
  return (
    <section className="settings-card" aria-labelledby="sync-heading">
      <div className="settings-card-header">
        <h2 id="sync-heading">Catalogue</h2>
        <span className="settings-help">Admins</span>
      </div>
      <p className="settings-help">
        Last synced from TCGdex{' '}
        <strong>
          {lastSynced.isLoading
            ? '…'
            : lastSynced.data
              ? formatDateTime(lastSynced.data)
              : lastSynced.isError
                ? 'unknown'
                : 'never'}
        </strong>
        . New sets and cards appear for everyone.
      </p>
      {running ? (
        <p role="status" className="sync-progress">
          <span className="sync-spinner" aria-hidden="true" />
          {STATUS_LABELS[progress.data ?? 'queued'] ?? `Sync ${progress.data ?? 'starting'}…`}
        </p>
      ) : null}
      {progress.isError ? (
        <p role="alert" className="panel-error">
          The sync stopped before it finished. Nothing already in the catalogue was removed. Try
          again.
        </p>
      ) : null}
      <button
        type="button"
        className="settings-start"
        disabled={starting || running}
        onClick={() => void start()}
      >
        <Icon name="sync" />
        {running ? 'Syncing…' : 'Sync now'}
      </button>
    </section>
  );
}
