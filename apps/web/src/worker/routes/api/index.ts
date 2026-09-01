import { Hono } from 'hono';
import type { AuthVars } from '../../lib/types';
import { browserApiRoutes } from './browser';
import { desktopApiRoutes } from './desktop';
import { publicApiRoutes } from './public';

const api = new Hono<{ Bindings: CloudflareEnv; Variables: AuthVars }>();
api.route('/', publicApiRoutes);
api.route('/', desktopApiRoutes);
api.route('/', browserApiRoutes);

export { api as apiRoutes };
export {
  arrangementBody,
  binderFullPokedexPreviewSchema,
  binderPlannerSummarySchema,
  pageOrderBody,
  parseDesktopBearer,
} from './contracts';
