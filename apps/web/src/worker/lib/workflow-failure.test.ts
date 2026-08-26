import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordWorkflowFailure } from './workflow-failure';

afterEach(() => vi.restoreAllMocks());

describe('workflow failure reporting', () => {
  it('emits the terminal error even when the failure-state write also fails', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await recordWorkflowFailure(
      { evt: 'workflow.test.failed', runId: 'run-1', step: 'apply', err: 'original failure' },
      () => Promise.reject(new Error('state write failed')),
    );
    expect(logged).toHaveBeenCalledOnce();
    expect(JSON.parse(String(logged.mock.calls[0]?.[0]))).toMatchObject({
      evt: 'workflow.test.failed',
      runId: 'run-1',
      step: 'apply',
      err: 'original failure',
      failureStateError: 'Error: state write failed',
    });
  });
});
