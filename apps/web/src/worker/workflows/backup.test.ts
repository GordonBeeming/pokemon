import { describe, expect, it, vi } from 'vitest';
import type { BackupPageRunner } from '../lib/backup';
import { executeBackupWorkflow, type BackupWorkflowPayload } from '../lib/backup-workflow';

class CachedStep {
  readonly names: string[] = [];
  private readonly values = new Map<string, unknown>();

  async do<T>(name: string, callback: () => Promise<T>): Promise<T> {
    this.names.push(name);
    if (this.values.has(name)) return this.values.get(name) as T;
    const value = await callback();
    this.values.set(name, value);
    return value;
  }
}

const emptyRetention = () =>
  Promise.resolve({
    deleted: { artUploadTokens: 0, collectionMutations: 0, audit: 0 },
    remaining: { artUploadTokens: 0, collectionMutations: 0, audit: 0 },
    totalRemaining: 0,
  });

describe('BackupWorkflow lifecycle', () => {
  it('reuses one backup ID and short-circuits page replay after commit', async () => {
    const step = new CachedStep();
    const pageAction = vi.fn(() =>
      Promise.resolve({ cursor: 1, rowCount: 1, bytes: 2, chunks: [] }),
    );
    const backupIds: string[] = [];
    let committed = false;
    const runPageCalls = vi.fn();
    const dependencies = {
      ownerExists: () => Promise.resolve(true),
      create: async (_ownerId: string, backupId: string, runPage: BackupPageRunner) => {
        backupIds.push(backupId);
        if (committed) return { id: backupId, checksum: 'a'.repeat(64) };
        runPageCalls();
        await runPage('backup-catalogue-0', pageAction);
        committed = true;
        return { id: backupId, checksum: 'a'.repeat(64) };
      },
      restore: vi.fn(),
      cleanup: vi.fn(),
      retention: emptyRetention,
    };

    const first = await executeBackupWorkflow('instance-1', {}, step, dependencies);
    const replay = await executeBackupWorkflow('instance-1', {}, step, dependencies);

    expect(first).toEqual({ id: 'backup_instance-1', checksum: 'a'.repeat(64) });
    expect(replay).toEqual(first);
    expect(backupIds).toEqual(['backup_instance-1', 'backup_instance-1']);
    expect(runPageCalls).toHaveBeenCalledOnce();
    expect(pageAction).toHaveBeenCalledOnce();
  });

  it('cleans only its stable pending prefix and drains retention after terminal failure', async () => {
    const step = new CachedStep();
    const cleanup = vi.fn(() => Promise.resolve());
    const retention = vi
      .fn()
      .mockResolvedValueOnce({
        deleted: { artUploadTokens: 5_000, collectionMutations: 0, audit: 0 },
        remaining: { artUploadTokens: 1, collectionMutations: 0, audit: 0 },
        totalRemaining: 1,
      })
      .mockResolvedValueOnce({
        deleted: { artUploadTokens: 1, collectionMutations: 0, audit: 0 },
        remaining: { artUploadTokens: 0, collectionMutations: 0, audit: 0 },
        totalRemaining: 0,
      });
    const dependencies = {
      ownerExists: () => Promise.resolve(true),
      create: () => Promise.reject(new Error('page retries exhausted')),
      restore: vi.fn(),
      cleanup,
      retention,
    };

    await expect(executeBackupWorkflow('failed-instance', {}, step, dependencies)).rejects.toThrow(
      'page retries exhausted',
    );

    expect(cleanup).toHaveBeenCalledWith('owner', 'backup_failed-instance');
    expect(retention).toHaveBeenCalledTimes(2);
    expect(step.names).toContain('cleanup-pending-backup');
    expect(step.names).toContain('retention-1');
  });

  it('runs restore chunks and finalization through stable Workflow steps', async () => {
    const step = new CachedStep();
    const restore = vi.fn(
      async (
        _ownerId: string,
        _backupId: string,
        restoreRunId: string,
        runStep: (name: string, action: () => Promise<null>) => Promise<null>,
      ) => {
        expect(restoreRunId).toBe('restore_restore-instance');
        await runStep('restore-chunk-catalogue-0', () => Promise.resolve(null));
        await runStep('restore-finalize', () => Promise.resolve(null));
      },
    );
    const dependencies = {
      ownerExists: () => Promise.resolve(true),
      create: vi.fn(),
      restore,
      cleanup: vi.fn(),
      retention: emptyRetention,
    };

    await expect(
      executeBackupWorkflow(
        'restore-instance',
        { operation: 'restore', backupId: 'backup_original' } satisfies BackupWorkflowPayload,
        step,
        dependencies,
      ),
    ).resolves.toEqual({ restored: true, backupId: 'backup_original' });
    expect(step.names).toContain('restore-chunk-catalogue-0');
    expect(step.names).toContain('restore-finalize');
    expect(dependencies.cleanup).not.toHaveBeenCalled();
  });
});
