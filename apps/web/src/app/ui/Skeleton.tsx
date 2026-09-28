import type { ReactElement } from 'react';
import './primitives.css';

/** aria-hidden: a skeleton is a visual placeholder, not content — the screen's own
 * route-scoped live region (see Toast.tsx) is what tells assistive tech it's loading. */
export function Skeleton({
  width,
  height,
  radius = '0.5rem',
}: {
  width?: string | number;
  height: string | number;
  radius?: string;
}): ReactElement {
  return (
    <span className="skeleton" aria-hidden="true" style={{ width, height, borderRadius: radius }} />
  );
}

export function CardFrameSkeleton(): ReactElement {
  return (
    <div className="skeleton-card" aria-hidden="true">
      <Skeleton height="0.9rem" width="60%" />
      <span className="skeleton skeleton-card-art" />
      <Skeleton height="0.9rem" width="70%" />
    </div>
  );
}
