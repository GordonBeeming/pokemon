export const CATALOGUE_FETCH_CHUNK_SIZE = 40;

export function catalogueRequestChunks<T>(values: readonly T[]): T[][] {
  const chunks: T[][] = [];
  for (let offset = 0; offset < values.length; offset += CATALOGUE_FETCH_CHUNK_SIZE) {
    chunks.push(values.slice(offset, offset + CATALOGUE_FETCH_CHUNK_SIZE));
  }
  return chunks;
}
