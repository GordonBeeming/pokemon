import { createRoute, useNavigate } from '@tanstack/react-router';
import { InviteLanding } from '../screens/invite/InviteLanding';
import { rootRoute } from './root';

// A sibling of the authed layout, not a child: an invite is opened by someone who
// isn't signed in yet, so it must never sit behind the session gate.
export const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/invite/$token',
  component: function InviteRoute() {
    const { token } = inviteRoute.useParams();
    const navigate = useNavigate();
    return <InviteLanding token={token} onJoined={() => void navigate({ to: '/' })} />;
  },
});
