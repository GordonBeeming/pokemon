// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopStatus, PendingScan } from './domain';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  openUrl: vi.fn(),
  writeText: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: mocks.openUrl }));

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  if (!resolve) throw new Error('Deferred promise did not initialise.');
  return { promise, resolve };
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
      if (command === 'pending_scan_image') {
        return Promise.resolve({
          id: firstScan.id,
          mimeType: 'image/webp',
          data: 'UklGRgQAAABXRUJQZGF0YQ==',
        });
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
    deleteButtons[1]?.click();
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
});
