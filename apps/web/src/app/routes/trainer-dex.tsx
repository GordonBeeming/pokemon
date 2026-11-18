import { TRAINER_REGIONS } from '@pokedex/shared';
import { createRoute, useNavigate } from '@tanstack/react-router';
import { z } from 'zod';
import { authedRoute } from './authed-layout';
import { TrainerDex } from '../screens/TrainerDex';
export const trainerDexSearch = z.object({
  q: z.string().max(200).catch(''),
  region: z.enum(['all', ...TRAINER_REGIONS]).catch('all'),
  available: z.boolean().catch(true),
  page: z.number().int().min(1).catch(1),
});
export type TrainerDexSearch = z.infer<typeof trainerDexSearch>;
export const trainerDexRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/trainer-dex',
  validateSearch: (search) => trainerDexSearch.parse(search),
  component: function TrainerDexPage() {
    const navigate = useNavigate();
    return (
      <TrainerDex
        search={trainerDexRoute.useSearch()}
        onSearch={(search) => void navigate({ to: '/trainer-dex', search, replace: true })}
      />
    );
  },
});
