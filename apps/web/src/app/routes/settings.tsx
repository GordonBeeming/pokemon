import { createRoute, useNavigate } from '@tanstack/react-router';
import { Settings } from '../screens/Settings';
import { authedRoute } from './authed-layout';
import { settingsSearch } from './search-params';

export const settingsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/settings',
  validateSearch: settingsSearch.parse,
  component: function SettingsRoute() {
    const navigate = useNavigate();
    return (
      <Settings
        search={settingsRoute.useSearch()}
        onTab={(tab) => void navigate({ to: '/settings', search: { tab } })}
      />
    );
  },
});
