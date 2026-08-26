import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import {
  executeBackupWorkflow,
  type BackupWorkflowDependencies,
  type BackupWorkflowOutput,
  type BackupWorkflowPayload,
} from '../lib/backup-workflow';
import { cleanupPendingBackup, createBackup, restoreBackup } from '../lib/backup';
import { pruneOperationalLedgers } from '../lib/retention';

export class BackupWorkflow extends WorkflowEntrypoint<CloudflareEnv, BackupWorkflowPayload> {
  override run(
    event: Readonly<WorkflowEvent<BackupWorkflowPayload>>,
    step: WorkflowStep,
  ): Promise<BackupWorkflowOutput> {
    const dependencies: BackupWorkflowDependencies = {
      create: (ownerId, backupId, runPage) =>
        createBackup(this.env.DB, this.env.ART, ownerId, { backupId, runPage }),
      restore: (ownerId, backupId, restoreRunId, runStep) =>
        restoreBackup(this.env.DB, this.env.ART, ownerId, backupId, { restoreRunId, runStep }),
      cleanup: (ownerId, backupId) =>
        cleanupPendingBackup(this.env.DB, this.env.ART, ownerId, backupId),
      retention: () => pruneOperationalLedgers(this.env.DB),
      ownerExists: async (ownerId) =>
        Boolean(
          await this.env.DB.prepare('SELECT id FROM users WHERE id = ?1').bind(ownerId).first(),
        ),
    };
    return executeBackupWorkflow(event.instanceId, event.payload, step, dependencies);
  }
}

export type { BackupWorkflowOutput, BackupWorkflowPayload } from '../lib/backup-workflow';
