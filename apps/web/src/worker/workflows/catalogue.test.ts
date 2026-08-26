import { describe, expect, it } from 'vitest';
import { CATALOGUE_FETCH_CHUNK_SIZE, catalogueRequestChunks } from './catalogue-batching';

describe('catalogue workflow request batching', () => {
  it('keeps every outbound-fetch step below the Worker subrequest limit', () => {
    const chunks = catalogueRequestChunks(Array.from({ length: 101 }, (_, index) => index));

    expect(CATALOGUE_FETCH_CHUNK_SIZE).toBe(40);
    expect(chunks.map((chunk) => chunk.length)).toEqual([40, 40, 21]);
    expect(chunks.every((chunk) => chunk.length <= 40)).toBe(true);
    expect(chunks.flat()).toEqual(Array.from({ length: 101 }, (_, index) => index));
  });
});
