import { describe, expect, it } from 'vitest';
import { boundedJson } from './request';

describe('bounded JSON requests', () => {
  it('parses a streamed JSON body within the limit', async () => {
    await expect(
      boundedJson(new Request('https://example.test', { method: 'POST', body: '{"ok":true}' }), 32),
    ).resolves.toEqual({ ok: true });
  });

  it('rejects declared and streamed bodies above the cap', async () => {
    await expect(
      boundedJson(
        new Request('https://example.test', {
          method: 'POST',
          headers: { 'content-length': '100' },
          body: '{}',
        }),
        10,
      ),
    ).rejects.toMatchObject({ code: 'request_too_large', status: 413 });
    await expect(
      boundedJson(
        new Request('https://example.test', { method: 'POST', body: '{"long":"value"}' }),
        8,
      ),
    ).rejects.toMatchObject({ code: 'request_too_large', status: 413 });
  });
});
