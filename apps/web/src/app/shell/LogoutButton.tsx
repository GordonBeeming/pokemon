import type { ReactElement, ReactNode } from 'react';
import { useLogout } from '../api/queries/session';
import { useToast } from '../ui/Toast';

const LOGOUT_FAILED = 'Log out could not be completed. You are still signed in, so try again.';

export function LogoutButton({
  className,
  icon,
}: {
  className?: string;
  icon?: ReactNode;
}): ReactElement {
  const logout = useLogout();
  const toast = useToast();
  return (
    <button
      type="button"
      className={className}
      disabled={logout.isPending}
      aria-busy={logout.isPending}
      onClick={() => logout.mutate(undefined, { onError: () => toast('error', LOGOUT_FAILED) })}
    >
      {icon}
      <span>{logout.isPending ? 'Logging out…' : 'Log out'}</span>
    </button>
  );
}
