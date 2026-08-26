import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { propagateUploadFailure, validatingWebpStream } from './art';

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 7));
      controller.enqueue(bytes.subarray(7));
      controller.close();
    },
  });
}

async function drain(readable: ReadableStream<Uint8Array>): Promise<void> {
  const reader = readable.getReader();
  while (true) {
    if ((await reader.read()).done) return;
  }
}

describe('streamed art validation', () => {
  it('accepts a valid WebP split across stream chunks', async () => {
    const bytes = new Uint8Array(20);
    bytes.set(new TextEncoder().encode('RIFF'), 0);
    new DataView(bytes.buffer).setUint32(4, 12, true);
    bytes.set(new TextEncoder().encode('WEBPVP8 '), 8);
    const checksum = createHash('sha256').update(bytes).digest('hex');
    await expect(
      drain(validatingWebpStream(stream(bytes), bytes.byteLength, checksum)),
    ).resolves.toBeUndefined();
  });

  it('rejects invalid WebP before storage completion', async () => {
    const bytes = new TextEncoder().encode('not a webp');
    const checksum = createHash('sha256').update(bytes).digest('hex');
    await expect(
      drain(validatingWebpStream(stream(bytes), bytes.byteLength, checksum)),
    ).rejects.toMatchObject({
      code: 'art_upload_not_webp',
      status: 400,
    });
  });

  it('preserves both storage and request-body failures', async () => {
    const storage = new Error('storage failed');
    const body = new Error('body failed');
    await expect(propagateUploadFailure(storage, Promise.reject(body))).rejects.toMatchObject({
      errors: [storage, body],
    });
  });
});
