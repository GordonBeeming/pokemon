import type { ReactElement } from 'react';
import type { CatalogueSearch } from '../routes/search-params';

// Placeholder route component — wave 2 replaces this with the real Catalogue screen.
export function Catalogue({ search }: { search: CatalogueSearch }): ReactElement {
  return (
    <section>
      <h1>Catalogue</h1>
      <pre>{JSON.stringify(search, null, 2)}</pre>
    </section>
  );
}
