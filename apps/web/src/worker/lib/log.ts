type LogLevel = 'info' | 'warn' | 'error';
export interface LogFields {
  evt: string;
  [key: string]: unknown;
}

export function log(level: LogLevel, fields: LogFields): void {
  const entry = JSON.stringify({ lvl: level, ts: new Date().toISOString(), ...fields });
  if (level === 'error') {
    console.error(entry);
    return;
  }
  if (level === 'warn') {
    console.warn(entry);
    return;
  }
  console.info(entry);
}
export const logInfo = (fields: LogFields): void => log('info', fields);
export const logWarn = (fields: LogFields): void => log('warn', fields);
export const logError = (fields: LogFields): void => log('error', fields);
export function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export class ApplicationError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 416 | 429 | 500 | 503,
  ) {
    super(code);
    this.name = 'ApplicationError';
  }
}
