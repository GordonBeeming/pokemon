import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { createBackup } from '../lib/backup';
import { logError } from '../lib/log';
import { pruneOperationalLedgers } from '../lib/retention';

export class BackupWorkflow extends WorkflowEntrypoint<CloudflareEnv, { ownerId?: string }> {
  override async run(
    event: Readonly<WorkflowEvent<{ ownerId?: string }>>,
    step: WorkflowStep,
  ): Promise<{ id: string; checksum: string }> {
    const ownerId = event.payload.ownerId ?? 'owner';
    const startedAt = Date.now();
    let currentStep = 'validate-backup-owner';
    try {
      await step.do('validate-backup-owner', async () => {
        const owner = await this.env.DB.prepare('SELECT id FROM users WHERE id = ?1')
          .bind(ownerId)
          .first();
        if (!owner) throw new Error(`backup_owner_missing:${ownerId}`);
        return null;
      });
      currentStep = 'create-versioned-backup';
      const result = await createBackup(this.env.DB, this.env.ART, ownerId, (name, action) => {
        currentStep = name;
        return step.do(name, action);
      });
      currentStep = 'prune-operational-ledgers';
      await step.do('prune-operational-ledgers', async () => {
        await pruneOperationalLedgers(this.env.DB);
        return null;
      });
      return result;
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
