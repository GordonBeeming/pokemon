import { describe, expect, it, vi } from 'vitest';
import { announceLoggedOut, onLoggedOutElsewhere } from './session-exit';

describe('session exit broadcast', () => {
  it('tells a listener in another context that the session ended', async () => {
    const onLoggedOut = vi.fn();
    const unsubscribe = onLoggedOutElsewhere(onLoggedOut);

    announceLoggedOut();
    await vi.waitFor(() => expect(onLoggedOut).toHaveBeenCalledTimes(1));

    unsubscribe();
  });
});
