type LogLevel = 'info' | 'warn' | 'error';
export interface LogFields {
  evt: string;
  [key: string]: unknown;
}

export function log(level: LogLevel, fields: LogFields): void {
  console.log(JSON.stringify({ lvl: level, ts: new Date().toISOString(), ...fields }));
}
export const logInfo = (fields: LogFields): void => log('info', fields);
export const logWarn = (fields: LogFields): void => log('warn', fields);
export const logError = (fields: LogFields): void => log('error', fields);
export function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
