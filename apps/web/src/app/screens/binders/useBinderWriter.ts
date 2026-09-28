import { binderCapacityErrorSchema, type BinderSlotLocation } from '@pokedex/shared';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { queryKeys } from '../../api/keys';
import type { BinderMutation, BinderPageView, BinderPageWindow } from '../../api/queries/binders';
import { useToast } from '../../ui/Toast';
import { binderErrorMessage, changedPockets, isRevisionConflict } from './model';

type PageWindow = BinderPageWindow;

export interface BinderWrite {
  /** Shown as the success toast and route announcement. */
  label: string;
  /** Receives the newest revision this screen has seen; never re-invoked automatically. */
  run: (revision: number) => Promise<BinderMutation>;
  /** Pocket to keep selected afterwards when the server returns no anchor. */
  focusAt?: BinderSlotLocation | null;
}

export interface RevisionConflict {
  message: string;
  pageNumber: number;
  changed: Array<{ row: number; column: number }>;
  retry: () => void;
}

export interface CapacityNeed {
  required: number;
  retry: () => Promise<boolean>;
}

/** Writes the pages a mutation returned straight into the page cache, so the page
 * on screen updates without a second round-trip, then marks the rest of the version
 * stale for the next time it's shown. */
export function applyMutation(queryClient: QueryClient, result: BinderMutation): void {
  const versionId = result.version.id;
  const written = new Set<number>();
  for (const page of result.pages) {
    written.add(page.position);
    const window: PageWindow = {
      version: result.version,
      pages: [page],
      nextPage: page.position + 1 < result.version.pageCount ? page.position + 1 : null,
    };
    queryClient.setQueryData(queryKeys.binders.page(versionId, page.position), window);
  }
  void queryClient.invalidateQueries({
    queryKey: queryKeys.binders.version(versionId),
    predicate: (query) => {
      const key = query.queryKey;
      return !(key[3] === 'page' && typeof key[4] === 'number' && written.has(key[4]));
    },
  });
  void queryClient.invalidateQueries({ queryKey: queryKeys.binders.list() });
  void queryClient.invalidateQueries({ queryKey: queryKeys.binders.inactiveTargets() });
}

export function useBinderWriter({
  versionId,
  currentPageIndex,
  getRevision,
  onSettled,
  navigationEpoch,
}: {
  versionId: string | undefined;
  currentPageIndex: number;
  getRevision: () => number | undefined;
  /** Called only while this screen is still showing the same binder and page it
   * started the write from; a slow write that lands elsewhere just toasts. */
  onSettled: (result: BinderMutation, focusAt: BinderSlotLocation | null) => void;
  navigationEpoch: number;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<RevisionConflict | null>(null);
  const [capacityNeed, setCapacityNeed] = useState<CapacityNeed | null>(null);
  const mounted = useRef(true);
  const epoch = useRef(navigationEpoch);
  epoch.current = navigationEpoch;
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;
  const inFlight = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const write = useCallback(
    async (request: BinderWrite): Promise<boolean> => {
      const revision = getRevision();
      if (!versionId || revision === undefined || inFlight.current) return false;
      inFlight.current = true;
      const startedEpoch = epoch.current;
      const stillHere = () => mounted.current && epoch.current === startedEpoch;
      setPending(true);
      setError(null);
      setConflict(null);
      try {
        const result = await request.run(revision);
        applyMutation(queryClient, result);
        toast('success', request.label);
        if (stillHere()) {
          setCapacityNeed(null);
          settledRef.current(result, result.anchor ?? request.focusAt ?? null);
        }
        return true;
      } catch (cause) {
        const message = binderErrorMessage(cause);
        if (!mounted.current) {
          if (message) toast('error', message);
          return false;
        }
        if (isRevisionConflict(cause)) {
          const before = queryClient.getQueryData<PageWindow>(
            queryKeys.binders.page(versionId, currentPageIndex),
          )?.pages[0];
          await queryClient.refetchQueries({ queryKey: queryKeys.binders.version(versionId) });
          const after: BinderPageView | undefined = queryClient.getQueryData<PageWindow>(
            queryKeys.binders.page(versionId, currentPageIndex),
          )?.pages[0];
          if (mounted.current)
            setConflict({
              message,
              pageNumber: currentPageIndex + 1,
              changed: changedPockets(before, after),
              // Retrying is always Gordon's call: the button re-runs the same intent
              // against the revision that was just reloaded.
              retry: () => void write(request),
            });
          return false;
        }
        if (cause instanceof ApiError && cause.code === 'binder_capacity_exceeded') {
          const details = binderCapacityErrorSchema.safeParse(cause.details);
          if (details.success) {
            setCapacityNeed({
              required: details.data.requiredCapacity,
              retry: () => write(request),
            });
            setError(
              `This needs ${details.data.requiredCapacity.toLocaleString('en-AU')} pockets. Grow the binder in Manage binder and the action runs again. No targets were changed.`,
            );
            return false;
          }
        }
        if (message) {
          setError(message);
          toast('error', message);
        }
        return false;
      } finally {
        inFlight.current = false;
        if (mounted.current) setPending(false);
      }
    },
    [versionId, currentPageIndex, getRevision, queryClient, toast],
  );

  return {
    write,
    pending,
    error,
    clearError: () => setError(null),
    conflict,
    dismissConflict: () => setConflict(null),
    capacityNeed,
    clearCapacityNeed: () => setCapacityNeed(null),
  };
}
