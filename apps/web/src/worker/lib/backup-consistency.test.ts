import { describe, expect, it } from 'vitest';
import { createBackup } from './backup';

const meta: D1Meta & Record<string, unknown> = {
  duration: 0,
  size_after: 0,
  rows_read: 0,
  rows_written: 1,
  last_row_id: 0,
  changed_db: true,
  changes: 1,
};

class StubStatement implements D1PreparedStatement {
  constructor(
    private readonly sql: string,
    private readonly backupEpoch: () => number,
    private readonly objectKey: string,
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    void values;
    return this;
  }

  first<T = unknown>(_colName: string): Promise<T | null>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  first<T>(): Promise<T | null> {
    if (this.sql.includes('SELECT backup_epoch FROM users'))
      return Promise.resolve({ backup_epoch: this.backupEpoch() } as T);
    if (this.sql.includes('SELECT owner_id, object_key FROM backup_runs'))
      return Promise.resolve({ owner_id: 'owner', object_key: this.objectKey } as T);
    return Promise.resolve(null);
  }

  all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return Promise.resolve({ results: [], success: true, meta });
  }

  run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return Promise.resolve({ results: [], success: true, meta });
  }

  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
    return Promise.resolve(options?.columnNames ? ([[]] as [string[], ...T[]]) : []);
  }
}

describe('backup snapshot consistency', () => {
  it('rejects a backup when the backup epoch changes between page steps', async () => {
    let backupEpoch = 0;
    const backupId = 'backup_snapshot_race';
    const objectKey = `backups/owner/${backupId}/manifest.json`;
    const pageNames: string[] = [];
    const db: D1Database = {
      prepare(sql: string) {
        return new StubStatement(sql, () => backupEpoch, objectKey);
      },
      batch<T>(statements: D1PreparedStatement[]) {
        return Promise.all(statements.map((statement) => statement.run<T>()));
      },
      exec() {
        return Promise.resolve({ count: 0, duration: 0 });
      },
      withSession() {
        throw new Error('sessions are not used by createBackup');
      },
      dump() {
        return Promise.resolve(new ArrayBuffer(0));
      },
    };
    const art = {} as R2Bucket;

    await expect(
      createBackup(db, art, 'owner', {
        backupId,
        runPage: async (name, action) => {
          pageNames.push(name);
          const result = await action();
          if (pageNames.length === 1) backupEpoch += 1;
          return result;
        },
      }),
    ).rejects.toThrow('backup_changed_during_creation');

    expect(pageNames[0]).toBe('backup-catalogue-0');
    expect(backupEpoch).toBe(1);
  });
});
