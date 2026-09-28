import { createRouter } from '@tanstack/react-router';
import { APP_BASEPATH } from './lib/constants';
import { authedRoute } from './routes/authed-layout';
import { binderDetailRoute, bindersRoute } from './routes/binders';
import { cardRoute } from './routes/card';
import { catalogueRoute } from './routes/catalogue';
import { indexRoute } from './routes/index';
import { inviteRoute } from './routes/invite';
import { pokedexRoute } from './routes/pokedex';
import { rootRoute } from './routes/root';
import { settingsRoute } from './routes/settings';
import { setsRoute } from './routes/sets';

const authedTree = authedRoute.addChildren([
  indexRoute,
  catalogueRoute,
  cardRoute,
  pokedexRoute,
  setsRoute,
  bindersRoute,
  binderDetailRoute,
  settingsRoute,
]);

// The dev card gallery never ships in a production bundle and never sits behind the
// session gate (see authed-layout.tsx) — it's a sibling of that layout, not a child.
const devRoutes = import.meta.env.DEV ? [(await import('./routes/frames')).framesRoute] : [];

export const routeTree = rootRoute.addChildren([authedTree, inviteRoute, ...devRoutes]);

export const router = createRouter({
  routeTree,
  basepath: APP_BASEPATH,
  defaultPreload: 'intent',
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
