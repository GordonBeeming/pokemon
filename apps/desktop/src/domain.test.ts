import { describe, expect, it, vi } from 'vitest';
import {
  captureCameraFrame,
  imageDataUrl,
  importCapture,
  pairingPageUrl,
  redactedMcpConfigSnippet,
  type SaveCapture,
} from './domain';

const pending = {
  id: '01909a91-2fd5-77e0-b7e9-962c6f8b57ec',
  createdAt: 1,
  source: 'file' as const,
  mimeType: 'image/webp',
  bytes: 4,
  mutationId: '319e23de-1648-460e-8a82-a1379428357d',
  state: 'pending' as const,
  confirmedCardId: null,
};

describe('capture workflows', () => {
  it('passes a headless file input to the local pending inbox', async () => {
    const save = vi.fn<SaveCapture>().mockResolvedValue(pending);
    const input = {
      type: 'image/webp',
      size: 4,
      arrayBuffer: () => Promise.resolve(Uint8Array.from([82, 73, 70, 70]).buffer),
    };

    const preview = Uint8Array.from([255, 216, 255, 217]);
    await expect(importCapture(input, preview, save)).resolves.toEqual(pending);
    expect(save).toHaveBeenCalledWith([82, 73, 70, 70], 'image/webp', 'file', Array.from(preview));
  });

  it('passes a mocked camera frame to the same local pending inbox', async () => {
    const save = vi.fn<SaveCapture>().mockResolvedValue({ ...pending, source: 'camera' });

    await captureCameraFrame(
      () =>
        Promise.resolve({
          mimeType: 'image/jpeg',
          bytes: Uint8Array.from([255, 216, 255]),
          previewBytes: Uint8Array.from([255, 216, 255, 217]),
        }),
      save,
    );

    expect(save).toHaveBeenCalledWith(
      [255, 216, 255],
      'image/jpeg',
      'camera',
      [255, 216, 255, 217],
    );
  });

  it('rejects unsupported files before invoking native storage', async () => {
    const save = vi.fn<SaveCapture>().mockResolvedValue(pending);
    const input = {
      type: 'application/pdf',
      size: 4,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
    };

    await expect(importCapture(input, Uint8Array.from([255, 216, 255, 217]), save)).rejects.toThrow(
      'Choose a JPEG',
    );
    expect(save).not.toHaveBeenCalled();
  });
});

describe('pending image data', () => {
  it('creates a safe local data URL for MCP-equivalent image data', () => {
    expect(
      imageDataUrl({
        id: pending.id,
        mimeType: 'image/webp',
        data: 'UklGRgQAAABXRUJQZGF0YQ==',
      }),
    ).toBe('data:image/webp;base64,UklGRgQAAABXRUJQZGF0YQ==');
  });
});

describe('pairing page URL', () => {
  it('opens the production Devices view from the cloud origin', () => {
    expect(pairingPageUrl('https://pokedex.gordonbeeming.com')).toBe(
      'https://pokedex.gordonbeeming.com/#devices',
    );
  });

  it('keeps loopback pairing on the configured development origin', () => {
    expect(pairingPageUrl('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787/#devices');
  });
});

describe('MCP configuration display', () => {
  it('masks the bearer token without changing the copyable configuration source', () => {
    const source =
      '[mcp_servers.pokedex]\nurl = "http://127.0.0.1:47837/mcp"\nhttp_headers = { Authorization = "Bearer secret-token" }';

    expect(redactedMcpConfigSnippet(source)).toContain('Bearer ••••••••');
    expect(redactedMcpConfigSnippet(source)).not.toContain('secret-token');
    expect(source).toContain('secret-token');
  });
});
