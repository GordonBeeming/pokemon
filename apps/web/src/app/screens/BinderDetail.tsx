import type { ReactElement } from 'react';
import type { BinderSearch } from '../routes/search-params';

// Placeholder route component — wave 2 replaces this with the real binder page view.
export function BinderDetail({
  binderId,
  search,
}: {
  binderId: string;
  search: BinderSearch;
}): ReactElement {
  return (
    <section>
      <h1>Binder {binderId}</h1>
      <pre>{JSON.stringify(search, null, 2)}</pre>
    </section>
  );
}
