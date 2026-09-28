import type { IconName } from '../ui/icons';

export interface NavItem {
  to: string;
  label: string;
  icon: IconName;
}

// Paths are relative to the router's basepath (APP_BASEPATH), so cutover to '/'
// never touches this list.
export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Home', icon: 'home' },
  { to: '/catalogue', label: 'Catalogue', icon: 'catalogue' },
  { to: '/pokedex', label: 'Pokédex', icon: 'pokedex' },
  { to: '/binders', label: 'Binders', icon: 'binder' },
  { to: '/sets', label: 'Sets', icon: 'sets' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
];
