import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

class SqliteD1Statement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly query: string,
    private readonly values: SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new SqliteD1Statement(
      this.database,
      this.query,
      values as SQLInputValue[],
    ) as unknown as D1PreparedStatement;
  }

  first<T = Record<string, unknown>>(columnName?: string): Promise<T | null> {
    const row = this.database.prepare(this.query).get(...this.values) as
      Record<string, unknown> | undefined;
    return Promise.resolve((columnName ? row?.[columnName] : (row ?? null)) as T | null);
  }

  run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return Promise.resolve(this.execute<T>());
  }

  all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const results = this.database.prepare(this.query).all(...this.values) as T[];
    return Promise.resolve({
      success: true,
      results,
      meta: { changes: 0 },
    } as unknown as D1Result<T>);
  }

  raw<T = unknown[]>(): Promise<T[]> {
    const rows = this.database.prepare(this.query).all(...this.values) as Array<
      Record<string, unknown>
    >;
    return Promise.resolve(rows.map((row) => Object.values(row)) as T[]);
  }

  execute<T = Record<string, unknown>>(): D1Result<T> {
    const result = this.database.prepare(this.query).run(...this.values);
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    } as unknown as D1Result<T>;
  }
}

export function sqliteD1(database: DatabaseSync): D1Database {
  return {
    prepare: (query: string) =>
      new SqliteD1Statement(database, query) as unknown as D1PreparedStatement,
    batch: <T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
      database.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map((statement) =>
          (statement as unknown as SqliteD1Statement).execute<T>(),
        );
        database.exec('COMMIT');
        return Promise.resolve(results);
      } catch (error) {
        database.exec('ROLLBACK');
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    exec: (query: string) => {
      database.exec(query);
      return Promise.resolve({ count: 0, duration: 0 });
    },
    dump: () => Promise.resolve(new ArrayBuffer(0)),
  } as unknown as D1Database;
}

export function applyAllMigrations(database: DatabaseSync): void {
  const directory = new URL('../../../migrations/', import.meta.url);
  for (const name of [
    '001_auth.sql',
    '002_catalogue_collection_binders.sql',
    '003_art_upload_tokens.sql',
    '004_staged_ingestion.sql',
    '005_catalogue_arrangement_metadata.sql',
    '006_hardening_and_sync.sql',
    '007_national_pokedex.sql',
    '008_physical_printing_identity.sql',
    '009_species_discovery_cache.sql',
  ])
    database.exec(readFileSync(new URL(name, directory), 'utf8'));
}
