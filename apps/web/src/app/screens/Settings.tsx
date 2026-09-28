import type { ReactElement } from 'react';
import type { SettingsSearch } from '../routes/search-params';

// Placeholder route component — wave 2 replaces this with the real Settings screen.
export function Settings({ search }: { search: SettingsSearch }): ReactElement {
  return (
    <section>
      <h1>Settings</h1>
      <pre>{JSON.stringify(search, null, 2)}</pre>
    </section>
  );
}
