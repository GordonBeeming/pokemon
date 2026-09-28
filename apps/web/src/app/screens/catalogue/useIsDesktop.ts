import { useSyncExternalStore } from 'react';

// Matches the shell's own rail/tabbar breakpoint (shell.css's `min-width: 768px`),
// so "desktop chrome vs phone chrome" always agrees with what the nav is already
// showing rather than picking its own threshold.
const QUERY = '(min-width: 768px)';

function subscribe(listener: () => void): () => void {
  const mql = matchMedia(QUERY);
  mql.addEventListener('change', listener);
  return () => mql.removeEventListener('change', listener);
}

function getSnapshot(): boolean {
  return matchMedia(QUERY).matches;
}

/** Picks SidePanel vs Sheet chrome for a surface FEATURES.md describes differently
 * by viewport (Catalogue's filters, in particular) — reactive, so rotating a
 * tablet across the breakpoint swaps the chrome without a reload. */
export function useIsDesktop(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => true);
}
