import type { ReactElement } from 'react';

export function LoadingOverlay({ message }: { message: string }): ReactElement {
  return (
    <div className="loading-overlay" role="status" aria-live="polite" aria-atomic="true">
      <span className="pokeball-loader" aria-hidden="true">
        <span />
      </span>
      <strong>{message}</strong>
      <span>The cards will appear here as soon as they are ready.</span>
    </div>
  );
}
