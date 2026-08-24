import { afterEach, describe, expect, it, vi } from 'vitest';
import { logError, logInfo, logWarn } from './log';

afterEach(() => vi.restoreAllMocks());

describe('structured worker logging', () => {
  it('uses the native console severity for each structured level', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    logInfo({ evt: 'test.info', requestId: 'request-1' });
    logWarn({ evt: 'test.warn', requestId: 'request-1' });
    logError({ evt: 'test.error', requestId: 'request-1' });

    expect(info).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({
      lvl: 'error',
      evt: 'test.error',
      requestId: 'request-1',
    });
  });
});
