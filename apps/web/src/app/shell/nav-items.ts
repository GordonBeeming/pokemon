import type { IconName } from '../ui/icons';

export interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  /** A primary shortcut; every destination is also present in the mobile More menu. */
  mobileShortcut?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Home', icon: 'home', mobileShortcut: true },
  { to: '/catalogue', label: 'Catalogue', icon: 'catalogue', mobileShortcut: true },
  { to: '/pokedex', label: 'Pokédex', icon: 'pokedex', mobileShortcut: true },
  { to: '/binders', label: 'Binders', icon: 'binder', mobileShortcut: true },
  { to: '/wanted', label: 'Wanted', icon: 'star' },
  { to: '/sets', label: 'Sets', icon: 'sets', mobileShortcut: true },
  { to: '/illustrators', label: 'Illustrators', icon: 'illustrator' },
  { to: '/trainer-dex', label: 'Trainer Dex', icon: 'people' },
  { to: '/trainers', label: 'Trainer Pokémon', icon: 'card' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
];
