import type { ReactElement } from 'react';

export function OwnershipMark({ quantity }: { quantity: number }): ReactElement {
  const owned = quantity > 0;
  const label = owned
    ? `${quantity} ${quantity === 1 ? 'copy' : 'copies'} owned`
    : 'Missing from collection';
  return (
    <span
      className={owned ? 'ownership-mark owned' : 'ownership-mark'}
      aria-label={label}
      title={label}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        {owned ? (
          <path d="m6.6 12.4 3.4 3.5 7.6-8" />
        ) : (
          <>
            <circle cx="12" cy="12" r="7" />
            <path d="M8.5 12h7" />
          </>
        )}
      </svg>
      {quantity > 1 ? <strong>{quantity}</strong> : null}
    </span>
  );
}
