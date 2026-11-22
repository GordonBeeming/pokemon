import { Link, useRouterState } from '@tanstack/react-router';
import { useEffect, useState, type ReactElement } from 'react';
import { Icon } from '../ui/icons';
import { Sheet } from '../ui/Sheet';
import { LogoutButton } from './LogoutButton';
import { NAV_ITEMS, type NavItem } from './nav-items';

export function NavigationLinks({
  items = NAV_ITEMS,
  onNavigate,
}: {
  items?: readonly NavItem[];
  onNavigate?: () => void;
}): ReactElement {
  return (
    <>
      {items.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          className="nav-item"
          activeProps={{ className: 'nav-item nav-item-active', 'aria-current': 'page' }}
          activeOptions={{ exact: item.to === '/' }}
          onClick={onNavigate}
        >
          <Icon name={item.icon} />
          <span>{item.label}</span>
        </Link>
      ))}
    </>
  );
}

/** Shortcuts stay compact; More exposes the same destinations as the desktop rail. */
export function MobileNavigation(): ReactElement {
  const [open, setOpen] = useState(false);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  useEffect(() => setOpen(false), [pathname]);
  const moreActive = NAV_ITEMS.some((item) => !item.mobileShortcut && pathname.startsWith(item.to));
  return (
    <>
      <nav aria-label="Primary" className="app-tabbar">
        <NavigationLinks items={NAV_ITEMS.filter((item) => item.mobileShortcut)} />
        <button
          type="button"
          className={`nav-item mobile-more${open || moreActive ? ' nav-item-active' : ''}`}
          aria-label="More navigation"
          aria-expanded={open}
          aria-current={moreActive ? 'page' : undefined}
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
        >
          <Icon name="more" />
          <span>More</span>
        </button>
      </nav>
      <Sheet open={open} title="All pages" onClose={() => setOpen(false)}>
        <nav className="mobile-navigation" aria-label="All pages">
          <NavigationLinks onNavigate={() => setOpen(false)} />
          <LogoutButton className="nav-item" icon={<Icon name="logout" />} />
        </nav>
      </Sheet>
    </>
  );
}
