import { binderSlotLocationSchema, type BinderSlotLocation } from '@pokedex/shared';

export function binderHash(
  versionId: string,
  page: number,
  pocket: BinderSlotLocation | null = null,
): string {
  const params = new URLSearchParams({ version: versionId, page: String(page + 1) });
  if (pocket) {
    params.set('row', String(pocket.row + 1));
    params.set('column', String(pocket.column + 1));
  }
  return `#binders?${params}`;
}
export function parseBinderHash(
  hash: string,
): { versionId: string; page: number; pocket: BinderSlotLocation | null } | null {
  if (!hash.startsWith('#binders?')) return null;
  const params = new URLSearchParams(hash.slice(hash.indexOf('?') + 1));
  const versionId = params.get('version');
  const page = Number(params.get('page') ?? '1') - 1;
  if (!versionId || versionId.length > 128 || !Number.isSafeInteger(page) || page < 0) return null;
  const pocket = binderSlotLocationSchema.safeParse({
    page,
    row: Number(params.get('row')) - 1,
    column: Number(params.get('column')) - 1,
  });
  return { versionId, page, pocket: pocket.success ? pocket.data : null };
}
