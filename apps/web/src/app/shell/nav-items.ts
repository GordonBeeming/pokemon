import type { IconName } from '../ui/icons';

export interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  /** The phone tab bar has a fixed 6-column grid with no room for a 7th icon, so
   * this item shows only in the desktop rail. */
  railOnly?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Home', icon: 'home' },
  { to: '/catalogue', label: 'Catalogue', icon: 'catalogue' },
  { to: '/pokedex', label: 'Pokédex', icon: 'pokedex' },
  { to: '/binders', label: 'Binders', icon: 'binder' },
  { to: '/sets', label: 'Sets', icon: 'sets' },
  { to: '/illustrators', label: 'Illustrators', icon: 'illustrator', railOnly: true },
  { to: '/settings', label: 'Settings', icon: 'settings' },
];
