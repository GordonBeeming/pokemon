import { useEffect, useRef, type ReactElement } from 'react';
import './infinite-loader.css';

function scrollRoot(element: HTMLElement): HTMLElement | null {
  for (
    let parent = element.parentElement;
    parent && parent !== document.body;
    parent = parent.parentElement
  ) {
    if (
      /auto|scroll/.test(getComputedStyle(parent).overflowY) &&
      parent.scrollHeight > parent.clientHeight + 1
    )
      return parent;
  }
  return null;
}

/** Observes the list's own scroll surface, including picker dialogs and sheets. */
export function InfiniteLoader({
  hasMore,
  loading,
  error,
  loadedCount,
  onLoadMore,
  label = 'cards',
  paused = false,
}: {
  paused?: boolean;
  hasMore: boolean;
  loading: boolean;
  error?: string | null;
  loadedCount: number;
  onLoadMore: () => void;
  label?: string;
}): ReactElement | null {
  const sentinel = useRef<HTMLDivElement>(null);
  const requested = useRef(false);
  const action = useRef(onLoadMore);
  action.current = onLoadMore;
  useEffect(() => {
    requested.current = false;
  }, [loadedCount, loading, error, hasMore, paused]);
  useEffect(() => {
    const element = sentinel.current;
    if (
      !element ||
      !hasMore ||
      loading ||
      paused ||
      error ||
      typeof IntersectionObserver === 'undefined'
    )
      return;
    let active = true;
    const observer = new IntersectionObserver(
      (entries) => {
        if (active && !requested.current && entries.some((entry) => entry.isIntersecting)) {
          requested.current = true;
          action.current();
        }
      },
      { root: scrollRoot(element), rootMargin: '500px 0px' },
    );
    observer.observe(element);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [hasMore, loading, error, loadedCount, paused]);
  if (!hasMore && !loading) return null;
  return (
    <div className="infinite-loader" ref={sentinel}>
      {loading ? (
        <p role="status">Loading more {label}…</p>
      ) : error ? (
        <>
          <p role="alert">{error}</p>
          <button
            type="button"
            disabled={paused}
            onClick={() => {
              requested.current = true;
              action.current();
            }}
          >
            Retry loading {label}
          </button>
        </>
      ) : (
        <button
          type="button"
          disabled={paused}
          onClick={() => {
            if (!requested.current) {
              requested.current = true;
              action.current();
            }
          }}
        >
          Load more {label}
        </button>
      )}
    </div>
  );
}
