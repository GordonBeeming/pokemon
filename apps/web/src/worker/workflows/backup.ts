import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { createBackup } from '../lib/backup';

export class BackupWorkflow extends WorkflowEntrypoint<CloudflareEnv, { ownerId?: string }> {
  override async run(
    event: Readonly<WorkflowEvent<{ ownerId?: string }>>,
    step: WorkflowStep,
  ): Promise<void> {
    await step.do('create-versioned-backup', async () => {
      const ownerId = event.payload.ownerId ?? 'owner';
      const owner = await this.env.DB.prepare('SELECT id FROM users WHERE id = ?1')
        .bind(ownerId)
        .first();
      if (!owner) return null;
      return createBackup(this.env.DB, this.env.ART, ownerId);
    });
  }
}
