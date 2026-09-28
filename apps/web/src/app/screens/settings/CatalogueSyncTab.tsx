import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactElement } from 'react';
import { ApiError } from '../../api/client';
import {
  startCatalogueSync,
  startPriceRefresh,
  useCatalogueLastSynced,
  useCatalogueSyncProgress,
  usePriceRefreshProgress,
} from '../../api/queries/settings';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
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
    <>
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
          . New sets and cards appear for everyone. It also runs by itself every Sunday at 3am
          Brisbane time.
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
      <PriceRefreshCard />
    </>
  );
}

function PriceRefreshCard(): ReactElement {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [everyCardOpen, setEveryCardOpen] = useState(false);
  const [everyCardStarting, setEveryCardStarting] = useState(false);
  const progress = usePriceRefreshProgress(workflowId);

  useEffect(() => {
    if (progress.data !== 'complete') return;
    void queryClient.invalidateQueries({ queryKey: ['catalogue'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    toast('success', 'Prices are up to date.');
    setWorkflowId(null);
  }, [progress.data, queryClient, toast]);

  async function start(): Promise<void> {
    setStarting(true);
    try {
      setWorkflowId(await startPriceRefresh());
    } catch (cause) {
      toast('error', startFailureMessage(cause));
    } finally {
      setStarting(false);
    }
  }

  async function startEveryCard(): Promise<void> {
    setEveryCardStarting(true);
    try {
      await startPriceRefresh({ everyCard: true });
      toast('success', "Refreshing every card's price in the background.");
    } catch (cause) {
      toast('error', startFailureMessage(cause));
    } finally {
      setEveryCardStarting(false);
      setEveryCardOpen(false);
    }
  }

  const running = workflowId !== null && !progress.isError && progress.data !== 'complete';
  return (
    <section className="settings-card" aria-labelledby="prices-heading">
      <div className="settings-card-header">
        <h2 id="prices-heading">Prices</h2>
        <span className="settings-help">Admins</span>
      </div>
      <p className="settings-help">
        Prices for every card someone owns or has in a binder, converted to A$. They refresh by
        themselves every night at 3am Brisbane time, along with the rest of the catalogue a little
        at a time.
      </p>
      {running ? (
        <p role="status" className="sync-progress">
          <span className="sync-spinner" aria-hidden="true" />
          Fetching prices from TCGdex…
        </p>
      ) : null}
      {progress.isError ? (
        <p role="alert" className="panel-error">
          The price refresh stopped before it finished. Existing prices were kept. Try again.
        </p>
      ) : null}
      <div className="settings-card-actions">
        <button
          type="button"
          className="settings-start"
          disabled={starting || running}
          onClick={() => void start()}
        >
          <Icon name="sync" />
          {running ? 'Refreshing…' : 'Refresh prices'}
        </button>
        {/* The whole-catalogue walk is rare and long, so it stays a quiet secondary
            action behind a confirmation rather than a second primary button. */}
        <button
          type="button"
          className="button-text"
          disabled={everyCardStarting}
          onClick={() => setEveryCardOpen(true)}
        >
          Refresh every card…
        </button>
      </div>
      <ConfirmDialog
        open={everyCardOpen}
        title="Refresh every card's price?"
        description="This prices all ~21,000 cards in the background over about an hour. Refresh prices already covers your own cards; this fills in the rest."
        confirmLabel="Refresh every card"
        pending={everyCardStarting}
        onCancel={() => setEveryCardOpen(false)}
        onConfirm={() => void startEveryCard()}
      />
    </section>
  );
}

function startFailureMessage(cause: unknown): string {
  return cause instanceof ApiError && cause.code === 'rate_limited'
    ? 'Prices can be refreshed a few times a day. Try again later.'
    : 'The price refresh could not be started. Try again.';
}
