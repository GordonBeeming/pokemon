import { useQuery, useQueryClient } from '@tanstack/react-query';
import { GALLERY_PAGE_SIZE } from '@pokedex/shared';

/** Keeps revealed items when a gallery is revisited after opening a card. */
export function useInfiniteWindow<T>(
  items: readonly T[],
  scope: string,
  batchSize = GALLERY_PAGE_SIZE,
) {
  const client = useQueryClient();
  const key = ['visible-list', scope];
  const counter = useQuery({
    queryKey: key,
    queryFn: () => batchSize,
    initialData: batchSize,
    enabled: false,
    gcTime: 60 * 60_000,
  });
  function loadMore() {
    client.setQueryData<number>(key, (count) => (count ?? batchSize) + batchSize);
  }
  return { items: items.slice(0, counter.data), hasMore: counter.data < items.length, loadMore };
}
