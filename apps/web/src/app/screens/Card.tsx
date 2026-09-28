import type { ReactElement } from 'react';

// Placeholder route component — wave 2 replaces this with the real full card page.
export function Card({ cardId }: { cardId: string }): ReactElement {
  return (
    <section>
      <h1>Card {cardId}</h1>
    </section>
  );
}
