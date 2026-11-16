import { catalogueWorkflowId } from './catalogue-workflow-id';
import { nowSeconds } from './db';
import { ApplicationError, describeError } from './log';

type Run = {
  id: string;
  provider: string;
  language: string;
  complete_source: number;
  status: string;
  source_count: number;
  imported_count: number;
  started_at: number;
  completed_at: number | null;
  refusal_reason: string | null;
};

// The engine can replay an execution after its catch ran. Keep the last error
// for diagnostics; only the engine's terminal status can confirm job failure.
export async function recordCatalogueExecutionError(
  db: D1Database,
  runId: string,
  message: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE sync_runs SET refusal_reason=?1
    WHERE id=?2 AND status IN ('running','complete')`,
    )
    .bind(message, runId)
    .run();
}

export async function restoreUnappliedCatalogueRun(
  db: D1Database,
  runId: string,
  actor: string | null,
): Promise<Run | null> {
  const run = await db.prepare('SELECT * FROM sync_runs WHERE id=?1').bind(runId).first<Run>();
  if (run?.status === 'running') return null;
  if (
    !run ||
    !catalogueWorkflowId(run.id) ||
    run.provider !== 'tcgdex' ||
    run.complete_source !== 1 ||
    run.status !== 'failed' ||
    run.source_count !== 0 ||
    run.imported_count !== 0
  ) {
    throw new ApplicationError('catalogue_resume_not_safe', 409);
  }
  const now = nowSeconds();
  const results = await db.batch([
    db
      .prepare(
        `UPDATE sync_runs SET status='running',completed_at=NULL,refusal_reason=NULL
      WHERE id=?1 AND status='failed' AND source_count=0 AND imported_count=0 AND complete_source=1
        AND completed_at IS ?2 AND refusal_reason IS ?3 AND language=?4 AND started_at=?5
        AND NOT EXISTS (SELECT 1 FROM sync_run_claims claim WHERE claim.run_id=?1)
        AND NOT EXISTS (SELECT 1 FROM sync_runs other
          WHERE other.provider='tcgdex' AND other.language=?4 AND other.complete_source=1
            AND ((other.started_at>?5 OR (other.started_at=?5 AND other.id>?1))
              OR (other.id<>?1 AND other.status='running')))`,
      )
      .bind(run.id, run.completed_at, run.refusal_reason, run.language, run.started_at),
    db
      .prepare(
        `INSERT INTO audit(actor,action,target,meta,created_at)
      SELECT (SELECT id FROM users WHERE id=?1),'catalogue.sync_tracking_recovered',?2,?3,?4 WHERE changes()=1`,
      )
      .bind(
        actor,
        run.id,
        JSON.stringify({
          previousStatus: run.status,
          previousCompletedAt: run.completed_at,
          previousFailure: run.refusal_reason,
        }),
        now,
      ),
  ]);
  if (results[0]?.meta.changes !== 1) throw new ApplicationError('catalogue_sync_changed', 409);
  return run;
}

export async function catalogueRestartPending(db: D1Database, runId: string): Promise<boolean> {
  const pending = await db
    .prepare(
      `SELECT 1 AS pending FROM sync_runs run
    WHERE run.id=?1 AND run.status IN ('running','failed') AND run.source_count=0 AND run.imported_count=0
      AND NOT EXISTS (SELECT 1 FROM sync_run_claims claim WHERE claim.run_id=run.id)
      AND EXISTS (SELECT 1 FROM audit event WHERE event.target=run.id
        AND event.action='catalogue.sync_tracking_recovered' AND event.created_at>=?2)`,
    )
    .bind(runId, nowSeconds() - 30)
    .first();
  return pending !== null;
}

export async function resumeCachedCatalogueSync(
  db: D1Database,
  actor: string,
  getWorkflow: (id: string) => Promise<Pick<WorkflowInstance, 'status' | 'restart'>>,
): Promise<{ workflowId: string; resumed: boolean; previousFailure?: string | null } | null> {
  const run = await db
    .prepare(
      `SELECT * FROM sync_runs
    WHERE provider='tcgdex' AND language='en' AND complete_source=1
    ORDER BY started_at DESC,id DESC LIMIT 1`,
    )
    .first<Run>();
  if (!run) return null;
  const workflowId = catalogueWorkflowId(run.id);
  if (!workflowId) return null;
  // A concurrent caller may have restored tracking but not received the engine's
  // restart acknowledgement yet. Join it rather than starting a newer import.
  if (!['running', 'failed'].includes(run.status)) return null;
  if (run.source_count !== 0 || run.imported_count !== 0) return null;
  let workflow: Pick<WorkflowInstance, 'status' | 'restart'>;
  let status: InstanceStatus;
  try {
    workflow = await getWorkflow(workflowId);
    status = await workflow.status();
  } catch (error) {
    if (/instance.not_found|not found|does not exist/iu.test(describeError(error))) return null;
    throw error;
  }
  if (status.status === 'errored' && (await catalogueRestartPending(db, run.id)))
    return { workflowId, resumed: false };
  if (!['errored', 'terminated', 'complete'].includes(status.status)) {
    if (run.status === 'failed') await restoreUnappliedCatalogueRun(db, run.id, actor);
    return { workflowId, resumed: false };
  }
  // This error can only occur after all fetch steps exist. Their cached results
  // are retained when restarting at the first idempotent staging step.
  if (status.status !== 'errored' || !status.error?.message.includes('staged_sync_not_running'))
    return null;
  const previous = await restoreUnappliedCatalogueRun(db, run.id, actor);
  if (!previous) return { workflowId, resumed: false };
  // If the restart response is lost, leave the row running: the engine may have
  // accepted it. Normal status reconciliation determines its actual outcome.
  await workflow.restart({ from: { name: 'stage-en-0', count: 1, type: 'do' } });
  return { workflowId, resumed: true, previousFailure: previous.refusal_reason };
}
