// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopStatus, PendingScan } from './domain';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  openUrl: vi.fn(),
  writeText: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: mocks.openUrl }));

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  if (!resolve || !reject) throw new Error('Deferred promise did not initialise.');
  return { promise, resolve, reject };
}

function status(pendingScans: PendingScan[] = []): DesktopStatus {
  return {
    config: {
      cloudBaseUrl: 'https://pokedex.example',
      imageLibraryPath: '/tmp/pokedex-art',
      mcpPort: 47_837,
      deviceLabel: 'Scanner',
    },
    paired: true,
    pendingScans,
    mcp: {
      endpoint: 'http://127.0.0.1:47837/mcp',
      configSnippet: '[mcp_servers.pokedex]\nurl = "http://127.0.0.1:47837/mcp"',
      running: true,
      error: null,
    },
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (check()) return;
    await settle();
  }
  throw new Error('Timed out waiting for the desktop UI.');
}

describe('desktop main DOM', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.invoke.mockReset();
    mocks.openUrl.mockReset();
    mocks.writeText.mockReset().mockResolvedValue(undefined);
    document.body.innerHTML = '<div id="app"></div>';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: mocks.writeText },
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn() },
    });
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        readonly root = null;
        readonly rootMargin = '0px';
        readonly thresholds = [0];

        constructor(private readonly callback: IntersectionObserverCallback) {}

        observe(target: Element): void {
          const bounds = target.getBoundingClientRect();
          queueMicrotask(() =>
            this.callback(
              [
                {
                  boundingClientRect: bounds,
                  intersectionRatio: 1,
                  intersectionRect: bounds,
                  isIntersecting: true,
                  rootBounds: null,
                  target,
                  time: performance.now(),
                },
              ],
              this,
            ),
          );
        }

        disconnect(): void {}
        unobserve(): void {}
        takeRecords(): IntersectionObserverEntry[] {
          return [];
        }
      },
    );
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  });

  it('executes capture controls and keeps the latest completed refresh visible', async () => {
    const firstScan: PendingScan = {
      id: '01909a91-2fd5-77e0-b7e9-962c6f8b57ec',
      createdAt: 1,
      source: 'file',
      mimeType: 'image/webp',
      bytes: 16,
      mutationId: '319e23de-1648-460e-8a82-a1379428357d',
      state: 'pending',
      confirmedCardId: null,
    };
    const secondScan: PendingScan = {
      ...firstScan,
      id: '02909a91-2fd5-77e0-b7e9-962c6f8b57ec',
      mutationId: '419e23de-1648-460e-8a82-a1379428357d',
    };
    const olderRefresh = deferred<DesktopStatus>();
    const newerRefresh = deferred<DesktopStatus>();
    const deleteCalls = [deferred<void>(), deferred<void>()];
    let statusCalls = 0;
    let deleteIndex = 0;

    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'desktop_status') {
        statusCalls += 1;
        if (statusCalls === 1) return Promise.resolve(status([firstScan, secondScan]));
        return statusCalls === 2 ? olderRefresh.promise : newerRefresh.promise;
      }
      if (command === 'pending_scan_preview_path') {
        return Promise.resolve('/tmp/pending.preview.jpg');
      }
      if (command === 'delete_pending_scan') {
        const call = deleteCalls[deleteIndex];
        deleteIndex += 1;
        return call?.promise ?? Promise.reject(new Error('Unexpected delete call.'));
      }
      return Promise.resolve(undefined);
    });

    await import('./main');
    await waitFor(() => document.querySelectorAll('.pending-item').length === 2);
    await waitFor(() =>
      mocks.invoke.mock.calls.some(([command]) => command === 'pending_scan_preview_path'),
    );
    expect(
      Array.from(document.querySelectorAll<HTMLImageElement>('.pending-item img')).every(
        (image) => image.src.startsWith('asset://') && image.src.includes('pending.preview.jpg'),
      ),
    ).toBe(true);

    const fileInput = document.querySelector('#file-capture');
    expect(fileInput).toBeInstanceOf(HTMLInputElement);
    expect(fileInput?.closest('label.file-action')?.textContent).toContain('Choose image');
    (fileInput as HTMLInputElement).focus();
    expect(document.activeElement).toBe(fileInput);

    document.querySelector<HTMLButtonElement>('#copy-mcp')?.click();
    await waitFor(() => mocks.writeText.mock.calls.length === 1);
    expect(mocks.writeText).toHaveBeenCalledWith(
      '[mcp_servers.pokedex]\nurl = "http://127.0.0.1:47837/mcp"',
    );

    const deleteButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.pending-item button'),
    );
    deleteButtons[0]?.click();
    expect(deleteButtons[0]?.disabled).toBe(true);
    expect(deleteButtons[0]?.textContent).toBe('Deleting…');
    expect(deleteButtons[0]?.getAttribute('aria-label')).toContain('Deleting pending capture');
    expect(deleteButtons[0]?.closest('article')?.getAttribute('aria-busy')).toBe('true');
    deleteButtons[0]?.click();
    deleteButtons[1]?.click();
    expect(
      mocks.invoke.mock.calls.filter(([command]) => command === 'delete_pending_scan'),
    ).toHaveLength(2);
    deleteCalls[0]?.resolve();
    await waitFor(() => statusCalls === 2);
    deleteCalls[1]?.resolve();
    await waitFor(() => statusCalls === 3);

    newerRefresh.resolve(status([]));
    await waitFor(() => document.querySelector('#pending-count')?.textContent === '0 pending');
    olderRefresh.resolve(status([firstScan]));
    await settle();
    await settle();

    expect(document.querySelector('#pending-count')?.textContent).toBe('0 pending');
    expect(document.querySelectorAll('.pending-item')).toHaveLength(0);
  });

  it('explains why claimed and completed captures cannot be deleted', async () => {
    const claimed: PendingScan = {
      id: '01909a91-2fd5-77e0-b7e9-962c6f8b57ec',
      createdAt: 1,
      source: 'camera',
      mimeType: 'image/webp',
      bytes: 16,
      mutationId: '319e23de-1648-460e-8a82-a1379428357d',
      state: 'claimed',
      confirmedCardId: 'card-1',
    };
    const completed: PendingScan = {
      ...claimed,
      id: '02909a91-2fd5-77e0-b7e9-962c6f8b57ec',
      mutationId: '419e23de-1648-460e-8a82-a1379428357d',
      state: 'completed',
    };
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'desktop_status') return Promise.resolve(status([claimed, completed]));
      if (command === 'pending_scan_preview_path') {
        return Promise.resolve('/tmp/pending.preview.jpg');
      }
      return Promise.resolve(undefined);
    });

    await import('./main');
    await waitFor(() => document.querySelectorAll('.pending-item').length === 2);
    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.pending-item button'),
    );

    expect(buttons.map((button) => button.textContent)).toEqual([
      'Confirmation pending',
      'Confirmed',
    ]);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    expect(buttons[0]?.getAttribute('aria-label')).toContain('confirmation is pending');
    expect(buttons[1]?.getAttribute('aria-label')).toContain('is confirmed');
    expect(document.querySelectorAll('.pending-state-guidance')[0]?.textContent).toContain(
      'cloud update may still be running',
    );
    buttons.forEach((button) => button.click());
    expect(
      mocks.invoke.mock.calls.filter(([command]) => command === 'delete_pending_scan'),
    ).toHaveLength(0);
  });

  it('refreshes a rejected delete into truthful claimed recovery state', async () => {
    const pending: PendingScan = {
      id: '01909a91-2fd5-77e0-b7e9-962c6f8b57ec',
      createdAt: 1,
      source: 'camera',
      mimeType: 'image/webp',
      bytes: 16,
      mutationId: '319e23de-1648-460e-8a82-a1379428357d',
      state: 'pending',
      confirmedCardId: null,
    };
    const claimed: PendingScan = {
      ...pending,
      state: 'claimed',
      confirmedCardId: 'card-1',
    };
    const deletion = deferred<void>();
    let statusCalls = 0;
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'desktop_status') {
        statusCalls += 1;
        return Promise.resolve(status(statusCalls === 1 ? [pending] : [claimed]));
      }
      if (command === 'pending_scan_preview_path') {
        return Promise.resolve('/tmp/pending.preview.jpg');
      }
      if (command === 'delete_pending_scan') return deletion.promise;
      return Promise.resolve(undefined);
    });

    await import('./main');
    await waitFor(() => document.querySelector('.pending-item button')?.textContent === 'Delete');
    const originalButton = document.querySelector<HTMLButtonElement>('.pending-item button');
    originalButton?.focus();
    originalButton?.click();
    deletion.reject(new Error('The scan was claimed while Delete waited.'));
    await waitFor(
      () => document.querySelector('.pending-item button')?.textContent === 'Confirmation pending',
    );

    const button = document.querySelector<HTMLButtonElement>('.pending-item button');
    const actionStatus = document.querySelector('.pending-action-status');
    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute('aria-describedby')).toContain(actionStatus?.id);
    expect(actionStatus?.textContent).toContain('Couldn’t delete this capture');
    expect(document.querySelector('.pending-state-guidance')?.textContent).toContain(
      'retry the same confirmation from Codex',
    );
    const focusedRow = document.activeElement?.closest<HTMLElement>('.pending-item');
    expect(focusedRow?.dataset.scanId).toBe(claimed.id);
    expect(focusedRow?.getAttribute('aria-labelledby')).toBe(`pending-title-${claimed.id}`);
    expect(focusedRow?.getAttribute('aria-describedby')).toContain(
      `pending-guidance-${claimed.id}`,
    );
    expect(focusedRow?.getAttribute('aria-describedby')).toContain(`pending-action-${claimed.id}`);
  });

  it('moves focus to the next inbox action after a successful delete', async () => {
    const first: PendingScan = {
      id: '01909a91-2fd5-77e0-b7e9-962c6f8b57ec',
      createdAt: 1,
      source: 'file',
      mimeType: 'image/webp',
      bytes: 16,
      mutationId: '319e23de-1648-460e-8a82-a1379428357d',
      state: 'pending',
      confirmedCardId: null,
    };
    const second: PendingScan = {
      ...first,
      id: '02909a91-2fd5-77e0-b7e9-962c6f8b57ec',
      mutationId: '419e23de-1648-460e-8a82-a1379428357d',
    };
    let statusCalls = 0;
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'desktop_status') {
        statusCalls += 1;
        return Promise.resolve(status(statusCalls === 1 ? [first, second] : [second]));
      }
      if (command === 'pending_scan_preview_path') {
        return Promise.resolve('/tmp/pending.preview.jpg');
      }
      return Promise.resolve(undefined);
    });

    await import('./main');
    await waitFor(() => document.querySelectorAll('.pending-item button').length === 2);
    const firstButton = document.querySelector<HTMLButtonElement>('.pending-item button');
    firstButton?.focus();
    firstButton?.click();
    await waitFor(() => document.querySelectorAll('.pending-item button').length === 1);

    const remaining = document.querySelector<HTMLButtonElement>('.pending-item button');
    expect(document.activeElement).toBe(remaining);
    expect(remaining?.closest<HTMLElement>('.pending-item')?.dataset.scanId).toBe(second.id);
  });

  it('does not restore old delete focus after the user moves to Settings', async () => {
    const first: PendingScan = {
      id: '01909a91-2fd5-77e0-b7e9-962c6f8b57ec',
      createdAt: 1,
      source: 'file',
      mimeType: 'image/webp',
      bytes: 16,
      mutationId: '319e23de-1648-460e-8a82-a1379428357d',
      state: 'pending',
      confirmedCardId: null,
    };
    const second: PendingScan = {
      ...first,
      id: '02909a91-2fd5-77e0-b7e9-962c6f8b57ec',
      mutationId: '419e23de-1648-460e-8a82-a1379428357d',
    };
    const deletion = deferred<void>();
    let statusCalls = 0;
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'desktop_status') {
        statusCalls += 1;
        return Promise.resolve(status(statusCalls === 1 ? [first, second] : [second]));
      }
      if (command === 'pending_scan_preview_path') {
        return Promise.resolve('/tmp/pending.preview.jpg');
      }
      if (command === 'delete_pending_scan') return deletion.promise;
      return Promise.resolve(undefined);
    });

    await import('./main');
    await waitFor(() => document.querySelectorAll('.pending-item button').length === 2);
    const firstButton = document.querySelector<HTMLButtonElement>('.pending-item button');
    const settingsButton = document.querySelector<HTMLButtonElement>('#open-pairing');
    firstButton?.focus();
    firstButton?.click();
    settingsButton?.focus();
    deletion.resolve();
    await waitFor(() => document.querySelectorAll('.pending-item button').length === 1);

    expect(document.activeElement).toBe(settingsButton);
  });

  it.each(['success', 'failure'])(
    'carries %s focus intent from a stale action refresh to the accepted newer refresh',
    async (outcome) => {
      const first: PendingScan = {
        id: '01909a91-2fd5-77e0-b7e9-962c6f8b57ec',
        createdAt: 1,
        source: 'file',
        mimeType: 'image/webp',
        bytes: 16,
        mutationId: '319e23de-1648-460e-8a82-a1379428357d',
        state: 'pending',
        confirmedCardId: null,
      };
      const second: PendingScan = {
        ...first,
        id: '02909a91-2fd5-77e0-b7e9-962c6f8b57ec',
        mutationId: '419e23de-1648-460e-8a82-a1379428357d',
      };
      const claimed: PendingScan = {
        ...first,
        state: 'claimed',
        confirmedCardId: 'card-1',
      };
      const deletion = deferred<void>();
      const actionRefresh = deferred<DesktopStatus>();
      const newerRefresh = deferred<DesktopStatus>();
      let statusCalls = 0;
      mocks.invoke.mockImplementation((command: string) => {
        if (command === 'desktop_status') {
          statusCalls += 1;
          if (statusCalls === 1) return Promise.resolve(status([first, second]));
          return statusCalls === 2 ? actionRefresh.promise : newerRefresh.promise;
        }
        if (command === 'pending_scan_preview_path') {
          return Promise.resolve('/tmp/pending.preview.jpg');
        }
        if (command === 'delete_pending_scan') return deletion.promise;
        return Promise.resolve(undefined);
      });

      await import('./main');
      await waitFor(() => document.querySelectorAll('.pending-item button').length === 2);
      const firstButton = document.querySelector<HTMLButtonElement>('.pending-item button');
      firstButton?.focus();
      firstButton?.click();
      if (outcome === 'success') deletion.resolve();
      else deletion.reject(new Error('claimed while waiting'));
      await waitFor(() => statusCalls === 2);
      document
        .querySelector<HTMLFormElement>('#settings-form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await waitFor(() => statusCalls === 3);
      newerRefresh.resolve(status(outcome === 'success' ? [second] : [claimed, second]));
      await waitFor(
        () => document.querySelectorAll('.pending-item').length === (outcome === 'success' ? 1 : 2),
      );

      const expectedScan = outcome === 'success' ? second.id : first.id;
      expect(document.activeElement?.closest<HTMLElement>('.pending-item')?.dataset.scanId).toBe(
        expectedScan,
      );
      const acceptedFocus = document.activeElement;
      actionRefresh.resolve(status(outcome === 'success' ? [] : [first, second]));
      if (outcome === 'success') await waitFor(() => statusCalls === 4);
      await settle();
      await settle();
      expect(document.activeElement?.closest<HTMLElement>('.pending-item')?.dataset.scanId).toBe(
        expectedScan,
      );
      if (outcome === 'failure') expect(document.activeElement).toBe(acceptedFocus);
    },
  );

  it.each(['success', 'failure'])(
    'preserves %s focus when an unrelated accepted refresh finishes before Delete settles',
    async (outcome) => {
      const first: PendingScan = {
        id: '01909a91-2fd5-77e0-b7e9-962c6f8b57ec',
        createdAt: 1,
        source: 'file',
        mimeType: 'image/webp',
        bytes: 16,
        mutationId: '319e23de-1648-460e-8a82-a1379428357d',
        state: 'pending',
        confirmedCardId: null,
      };
      const second: PendingScan = {
        ...first,
        id: '02909a91-2fd5-77e0-b7e9-962c6f8b57ec',
        mutationId: '419e23de-1648-460e-8a82-a1379428357d',
      };
      const claimed: PendingScan = {
        ...first,
        state: 'claimed',
        confirmedCardId: 'card-1',
      };
      const deletion = deferred<void>();
      let statusCalls = 0;
      mocks.invoke.mockImplementation((command: string) => {
        if (command === 'desktop_status') {
          statusCalls += 1;
          if (statusCalls < 3) return Promise.resolve(status([first, second]));
          return Promise.resolve(status(outcome === 'success' ? [second] : [claimed, second]));
        }
        if (command === 'pending_scan_preview_path') {
          return Promise.resolve('/tmp/pending.preview.jpg');
        }
        if (command === 'delete_pending_scan') return deletion.promise;
        return Promise.resolve(undefined);
      });

      await import('./main');
      await waitFor(() => document.querySelectorAll('.pending-item button').length === 2);
      const firstButton = document.querySelector<HTMLButtonElement>('.pending-item button');
      firstButton?.focus();
      firstButton?.click();
      document
        .querySelector<HTMLFormElement>('#settings-form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await waitFor(() => statusCalls === 2);
      expect(document.activeElement?.closest<HTMLElement>('.pending-item')?.dataset.scanId).toBe(
        first.id,
      );

      if (outcome === 'success') deletion.resolve();
      else deletion.reject(new Error('claimed while waiting'));
      await waitFor(() => statusCalls === 3);
      const expectedScan = outcome === 'success' ? second.id : first.id;
      await waitFor(
        () =>
          document.activeElement?.closest<HTMLElement>('.pending-item')?.dataset.scanId ===
          expectedScan,
      );
    },
  );

  it('keeps deletion success when only the first post-delete refresh rejects', async () => {
    const scan: PendingScan = {
      id: '01909a91-2fd5-77e0-b7e9-962c6f8b57ec',
      createdAt: 1,
      source: 'file',
      mimeType: 'image/webp',
      bytes: 16,
      mutationId: '319e23de-1648-460e-8a82-a1379428357d',
      state: 'pending',
      confirmedCardId: null,
    };
    let statusCalls = 0;
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'desktop_status') {
        statusCalls += 1;
        if (statusCalls === 1) return Promise.resolve(status([scan]));
        if (statusCalls === 2) return Promise.reject(new Error('Status temporarily unavailable.'));
        return Promise.resolve(status([]));
      }
      if (command === 'pending_scan_preview_path') {
        return Promise.resolve('/tmp/pending.preview.jpg');
      }
      return Promise.resolve(undefined);
    });

    await import('./main');
    await waitFor(() => document.querySelector('.pending-item button')?.textContent === 'Delete');
    document.querySelector<HTMLButtonElement>('.pending-item button')?.click();
    await waitFor(
      () => statusCalls === 3 && document.querySelectorAll('.pending-item').length === 0,
    );

    expect(document.querySelector('#notice')?.textContent).toBe('Local capture deleted.');
    expect(document.querySelector('#notice')?.textContent).not.toContain('Couldn’t delete');
  });

  it('retries when a stale delete refresh resolves after its superseding refresh rejects', async () => {
    const first: PendingScan = {
      id: '01909a91-2fd5-77e0-b7e9-962c6f8b57ec',
      createdAt: 1,
      source: 'file',
      mimeType: 'image/webp',
      bytes: 16,
      mutationId: '319e23de-1648-460e-8a82-a1379428357d',
      state: 'pending',
      confirmedCardId: null,
    };
    const second: PendingScan = {
      ...first,
      id: '02909a91-2fd5-77e0-b7e9-962c6f8b57ec',
      mutationId: '419e23de-1648-460e-8a82-a1379428357d',
    };
    const deleteRefresh = deferred<DesktopStatus>();
    const supersedingRefresh = deferred<DesktopStatus>();
    let statusCalls = 0;
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'desktop_status') {
        statusCalls += 1;
        if (statusCalls === 1) return Promise.resolve(status([first, second]));
        if (statusCalls === 2) return deleteRefresh.promise;
        if (statusCalls === 3) return supersedingRefresh.promise;
        return Promise.resolve(status([second]));
      }
      if (command === 'pending_scan_preview_path') {
        return Promise.resolve('/tmp/pending.preview.jpg');
      }
      return Promise.resolve(undefined);
    });

    await import('./main');
    await waitFor(() => document.querySelectorAll('.pending-item button').length === 2);
    document.querySelector<HTMLButtonElement>('.pending-item button')?.click();
    await waitFor(() => statusCalls === 2);
    document
      .querySelector<HTMLFormElement>('#settings-form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => statusCalls === 3);
    supersedingRefresh.reject(new Error('Superseding refresh failed.'));
    deleteRefresh.resolve(status([second]));
    await waitFor(
      () => statusCalls === 4 && document.querySelectorAll('.pending-item').length === 1,
    );

    expect(document.querySelector('.pending-item button')?.textContent).toBe('Delete');
    expect(document.querySelector('#notice')?.textContent).toBe('Superseding refresh failed.');
    expect(document.querySelector('#notice')?.textContent).not.toContain('Local capture deleted');
  });

  it('distinguishes deletion success when the inbox cannot be reloaded', async () => {
    const scan: PendingScan = {
      id: '01909a91-2fd5-77e0-b7e9-962c6f8b57ec',
      createdAt: 1,
      source: 'file',
      mimeType: 'image/webp',
      bytes: 16,
      mutationId: '319e23de-1648-460e-8a82-a1379428357d',
      state: 'pending',
      confirmedCardId: null,
    };
    let statusCalls = 0;
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'desktop_status') {
        statusCalls += 1;
        if (statusCalls === 1) return Promise.resolve(status([scan]));
        return Promise.reject(new Error('Status unavailable.'));
      }
      if (command === 'pending_scan_preview_path') {
        return Promise.resolve('/tmp/pending.preview.jpg');
      }
      return Promise.resolve(undefined);
    });

    await import('./main');
    await waitFor(() => document.querySelector('.pending-item button')?.textContent === 'Delete');
    document.querySelector<HTMLButtonElement>('.pending-item button')?.click();
    await waitFor(() => statusCalls === 4);

    expect(document.querySelector('#notice')?.textContent).toContain(
      'Capture deleted, but inbox refresh failed.',
    );
    expect(document.querySelector('#notice')?.textContent).not.toContain('Couldn’t delete');
    expect(document.querySelector<HTMLButtonElement>('.pending-item button')?.disabled).toBe(true);
  });

  it('keeps the newest concurrent action outcome in the global live region', async () => {
    const first: PendingScan = {
      id: '01909a91-2fd5-77e0-b7e9-962c6f8b57ec',
      createdAt: 1,
      source: 'file',
      mimeType: 'image/webp',
      bytes: 16,
      mutationId: '319e23de-1648-460e-8a82-a1379428357d',
      state: 'pending',
      confirmedCardId: null,
    };
    const second: PendingScan = {
      ...first,
      id: '02909a91-2fd5-77e0-b7e9-962c6f8b57ec',
      mutationId: '419e23de-1648-460e-8a82-a1379428357d',
    };
    const firstDelete = deferred<void>();
    const secondDelete = deferred<void>();
    let statusCalls = 0;
    mocks.invoke.mockImplementation((command: string, input?: { scanId?: string }) => {
      if (command === 'desktop_status') {
        statusCalls += 1;
        return Promise.resolve(status(statusCalls < 3 ? [first, second] : [second]));
      }
      if (command === 'pending_scan_preview_path') {
        return Promise.resolve('/tmp/pending.preview.jpg');
      }
      if (command === 'delete_pending_scan') {
        return input?.scanId === first.id ? firstDelete.promise : secondDelete.promise;
      }
      return Promise.resolve(undefined);
    });

    await import('./main');
    await waitFor(() => document.querySelectorAll('.pending-item button').length === 2);
    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.pending-item button'),
    );
    buttons[0]?.click();
    buttons[1]?.click();
    secondDelete.reject(new Error('Scan B could not be deleted.'));
    await waitFor(() =>
      Boolean(document.querySelector('#notice')?.textContent?.includes('Scan B')),
    );
    firstDelete.resolve();
    await waitFor(() => statusCalls === 3);
    await settle();

    expect(document.querySelector('#notice')?.textContent).toContain(
      'Scan B could not be deleted.',
    );
    expect(document.querySelector('.pending-action-status')?.textContent).toContain('Scan B');
  });

  it('renders one local fallback when a lazy preview command rejects', async () => {
    const scan: PendingScan = {
      id: '01909a91-2fd5-77e0-b7e9-962c6f8b57ec',
      createdAt: 1,
      source: 'file',
      mimeType: 'image/webp',
      bytes: 16,
      mutationId: '319e23de-1648-460e-8a82-a1379428357d',
      state: 'pending',
      confirmedCardId: null,
    };
    const unhandled = vi.fn((event: PromiseRejectionEvent) => event.preventDefault());
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    window.addEventListener('unhandledrejection', unhandled);
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'desktop_status') return Promise.resolve(status([scan]));
      if (command === 'pending_scan_preview_path')
        return Promise.reject(new Error('Preview path unavailable.'));
      return Promise.resolve(undefined);
    });

    await import('./main');
    await waitFor(
      () => document.querySelector('.pending-preview-status')?.textContent === 'No preview',
    );
    await settle();

    const previewStatus = document.querySelector('.pending-preview-status');
    const image = document.querySelector<HTMLImageElement>('.pending-preview img');
    expect(document.querySelectorAll('.pending-preview-status')).toHaveLength(1);
    expect(previewStatus?.getAttribute('role')).toBe('status');
    expect(previewStatus?.getAttribute('aria-hidden')).toBeNull();
    expect(image?.dataset.state).toBe('error');
    expect(document.querySelector('#notice')?.textContent).toBe('');
    expect(unhandled).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith('Pending preview unavailable.', {
      event: 'pending_preview_failed',
      scanId: scan.id,
      phase: 'native-command',
      errorClass: 'Error',
    });
    window.removeEventListener('unhandledrejection', unhandled);
    warning.mockRestore();
  });

  it('replaces an asset load error with the same local fallback', async () => {
    const scan: PendingScan = {
      id: '01909a91-2fd5-77e0-b7e9-962c6f8b57ec',
      createdAt: 1,
      source: 'camera',
      mimeType: 'image/webp',
      bytes: 16,
      mutationId: '319e23de-1648-460e-8a82-a1379428357d',
      state: 'pending',
      confirmedCardId: null,
    };
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'desktop_status') return Promise.resolve(status([scan]));
      if (command === 'pending_scan_preview_path')
        return Promise.resolve('/tmp/pending.preview.jpg');
      return Promise.resolve(undefined);
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await import('./main');
    await waitFor(
      () => document.querySelector<HTMLImageElement>('.pending-preview img')?.src !== '',
    );
    const image = document.querySelector<HTMLImageElement>('.pending-preview img');
    image?.dispatchEvent(new Event('error'));

    expect(document.querySelector('.pending-preview-status')?.textContent).toBe('No preview');
    expect(image?.dataset.state).toBe('error');
    expect(document.querySelector('#notice')?.textContent).toBe('');
    expect(warning).toHaveBeenCalledWith('Pending preview unavailable.', {
      event: 'pending_preview_failed',
      scanId: scan.id,
      phase: 'asset-load',
      errorClass: 'Error',
    });
    warning.mockRestore();
  });
});
