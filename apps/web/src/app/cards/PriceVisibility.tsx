import { createContext, useContext, type ReactElement, type ReactNode } from 'react';
import { useMe } from '../api/queries/people';

// Prices show unless an admin has hidden them for this person (a child's account, say).
const PriceVisibilityContext = createContext(true);

/** Whether this person sees prices anywhere: card frames, the card panel, Home. */
export function useShowPrices(): boolean {
  return useContext(PriceVisibilityContext);
}

/** Reads the signed-in person's setting once for every screen under it. Until it has
 * loaded, prices stay hidden, so a hidden price never flashes up first. */
export function PriceVisibilityProvider({ children }: { children: ReactNode }): ReactElement {
  const me = useMe();
  return (
    <PriceVisibilityContext.Provider value={me.data?.showPrices === true}>
      {children}
    </PriceVisibilityContext.Provider>
  );
}

/** Sets the switch directly, for rendering a frame outside the signed-in shell. */
export const PriceVisibilityContextForTests = PriceVisibilityContext.Provider;
