import { createRoute } from '@tanstack/react-router';
import { Card } from '../screens/Card';
import { authedRoute } from './authed-layout';

export const cardRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/card/$cardId',
  component: () => <Card cardId={cardRoute.useParams().cardId} />,
});
