import type { ReactElement } from 'react';
import type { SetsSearch } from '../routes/search-params';

// Placeholder route component — wave 2 replaces this with the real Sets & codes screen.
export function Sets({ search }: { search: SetsSearch }): ReactElement {
  return (
    <section>
      <h1>Sets &amp; codes</h1>
      <pre>{JSON.stringify(search, null, 2)}</pre>
    </section>
  );
}
