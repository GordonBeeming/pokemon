import { createRoute } from '@tanstack/react-router';
import { Pokedex } from '../screens/Pokedex';
import { authedRoute } from './authed-layout';
import { pokedexSearch } from './search-params';

export const pokedexRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/pokedex',
  validateSearch: pokedexSearch.parse,
  component: () => <Pokedex search={pokedexRoute.useSearch()} />,
});
