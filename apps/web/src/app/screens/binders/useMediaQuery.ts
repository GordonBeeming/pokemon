import { useSyncExternalStore } from 'react';

export const PHONE_QUERY = '(max-width: 767px)';
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function matches(query: string): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(query).matches
    : false;
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function')
        return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener('change', listener);
      return () => list.removeEventListener('change', listener);
    },
    () => matches(query),
    () => false,
  );
}
