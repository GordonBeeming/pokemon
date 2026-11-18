import { createRoute, useNavigate } from '@tanstack/react-router';
import { z } from 'zod';
import { authedRoute } from './authed-layout';
import { Wanted } from '../screens/Wanted';
export const wantedSearchSchema = z.object({
  scope: z.string().min(1).max(128).catch('all'),
  includeUnfilled: z.boolean().catch(false),
  q: z.string().max(200).catch(''),
  sort: z.enum(['name', 'newest', 'pokedex', 'set']).catch('name'),
  offset: z.number().int().min(0).max(1000000).catch(0),
});
export const wantedRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/wanted',
  validateSearch: (search) => wantedSearchSchema.parse(search),
  component: function WantedRoute() {
    const navigate = useNavigate();
    return (
      <Wanted
        search={wantedRoute.useSearch()}
        onSearch={(search) => void navigate({ to: '/wanted', search, replace: true })}
      />
    );
  },
});
