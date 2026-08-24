import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { createBackup } from '../lib/backup';
import { logError } from '../lib/log';

export class BackupWorkflow extends WorkflowEntrypoint<CloudflareEnv, { ownerId?: string }> {
  override async run(
    event: Readonly<WorkflowEvent<{ ownerId?: string }>>,
    step: WorkflowStep,
  ): Promise<void> {
    const ownerId = event.payload.ownerId ?? 'owner';
    const startedAt = Date.now();
    let currentStep = 'validate-backup-owner';
    try {
      await step.do('create-versioned-backup', async () => {
        const owner = await this.env.DB.prepare('SELECT id FROM users WHERE id = ?1')
          .bind(ownerId)
          .first();
        if (!owner) throw new Error(`backup_owner_missing:${ownerId}`);
        currentStep = 'create-versioned-backup';
        return createBackup(this.env.DB, this.env.ART, ownerId);
      });
    } catch (error) {
      logError({
        evt: 'workflow.backup.failed',
        workflowInstanceId: event.instanceId,
        ownerId,
        step: currentStep,
        durationMs: Date.now() - startedAt,
        err: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }
}
