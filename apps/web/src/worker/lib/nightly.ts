import { runScheduledBackups } from './backup';
import { describeError, logError, logInfo } from './log';

// Kept out of index.ts (which imports `cloudflare:workers`) so the nightly plan is
// unit-testable under node. Every job is started independently: one failing never
// stops the rest, and nothing here throws, because a scheduled handler that throws
// only shows up as a missed cron run with no reason attached.

/** Brisbane has no daylight saving, so its offset from UTC is fixed. */
const BRISBANE_OFFSET_MS = 10 * 60 * 60 * 1000;

export interface NightlyJobs {
  db: D1Database;
  now: Date;
  startFx: (id: string) => Promise<unknown>;
  startPrices: (id: string, scope: 'in-use' | 'catalogue') => Promise<unknown>;
  startCatalogue: (id: string) => Promise<unknown>;
  startBackup: (ownerId: string) => Promise<{ id: string }>;
  /** The id of a catalogue sync that is genuinely still running, if any. */
  runningCatalogueSync: () => Promise<string | null>;
}

export function brisbaneDay(now: Date): { date: string; weekday: number } {
  const local = new Date(now.getTime() + BRISBANE_OFFSET_MS);
  return { date: local.toISOString().slice(0, 10).replaceAll('-', ''), weekday: local.getUTCDay() };
}

async function start(job: string, id: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
    logInfo({ evt: 'nightly.started', job, workflowId: id });
  } catch (error) {
    // Ids carry the Brisbane date, so a repeated trigger on the same night is
    // refused by Workflows as a duplicate rather than doing the work twice.
    logError({ evt: 'nightly.start_failed', job, workflowId: id, err: describeError(error) });
  }
}

export async function runNightlyJobs(jobs: NightlyJobs): Promise<void> {
  const { date, weekday } = brisbaneDay(jobs.now);
  // Exchange rates first so the price runs convert with today's rate.
  await start('fx', `fx-nightly-${date}`, () => jobs.startFx(`fx-nightly-${date}`));
  await start('prices-in-use', `prices-in-use-${date}`, () =>
    jobs.startPrices(`prices-in-use-${date}`, 'in-use'),
  );
  await start('prices-catalogue', `prices-catalogue-${date}`, () =>
    jobs.startPrices(`prices-catalogue-${date}`, 'catalogue'),
  );
  // The full catalogue walk is about 22k TCGdex lookups and sets change every few
  // weeks, so it runs once a week, early on Sunday morning in Brisbane.
  if (weekday === 0) {
    try {
      const running = await jobs.runningCatalogueSync();
      if (running) logInfo({ evt: 'nightly.catalogue_skipped', runningWorkflowId: running });
      else
        await start('catalogue', `catalogue-weekly-${date}`, () =>
          jobs.startCatalogue(`catalogue-weekly-${date}`),
        );
    } catch (error) {
      logError({ evt: 'nightly.catalogue_check_failed', err: describeError(error) });
    }
  }
  try {
    await runScheduledBackups(jobs.db, jobs.startBackup);
  } catch (error) {
    logError({ evt: 'backup.scheduled_run_failed', err: describeError(error) });
  }
}

/**
 * A catalogue sync row stays 'running' if its workflow errored or was terminated,
 * because only the workflow's own completion step closes it. Such a run is marked
 * failed here, so it can't block every later sync; a live run's id is returned.
 */
export async function runningCatalogueSync(
  db: D1Database,
  workflowStatus: (workflowId: string) => Promise<string>,
): Promise<string | null> {
  const running = await db
    .prepare(
      `SELECT id FROM sync_runs
       WHERE provider = 'tcgdex' AND language = 'en' AND complete_source = 1
         AND status = 'running'
       ORDER BY started_at DESC LIMIT 1`,
    )
    .first<{ id: string }>();
  if (!running) return null;
  const workflowId = running.id.replace(/^sync_/u, '');
  const status = await workflowStatus(workflowId);
  if (status !== 'errored' && status !== 'terminated') return workflowId;
  await db
    .prepare(
      `UPDATE sync_runs SET completed_at = ?1, status = 'failed', refusal_reason = ?2
       WHERE id = ?3 AND status = 'running'`,
    )
    .bind(Math.floor(Date.now() / 1000), `workflow_${status}`, running.id)
    .run();
  return null;
}
