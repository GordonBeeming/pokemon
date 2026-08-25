import { ApplicationError } from './log';

export const MAX_API_JSON_BYTES = 2 * 1024 * 1024;
export const MAX_AUTH_JSON_BYTES = 256 * 1024;

export async function boundedJson(
  request: Request,
  maximumBytes = MAX_API_JSON_BYTES,
): Promise<unknown> {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isInteger(length) || length < 0)
      throw new ApplicationError('invalid_content_length', 400);
    if (length > maximumBytes) throw new ApplicationError('request_too_large', 413);
  }
  if (!request.body) throw new ApplicationError('invalid_json', 400);
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel('JSON body exceeded maximum size');
      throw new ApplicationError('request_too_large', 413);
    }
    text += decoder.decode(next.value, { stream: true });
  }
  text += decoder.decode();
  try {
    return JSON.parse(text);
  } catch {
    throw new ApplicationError('invalid_json', 400);
  }
}
