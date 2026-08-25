import { logError, logInfo, logWarn } from './log';
import type { BackupPageRunner, RestoreStepRunner } from './backup';
import type { RetentionResult } from './retention';

export interface BackupWorkflowPayload {
  ownerId?: string;
  operation?: 'create' | 'restore';
  backupId?: string;
}

export type BackupWorkflowOutput =
  { id: string; checksum: string } | { restored: true; backupId: string };

export interface WorkflowStepLike {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

export interface BackupWorkflowDependencies {
  create(
    ownerId: string,
    backupId: string,
    runPage: BackupPageRunner,
  ): Promise<{ id: string; checksum: string }>;
  restore(
    ownerId: string,
    backupId: string,
    restoreRunId: string,
    runStep: RestoreStepRunner,
  ): Promise<void>;
  cleanup(ownerId: string, backupId: string): Promise<void>;
  retention(): Promise<RetentionResult>;
  ownerExists(ownerId: string): Promise<boolean>;
}

const RETENTION_MAX_STEPS = 50;

async function drainRetention(
  step: WorkflowStepLike,
  dependencies: BackupWorkflowDependencies,
): Promise<void> {
  const deleted = { artUploadTokens: 0, collectionMutations: 0, audit: 0 };
  let remaining = 0;
  for (let page = 0; page < RETENTION_MAX_STEPS; page += 1) {
    const result = await step.do(`retention-${page}`, () => dependencies.retention());
    deleted.artUploadTokens += result.deleted.artUploadTokens;
    deleted.collectionMutations += result.deleted.collectionMutations;
    deleted.audit += result.deleted.audit;
    remaining = result.totalRemaining;
    if (remaining === 0) break;
  }
  const fields = { evt: 'workflow.retention.complete', deleted, remaining };
  if (remaining > 0) logWarn(fields);
  else logInfo(fields);
}

export async function executeBackupWorkflow(
  instanceId: string,
  payload: Readonly<BackupWorkflowPayload>,
  step: WorkflowStepLike,
  dependencies: BackupWorkflowDependencies,
): Promise<BackupWorkflowOutput> {
  const ownerId = payload.ownerId ?? 'owner';
  const operation = payload.operation ?? 'create';
  const stableBackupId = `backup_${instanceId}`;
  const startedAt = Date.now();
  let currentStep = 'validate-backup-owner';
  let operationError: Error | undefined;
  let output: BackupWorkflowOutput | undefined;
  try {
    await step.do('validate-backup-owner', async () => {
      if (!(await dependencies.ownerExists(ownerId)))
        throw new Error(`backup_owner_missing:${ownerId}`);
      return null;
    });
    if (operation === 'restore') {
      const backupId = payload.backupId;
      if (!backupId) throw new Error('backup_restore_id_missing');
      currentStep = 'restore-backup';
      await dependencies.restore(ownerId, backupId, `restore_${instanceId}`, (name, action) => {
        currentStep = name;
        return step.do(name, action);
      });
      output = { restored: true, backupId };
    } else {
      currentStep = 'create-versioned-backup';
      output = await dependencies.create(ownerId, stableBackupId, (name, action) => {
        currentStep = name;
        return step.do(name, action);
      });
    }
  } catch (error) {
    operationError = error instanceof Error ? error : new Error(String(error));
    logError({
      evt: 'workflow.backup.failed',
      workflowInstanceId: instanceId,
      ownerId,
      operation,
      step: currentStep,
      durationMs: Date.now() - startedAt,
      err: `${operationError.name}: ${operationError.message}`,
      stack: operationError.stack,
    });
    if (operation === 'create') {
      try {
        await step.do('cleanup-pending-backup', async () => {
          await dependencies.cleanup(ownerId, stableBackupId);
          return null;
        });
      } catch (cleanupError) {
        logError({
          evt: 'workflow.backup.cleanup_failed',
          workflowInstanceId: instanceId,
          ownerId,
          backupId: stableBackupId,
          err: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }
    }
  }
  try {
    await drainRetention(step, dependencies);
  } catch (retentionError) {
    logError({
      evt: 'workflow.retention.failed',
      workflowInstanceId: instanceId,
      ownerId,
      err: retentionError instanceof Error ? retentionError.message : String(retentionError),
    });
    if (operationError === undefined) throw retentionError;
  }
  if (operationError !== undefined) throw operationError;
  if (!output) throw new Error('backup_workflow_output_missing');
  return output;
}
