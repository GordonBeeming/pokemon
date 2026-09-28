import type { ReactElement } from 'react';

// One inline-SVG set for the whole app so every icon shares stroke weight and
// viewBox; screens ask for one by name instead of pasting path data around.
export const ICON_NAMES = [
  'eye',
  'magnifier',
  'move',
  'swap',
  'insert',
  'paste',
  'bookmark',
  'bin',
  'plus',
  'minus',
  'filter',
  'close',
  'chevron-up',
  'chevron-down',
  'chevron-left',
  'chevron-right',
  'binder',
  'catalogue',
  'pokedex',
  'sets',
  'settings',
  'home',
  'copy',
  'key',
  'people',
  'sync',
] as const;
export type IconName = (typeof ICON_NAMES)[number];

const PATHS: Record<IconName, ReactElement> = {
  eye: (
    <>
      <path d="M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  magnifier: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  move: <path d="M12 3v18M3 12h18M7 7l-4 5 4 5M17 7l4 5-4 5M7 17l5 4 5-4M7 7l5-4 5 4" />,
  swap: <path d="m7 4-4 4 4 4M3 8h13M17 20l4-4-4-4M21 16H8" />,
  insert: <path d="M6 3.5v17M11 5h7l-3-3M18 5l-3 3M4 9h4M4 15h4M4 12h6" />,
  paste: (
    <path d="M9 3.5h6v3H9zM6 5.5h3v1a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2v-1h3v15H6zM9.5 13h5M9.5 17h5" />
  ),
  bookmark: <path d="M6 3.5h12v17l-6-4-6 4z" />,
  bin: <path d="M5 7h14M9 7V4.5h6V7M7 7l1 12.5h8L17 7M10 11v5M14 11v5" />,
  plus: <path d="M12 4v16M4 12h16" />,
  minus: <path d="M4 12h16" />,
  filter: <path d="M4 6h16M7 12h10M10 18h4" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  'chevron-up': <path d="m6 15 6-6 6 6" />,
  'chevron-down': <path d="m6 9 6 6 6-6" />,
  'chevron-left': <path d="m15 6-6 6 6 6" />,
  'chevron-right': <path d="m9 6 6 6-6 6" />,
  binder: <path d="M4 4h7v16H4zM13 4h7v16h-7zM7.5 8h1.5" />,
  catalogue: <path d="M7 3.5h8.5l2.5 2.6v14.4H7zM15.5 3.5v3h2.8M9.5 10h6M9.5 13h6M9.5 16h4" />,
  pokedex: <path d="M4 12h16M12 4a8 8 0 1 1-8 8M9.5 12a2.5 2.5 0 1 0 5 0 2.5 2.5 0 0 0-5 0Z" />,
  sets: <path d="m5 7 7-3 7 3-7 3zM5 11l7 3 7-3M5 15l7 3 7-3" />,
  settings: <path d="M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M8 15v4" />,
  home: <path d="M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z" />,
  copy: <path d="M9 9h10v10H9zM6 15H5V5h10v1" />,
  key: (
    <>
      <circle cx="8" cy="15" r="3.5" />
      <path d="m10.5 12.5 8-8M16 6l2 2M13 9l2 2" />
    </>
  ),
  people: (
    <path d="M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3.5 19a5.5 5.5 0 0 1 11 0M17 11a2.5 2.5 0 1 0 0-5M20.5 19a4.5 4.5 0 0 0-4-4.5" />
  ),
  sync: <path d="M4 12a8 8 0 0 1 14-5.3M20 6v5h-5M20 12a8 8 0 0 1-14 5.3M4 18v-5h5" />,
};

export function Icon({
  name,
  className,
  title,
}: {
  name: IconName;
  className?: string;
  title?: string;
}): ReactElement {
  return (
    <svg
      className={className}
      width="1em"
      height="1em"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      {PATHS[name]}
    </svg>
  );
}
