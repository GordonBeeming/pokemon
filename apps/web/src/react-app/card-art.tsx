import { useState, type ReactElement } from 'react';

export function CardArt({
  src,
  highSrc,
  alt,
  className = 'card-art',
  missingClassName = 'card-art-missing',
  missingText = 'Art unavailable',
  eager = false,
  announceLoading = false,
  dimmed = false,
}: {
  src: string | null | undefined;
  highSrc?: string | null;
  alt: string;
  className?: string;
  missingClassName?: string;
  missingText?: string;
  eager?: boolean;
  announceLoading?: boolean;
  dimmed?: boolean;
}): ReactElement {
  const identity = `${src ?? ''}|${highSrc ?? ''}`;
  const [loadedSource, setLoadedSource] = useState<string | null>(null);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const failed = !src || failedSource === identity;
  const loading = Boolean(src) && !failed && loadedSource !== identity;

  return (
    <span
      className={`${className} card-art-frame${failed ? ` ${missingClassName}` : ''}${dimmed ? ' card-art-unowned' : ''}`}
      data-image-state={failed ? 'failed' : loading ? 'loading' : 'loaded'}
      aria-busy={loading || undefined}
      {...(failed && alt ? { role: 'img', 'aria-label': `${alt}. Art unavailable.` } : {})}
    >
      {src && !failed ? (
        <img
          key={identity}
          className={loading ? 'card-art-image awaiting-image' : 'card-art-image'}
          src={src}
          srcSet={highSrc ? `${src} 245w, ${highSrc} 600w` : undefined}
          sizes={highSrc ? '240px' : undefined}
          alt={alt}
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          onLoad={() => setLoadedSource(identity)}
          onError={() => setFailedSource(identity)}
        />
      ) : null}
      {loading ? (
        <span
          className="card-art-loading"
          {...(announceLoading
            ? { role: 'status', 'aria-live': 'polite' as const }
            : { 'aria-hidden': true })}
        >
          <span className="pokeball-loader" aria-hidden="true">
            <span />
          </span>
          {announceLoading ? <span className="sr-only">Loading {alt}</span> : null}
        </span>
      ) : null}
      {failed ? (
        <span className="card-art-fallback" aria-hidden={alt ? 'true' : undefined}>
          {missingText}
        </span>
      ) : null}
    </span>
  );
}
