import type { ReactElement } from 'react';
import type { PokedexSearch } from '../routes/search-params';

// Placeholder route component — wave 2 replaces this with the real National Pokédex screen.
export function Pokedex({ search }: { search: PokedexSearch }): ReactElement {
  return (
    <section>
      <h1>National Pokédex</h1>
      <pre>{JSON.stringify(search, null, 2)}</pre>
    </section>
  );
}
