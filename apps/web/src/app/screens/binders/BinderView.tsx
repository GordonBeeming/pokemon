import {
  type BinderBookmark,
  type BinderDisplayPatchRequest,
  type BinderSearchMatch,
  type BinderSlotLocation,
  type PageSection,
  type PeekColumns,
} from '@pokedex/shared';
import { useQueryClient } from '@tanstack/react-query';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import { ApiError } from '../../api/client';
import { queryKeys } from '../../api/keys';
import {
  binderApi,
  useBinderBookmarks,
  useBinderPages,
  useBinders,
  useBinderSummary,
  useInactiveTargets,
  useResolvedCardGroups,
  type BinderMutation,
  type BinderPageView,
  type BinderSlotView,
  type ResolvedCard,
} from '../../api/queries/binders';
import { useFramePalette } from '../../api/queries/settings';
import type { BinderSearch } from '../../routes/search-params';
import type { ActionBarItem } from '../../ui/ActionBar';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { EmptyState } from '../../ui/EmptyState';
import { Icon } from '../../ui/icons';
import { MenuButton } from '../../ui/MenuButton';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { Sheet } from '../../ui/Sheet';
import { SidePanel } from '../../ui/SidePanel';
import { useRouteAnnounce, useToast } from '../../ui/Toast';
import { CardInspector } from '../card/CardInspector';
import { clearCardClipboard, useCardClipboard } from '../catalogue/card-clipboard';
import {
  anyFrameCard,
  binderErrorMessage,
  bookmarkDefaultName,
  cardIdsOnPages,
  frameCardFrom,
  parseSlotId,
  placedStatus,
  pocketState,
  pocketTitle,
  slotIdOf,
} from './model';
import { locationKey, PageTrack, type TrackPage } from './PageTrack';
import {
  BookmarkJump,
  PageActionList,
  PageJumpForm,
  PageMenu,
  PageStepper,
  PhonePageStepper,
  type PageMenuActions,
} from './PageToolbar';
import { ChangeTargetPanel } from './panels/ChangeTargetPanel';
import { InsertPanel } from './panels/InsertPanel';
import { PageFillPanel } from './panels/PageFillPanel';
import { FindCardsPanelContainer, ManagePanelContainer } from './panels/containers';
import { InsertPagesPanel, MovePagePanel, movedPageOrder } from './panels/PagePanels';
import { PastePanel } from './panels/PastePanel';
import {
  BookmarkPanel,
  PageBookmarkPanel,
  PageReservePanel,
  RemovePanel,
  ReserveSleevePanel,
} from './panels/PocketPanels';
import { PocketActions, pocketActionItems } from './PocketActions';
import { SpaceSearch } from './SpaceSearch';
import { PHONE_QUERY, REDUCED_MOTION_QUERY, useMediaQuery } from './useMediaQuery';
import { useBinderWriter } from './useBinderWriter';
import './binders.css';

export interface BinderViewProps {
  binderId: string;
  search: BinderSearch;
  onSearch: (next: BinderSearch, options: { replace: boolean }) => void;
  onOpenLibrary: () => void;
}

type PanelKind =
  | 'view'
  | 'find'
  | 'change'
  | 'insert'
  | 'paste'
  | 'bookmark'
  | 'remove'
  | 'reserve'
  | 'page-reserve'
  | 'page-bookmark'
  | 'page-fill'
  | 'insert-pages'
  | 'move-page'
  | 'manage'
  | 'discard'
  | 'delete';

interface PendingSelect {
  at: BinderSlotLocation;
  open?: PanelKind;
}

function sameAt(a: BinderSlotLocation | null, b: BinderSlotLocation | null): boolean {
  return a !== null && b !== null && a.page === b.page && a.row === b.row && a.column === b.column;
}

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}

function focusPocket(at: BinderSlotLocation, scroll: boolean): void {
  const element = document.querySelector<HTMLElement>(`[data-pocket="${locationKey(at)}"]`);
  if (!element) return;
  element.focus({ preventScroll: !scroll });
  // 'nearest' only scrolls when the pocket is off-screen, so a jump within the binder
  // doesn't move a page that's already in view.
  if (scroll) element.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}

/** Cards the loaded pages reference (targets and placed copies), merged into one map. */
function usePageCards(pages: readonly BinderPageView[]): Map<string, ResolvedCard> {
  const results = useResolvedCardGroups(pages.map((page) => cardIdsOnPages([page])));
  const stamp = results.map((result) => result.dataUpdatedAt).join(',');
  const dataRef = useRef(results);
  dataRef.current = results;
  return useMemo(() => {
    const map = new Map<string, ResolvedCard>();
    for (const result of dataRef.current)
      for (const card of result.data ?? []) map.set(card.id, card);
    return map;
  }, [stamp]);
}

export function BinderView({
  binderId,
  search,
  onSearch,
  onOpenLibrary,
}: BinderViewProps): ReactElement {
  const queryClient = useQueryClient();
  const toast = useToast();
  const announce = useRouteAnnounce();
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const phone = useMediaQuery(PHONE_QUERY);
  // Phone only: the jump sheet (page number, bookmarks) or the tools sheet.
  const [phoneSheet, setPhoneSheet] = useState<'jump' | 'tools' | null>(null);
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);
  const { palette } = useFramePalette();
  const clipboard = useCardClipboard();
  const binders = useBinders();
  const binder = binders.data?.find((item) => item.id === binderId);
  const versionId = search.v ?? binder?.activeVersionId ?? binder?.latestVersionId ?? undefined;
  const pageIndex = search.page - 1;

  // Last page count seen for this version, so neighbours past the end aren't requested
  // once it's known.
  const knownPageCount = useRef<number | null>(null);
  const windowIndexes = useMemo(
    () =>
      [pageIndex - 2, pageIndex - 1, pageIndex, pageIndex + 1, pageIndex + 2].filter(
        (i) =>
          i >= 0 &&
          (knownPageCount.current === null || i < knownPageCount.current || i === pageIndex),
      ),
    [pageIndex],
  );
  const pageQueries = useBinderPages(versionId, windowIndexes);
  const windows = pageQueries.map((query) => query.data);
  const current = windows[windowIndexes.indexOf(pageIndex)];
  const currentPage = current?.pages[0];
  const currentQuery = pageQueries[windowIndexes.indexOf(pageIndex)];
  const version = current?.version;
  const pageCount = version?.pageCount ?? 0;
  if (version) knownPageCount.current = version.pageCount;
  const loadedPages = windows.flatMap((window) => window?.pages ?? []);
  const cards = usePageCards(loadedPages);
  const summary = useBinderSummary(versionId);
  const bookmarks = useBinderBookmarks(versionId);
  const inactiveTargets = useInactiveTargets();

  // The newest revision this screen has seen from any response. Writes always send it,
  // so a write is never based on an older page than the one on screen.
  const revisionRef = useRef<number | undefined>(undefined);
  for (const window of windows)
    if (window && window.version.id === versionId)
      revisionRef.current = Math.max(revisionRef.current ?? 0, window.version.revision);
  const getRevision = useCallback(() => revisionRef.current, []);
  useEffect(() => {
    revisionRef.current = undefined;
  }, [versionId]);

  const editable = version !== undefined && version.status !== 'archived';
  const [display, setDisplay] = useState<{
    peek?: PeekColumns;
    frame?: boolean;
    section?: PageSection;
  }>({});
  const peek: PeekColumns = display.peek ?? binder?.peekColumns ?? 0;
  const showFrame = display.frame ?? binder?.showFrame ?? true;
  const pageSection: PageSection = display.section ?? binder?.pageSection ?? 'reserved';
  // Each page's header names the section it sits in: the nearest reserved page (or,
  // per binder, the nearest bookmark of any kind) at or before it.
  const sectionMarks = (bookmarks.data ?? [])
    // Named pages: reserved pages and bookmarked ordinary pages. Pocket bookmarks
    // count only when the binder is set to follow any bookmark.
    .filter((bookmark) => pageSection === 'bookmark' || bookmark.kind !== 'pocket')
    .map((bookmark) => ({ page: bookmark.at.page, name: bookmark.name }))
    .sort((a, b) => a.page - b.page);
  const sectionFor = (index: number): string | null => {
    if (pageSection === 'none') return null;
    let name: string | null = null;
    for (const mark of sectionMarks) {
      if (mark.page > index) break;
      name = mark.name;
    }
    return name;
  };

  // --- selection -----------------------------------------------------------------
  const selParts = parseSlotId(search.sel);
  const selectedSlot =
    selParts && currentPage && currentPage.id === selParts.pageId
      ? (currentPage.slots.find(
          (slot) => slot.row === selParts.row && slot.column === selParts.column,
        ) ?? null)
      : null;
  const selected: BinderSlotLocation | null = selectedSlot
    ? { page: pageIndex, row: selectedSlot.row, column: selectedSlot.column }
    : null;

  const [moveSource, setMoveSource] = useState<{
    at: BinderSlotLocation;
    title: string;
  } | null>(null);
  const [moveCursor, setMoveCursor] = useState<BinderSlotLocation | null>(null);
  const [panel, setPanel] = useState<PanelKind | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [navigationEpoch, setNavigationEpoch] = useState(0);
  const pendingSelect = useRef<PendingSelect | null>(null);
  const pendingFocus = useRef<'selected' | 'first' | null>('selected');
  // A bookmark names its page by id. If the page cached at that position turns out to
  // be a different page (pages were inserted or moved since it was fetched, say in
  // another tab), it's refetched rather than shown as the bookmarked page.
  const expectedPage = useRef<{ index: number; id: string } | null>(null);

  // The newest URL state this screen asked for. A panel that closes after an awaited
  // write reads this rather than the `search` it rendered with, which by then is stale
  // and would put back the selection the write just cleared.
  const latestSearch = useRef(search);
  useEffect(() => {
    latestSearch.current = search;
  }, [search]);
  const navigate = useCallback(
    (next: BinderSearch, replace: boolean) => {
      latestSearch.current = next;
      onSearch(next, { replace });
    },
    [onSearch],
  );

  const goToPage = useCallback(
    (index: number) => {
      if (index < 0 || (pageCount > 0 && index >= pageCount) || index === pageIndex) return;
      setNavigationEpoch((value) => value + 1);
      setPanel(null);
      // Plain page navigation drops the selection; an armed move keeps its source.
      navigate(
        moveSource ? { ...search, page: index + 1 } : { page: index + 1, v: search.v, q: search.q },
        false,
      );
    },
    [navigate, search, pageCount, pageIndex, moveSource],
  );

  const select = useCallback(
    (at: BinderSlotLocation, slot: BinderSlotView, page: BinderPageView) => {
      const sel = slotIdOf(page.id, slot.row, slot.column);
      if (at.page !== pageIndex) {
        setNavigationEpoch((value) => value + 1);
        navigate({ page: at.page + 1, v: search.v, q: search.q, sel }, false);
        return;
      }
      // Selecting only rewrites the current history entry: Back leaves the binder page
      // rather than stepping through every pocket that was ever tapped.
      navigate({ ...search, sel, mode: undefined }, true);
    },
    [navigate, pageIndex, search],
  );

  const deselect = useCallback(() => {
    if (!search.sel && !search.mode) return;
    setPanel(null);
    navigate({ ...search, sel: undefined, mode: undefined }, true);
  }, [navigate, search]);

  // A `sel` that doesn't name a pocket on this page (a stale or hand-edited link) is
  // dropped quietly; the page itself still opens.
  useEffect(() => {
    if (!search.sel || !currentPage || moveSource) return;
    if (!selectedSlot) navigate({ ...search, sel: undefined, mode: undefined }, true);
  }, [search, currentPage, selectedSlot, navigate, moveSource]);

  // An out-of-range page in the URL settles on the last page instead of erroring.
  useEffect(() => {
    if (pageCount > 0 && pageIndex >= pageCount)
      navigate({ ...search, page: pageCount, sel: undefined, mode: undefined }, true);
  }, [pageCount, pageIndex, navigate, search]);

  useEffect(() => {
    const onPop = () => {
      pendingFocus.current = 'selected';
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Deferred selections (bookmark/space-search/retarget jumps) resolve once the target
  // page has loaded and its page id is known.
  useEffect(() => {
    const pending = pendingSelect.current;
    if (!pending || !currentPage || pending.at.page !== pageIndex) return;
    pendingSelect.current = null;
    const slot = currentPage.slots.find(
      (item) => item.row === pending.at.row && item.column === pending.at.column,
    );
    if (!slot) return;
    pendingFocus.current = 'selected';
    navigate({ ...search, sel: slotIdOf(currentPage.id, slot.row, slot.column) }, true);
    if (pending.open) setPanel(pending.open);
  }, [currentPage, pageIndex, navigate, search]);

  useEffect(() => {
    const expected = expectedPage.current;
    if (!expected || !currentPage || expected.index !== pageIndex) return;
    expectedPage.current = null;
    if (currentPage.id !== expected.id) void currentQuery?.refetch();
  }, [currentPage, currentQuery, pageIndex]);

  // Direct links, back/forward and jumps restore focus to the linked pocket (or the
  // first one); ordinary page turns leave focus where it was.
  useEffect(() => {
    if (!pendingFocus.current || !currentPage || panel) return;
    const target =
      selected ??
      (pendingFocus.current === 'first' || !search.sel
        ? { page: pageIndex, row: 0, column: 0 }
        : null);
    if (!target) return;
    const frame = requestAnimationFrame(() => focusPocket(target, true));
    pendingFocus.current = null;
    return () => cancelAnimationFrame(frame);
  }, [currentPage, selected, pageIndex, panel, search.sel]);

  // --- writes -------------------------------------------------------------------
  const onSettled = useCallback(
    (result: BinderMutation, focusAt: BinderSlotLocation | null) => {
      void queryClient.invalidateQueries({ queryKey: ['binders', 'cards'] });
      if (result.version.id !== versionId) {
        // A clone or activation moved us onto a different version of this binder.
        const next: BinderSearch = {
          page: 1,
          q: '',
          v: result.version.status === 'active' ? undefined : result.version.id,
        };
        navigate(next, result.version.status !== 'active');
        return;
      }
      const target = focusAt
        ? Math.max(0, Math.min(focusAt.page, result.version.pageCount - 1))
        : Math.min(pageIndex, result.version.pageCount - 1);
      const page = result.pages.find((item) => item.position === target);
      const slot = focusAt
        ? page?.slots.find((s) => s.row === focusAt.row && s.column === focusAt.column)
        : undefined;
      // On a phone the selection is what holds the pocket sheet open, so a finished
      // action lands back on the binder with nothing selected; on desktop the
      // changed pocket stays selected with its action bar.
      const keepSelection = !phone && page !== undefined && slot !== undefined;
      pendingFocus.current = keepSelection ? 'selected' : null;
      setPanel(null);
      setPhoneSheet(null);
      navigate(
        {
          ...search,
          page: target + 1,
          sel: keepSelection ? slotIdOf(page.id, slot.row, slot.column) : undefined,
          mode: undefined,
        },
        true,
      );
    },
    [queryClient, versionId, navigate, pageIndex, search, phone],
  );

  const writer = useBinderWriter({
    versionId,
    currentPageIndex: pageIndex,
    getRevision,
    onSettled,
    navigationEpoch,
  });
  const { write, pending } = writer;

  const run = useCallback(
    async (
      label: string,
      request: (revision: number) => Promise<BinderMutation>,
      focusAt?: BinderSlotLocation | null,
    ) => {
      const ok = await write({ label, run: request, focusAt: focusAt ?? selected });
      if (ok) {
        setPanel(null);
        announce(label);
      }
      return ok;
    },
    [write, selected, announce],
  );

  // --- move -------------------------------------------------------------------
  const pickUp = useCallback(
    (at: BinderSlotLocation, slot: BinderSlotView) => {
      if (!editable || pocketState(slot) === 'empty' || !currentPage) return;
      setMoveSource({ at, title: pocketTitle(slot, cards) });
      setMoveCursor(at);
      setPanel(null);
      navigate(
        { ...search, sel: slotIdOf(currentPage.id, slot.row, slot.column), mode: 'move' },
        true,
      );
      announce('Card picked up. Use the arrow keys to choose a pocket, then press Enter.');
    },
    [editable, currentPage, cards, navigate, search, announce],
  );

  const cancelMove = useCallback(() => {
    setMoveSource(null);
    setMoveCursor(null);
    if (search.mode === 'move') navigate({ ...search, mode: undefined }, true);
  }, [navigate, search]);

  const drop = useCallback(
    (source: BinderSlotLocation, target: BinderSlotLocation) => {
      if (!versionId || !editable || sameAt(source, target)) return;
      void run(
        `Moved to page ${target.page + 1}, row ${target.row + 1}, pocket ${target.column + 1}.`,
        (revision) => binderApi.swap(versionId, source, target, revision),
        target,
      ).then((ok) => {
        if (ok) {
          setMoveSource(null);
          setMoveCursor(null);
        }
      });
    },
    [versionId, editable, run],
  );

  // A `mode=move` link without a live pickup (reload, or another tab's URL) arms the
  // move from the selected pocket on this page only, never from another binder.
  useEffect(() => {
    if (search.mode !== 'move' || moveSource || !selectedSlot || !selected || !editable) return;
    setMoveSource({ at: selected, title: pocketTitle(selectedSlot, cards) });
    setMoveCursor(selected);
  }, [search.mode, moveSource, selectedSlot, selected, editable, cards]);

  // --- keyboard -------------------------------------------------------------------
  const columns = version?.layout.columns ?? 1;
  const rows = version?.layout.rows ?? 1;

  function moveCursorBy(dx: number, dy: number): void {
    const from = moveCursor ?? { page: pageIndex, row: 0, column: 0 };
    let { page, row, column } =
      from.page === pageIndex ? from : { page: pageIndex, row: 0, column: 0 };
    row = Math.max(0, Math.min(rows - 1, row + dy));
    column += dx;
    if (column < 0) {
      if (page === 0) column = 0;
      else {
        page -= 1;
        column = columns - 1;
        goToPage(page);
      }
    } else if (column >= columns) {
      if (page + 1 >= pageCount) column = columns - 1;
      else {
        page += 1;
        column = 0;
        goToPage(page);
      }
    }
    const next = { page, row, column };
    setMoveCursor(next);
    requestAnimationFrame(() => focusPocket(next, false));
  }

  function onPocketKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    at: BinderSlotLocation,
    slot: BinderSlotView,
  ): void {
    const arrows: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const delta = arrows[event.key];
    if (moveSource) {
      if (delta) {
        event.preventDefault();
        moveCursorBy(delta[0], delta[1]);
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        drop(moveSource.at, moveCursor ?? at);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancelMove();
      }
      return;
    }
    if (delta && at.page === pageIndex) {
      event.preventDefault();
      const next = {
        page: at.page,
        row: Math.max(0, Math.min(rows - 1, at.row + delta[1])),
        column: Math.max(0, Math.min(columns - 1, at.column + delta[0])),
      };
      focusPocket(next, false);
      return;
    }
    if (event.key.toLowerCase() === 'm' && editable && at.page === pageIndex) {
      event.preventDefault();
      pickUp(at, slot);
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && editable && slot.assignedCardId) {
      event.preventDefault();
      if (versionId)
        void run(
          'Physical placement removed.',
          (revision) => binderApi.assign(versionId, at, null, revision),
          at,
        );
      return;
    }
    if (event.key === 'Escape') deselect();
  }

  // Page turns from anywhere on the screen that isn't a text field.
  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent): void {
      if (panel || isTypingTarget(event.target) || event.defaultPrevented) return;
      const inPocket = event.target instanceof Element && event.target.closest('[data-pocket]');
      if (event.key === 'PageDown' || (event.key === 'ArrowRight' && !inPocket)) {
        event.preventDefault();
        goToPage(pageIndex + 1);
      } else if (event.key === 'PageUp' || (event.key === 'ArrowLeft' && !inPocket)) {
        event.preventDefault();
        goToPage(pageIndex - 1);
      } else if (event.key === 'Escape' && moveSource) {
        cancelMove();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [panel, goToPage, pageIndex, moveSource, cancelMove]);

  // Clicking anywhere outside the pockets, the action bar and open dialogs deselects.
  useEffect(() => {
    if (!search.sel || panel || moveSource) return;
    function onPointerDown(event: PointerEvent): void {
      if (!(event.target instanceof Element)) return;
      if (
        event.target.closest(
          '[data-pocket], .pocket-actions, [role="dialog"], .dialog-backdrop, .sheet-backdrop, .menu-button, .menu-popover, .select-popover, .space-search-popover, .toast-viewport',
        )
      )
        return;
      deselect();
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [search.sel, panel, moveSource, deselect]);

  // --- panels that reflect in the URL (deep-linkable insert/paste) -----------------
  useEffect(() => {
    if (!selected) return;
    if (search.mode === 'insert' && panel !== 'insert') setPanel('insert');
    if (search.mode === 'paste' && panel !== 'paste' && clipboard) setPanel('paste');
    // Only reacts to URL changes; opening from the bar sets both together.
  }, [search.mode, selected !== null]);

  const openPanel = useCallback(
    (kind: PanelKind) => {
      setPanel(kind);
      if (kind === 'insert' || kind === 'paste') navigate({ ...search, mode: kind }, true);
    },
    [navigate, search],
  );
  const closePanel = useCallback(() => {
    setPanel(null);
    writer.clearError();
    const current = latestSearch.current;
    if (current.mode === 'insert' || current.mode === 'paste')
      navigate({ ...current, mode: undefined }, true);
  }, [navigate, writer]);

  // Closing the card flyout waits for unsaved notes (as it does everywhere else), then
  // hands focus back to the pocket it was opened from; the selection and the page's
  // scroll stay as they were. The action bar that opened it is gone while it's open,
  // so the overlay's own focus return has nothing to go back to.
  const [dirtyInspector, setDirtyInspector] = useState(false);
  const closeInspector = useCallback(() => {
    if (dirtyInspector) {
      toast(
        'error',
        'Notes are still saving. Wait a moment, or fix the save error, then try again.',
      );
      return;
    }
    setPanel(null);
    setDirtyInspector(false);
    if (selected) {
      const at = selected;
      requestAnimationFrame(() => focusPocket(at, false));
    }
  }, [dirtyInspector, toast, selected]);

  // A finished pocket action lands back on the binder. On a phone the selection is
  // what holds the pocket sheet open, so it's cleared too; the writer's own writes do
  // the same in onSettled.
  const leavePocket = useCallback(() => {
    setPanel(null);
    if (phone) navigate({ ...latestSearch.current, sel: undefined, mode: undefined }, true);
  }, [navigate, phone]);

  // --- inactive targets --------------------------------------------------------
  const inactiveHere = (inactiveTargets.data ?? []).filter(
    (target) => target.binderId === binderId && version?.status === 'active',
  );
  const inactiveKeys = useMemo(
    () =>
      new Set(
        inactiveHere.map((target) =>
          locationKey({ page: target.page, row: target.row, column: target.column }),
        ),
      ),
    [inactiveHere],
  );

  function jumpTo(at: BinderSlotLocation, open?: PanelKind): void {
    if (at.page === pageIndex && currentPage) {
      const slot = currentPage.slots.find(
        (item) => item.row === at.row && item.column === at.column,
      );
      if (slot) {
        pendingFocus.current = 'selected';
        navigate(
          { ...search, sel: slotIdOf(currentPage.id, slot.row, slot.column), mode: undefined },
          true,
        );
        if (open) setPanel(open);
      }
      return;
    }
    pendingSelect.current = { at, open };
    setNavigationEpoch((value) => value + 1);
    navigate({ page: at.page + 1, v: search.v, q: search.q }, false);
  }

  function jumpToBookmark(bookmark: BinderBookmark): void {
    expectedPage.current = { index: bookmark.at.page, id: bookmark.pageId };
    pendingFocus.current = 'selected';
    setNavigationEpoch((value) => value + 1);
    navigate(
      {
        page: bookmark.at.page + 1,
        v: search.v,
        q: search.q,
        sel:
          bookmark.kind === 'pocket'
            ? slotIdOf(bookmark.pageId, bookmark.at.row, bookmark.at.column)
            : undefined,
      },
      false,
    );
  }

  function jumpToSpace(match: BinderSearchMatch): void {
    if (match.row === null || match.column === null) {
      goToPage(match.page);
      return;
    }
    jumpTo({ page: match.page, row: match.row, column: match.column });
  }

  // --- display settings -----------------------------------------------------------
  async function patchDisplay(patch: BinderDisplayPatchRequest): Promise<void> {
    setDisplay((currentDisplay) => ({
      peek: patch.peekColumns ?? currentDisplay.peek,
      frame: patch.showFrame ?? currentDisplay.frame,
      section: patch.pageSection ?? currentDisplay.section,
    }));
    try {
      const saved = await binderApi.patchDisplay(binderId, patch);
      queryClient.setQueryData(queryKeys.binders.list(), (list: typeof binders.data) =>
        list?.map((item) => (item.id === saved.id ? { ...item, ...saved } : item)),
      );
    } catch (cause) {
      toast('error', binderErrorMessage(cause));
    } finally {
      setDisplay({});
    }
  }

  // --- rendering -------------------------------------------------------------------
  if (binders.isLoading)
    return (
      <section className="binder-view" aria-busy="true">
        <p role="status">Loading binder…</p>
      </section>
    );
  if (binders.isError)
    return (
      <section className="binder-view">
        <p role="alert" className="panel-error">
          {binderErrorMessage(binders.error)}
        </p>
        <button type="button" onClick={() => void binders.refetch()}>
          Try again
        </button>
      </section>
    );
  if (!binder || !versionId)
    return (
      <section className="binder-view">
        <EmptyState
          icon="binder"
          title="This binder is no longer available"
          description="It may have been deleted in another tab."
          action={{ label: 'Back to all binders', onSelect: onOpenLibrary }}
        />
      </section>
    );

  const trackPages: TrackPage[] = windowIndexes
    .filter((index) => pageCount === 0 || index < pageCount)
    .map((index) => ({ index, page: windows[windowIndexes.indexOf(index)]?.pages[0] }));

  const capacity = version?.capacity ?? 0;
  const layoutLabel = version ? `${version.layout.rows} × ${version.layout.columns}` : '';
  const selectedCardId =
    selectedSlot?.assignedCardId ??
    (selectedSlot?.entryKind === 'exact-card' ? selectedSlot.cardId : null);
  const selectedCard = selectedCardId ? cards.get(selectedCardId) : undefined;
  const selectedBookmark =
    selected && currentPage
      ? bookmarks.data?.find(
          (item) =>
            item.kind === 'pocket' &&
            item.pageId === currentPage.id &&
            item.at.row === selected.row &&
            item.at.column === selected.column,
        )
      : undefined;
  const reservedPage = currentPage?.kind === 'reserved';
  const pageBookmarkName = !reservedPage ? (currentPage?.label ?? '') : '';
  const pageRemovable =
    currentPage !== undefined &&
    currentPage.kind !== 'reserved' &&
    currentPage.slots.every((slot) => pocketState(slot) === 'empty' && !slot.startsNewPage);

  const pageEmptyPockets =
    currentPage?.slots.filter((slot) => pocketState(slot) === 'empty').length ?? 0;

  const actionItems: ActionBarItem[] =
    selectedSlot && selected && versionId
      ? pocketActionItems({
          slot: selectedSlot,
          editable,
          hasCard: selectedCardId !== null && selectedCardId !== undefined,
          hasClipboard: clipboard !== null,
          on: {
            view: () => setPanel('view'),
            find: () => setPanel('find'),
            move: () => pickUp(selected, selectedSlot),
            change: () => setPanel('change'),
            insert: () => openPanel('insert'),
            reserve: () => setPanel('reserve'),
            paste: () => openPanel('paste'),
            bookmark: () => setPanel('bookmark'),
            remove: () => setPanel('remove'),
          },
        })
      : [];

  const draftVersionId =
    binder.latestVersionId && binder.latestVersionId !== binder.activeVersionId
      ? binder.latestVersionId
      : null;
  const viewingDraft = version?.status === 'draft';

  // Usage numbers are reference detail for managing capacity, so they sit in the
  // Manage binder panel rather than in a row between the header and the pages.
  const usage = summary.data ? (
    <dl className="binder-usage" aria-label="Binder usage">
      <div>
        <dt>Targets</dt>
        <dd>{summary.data.targets.toLocaleString('en-AU')}</dd>
      </div>
      <div>
        <dt>Placed</dt>
        <dd>{summary.data.placed.toLocaleString('en-AU')}</dd>
      </div>
      <div>
        <dt>Reserved sleeves</dt>
        <dd>{summary.data.reservedSleeves.toLocaleString('en-AU')}</dd>
      </div>
      <div>
        <dt>Reserved pages</dt>
        <dd>{summary.data.reservedPages.toLocaleString('en-AU')}</dd>
      </div>
      <div>
        <dt>{summary.data.reservedPages > 0 ? 'Available outside reserved pages' : 'Available'}</dt>
        <dd>{summary.data.available.toLocaleString('en-AU')}</dd>
      </div>
    </dl>
  ) : null;

  const metaText = `${layoutLabel} pages · ${capacity.toLocaleString('en-AU')} pockets${
    summary.data
      ? ` · ${summary.data.targets.toLocaleString('en-AU')} targets · ${summary.data.placed.toLocaleString('en-AU')} placed`
      : ''
  }`;
  const meta = <p className="binder-meta">{metaText}</p>;

  const pageMenuActions: PageMenuActions = {
    reservedPage,
    bookmarkedPage: pageBookmarkName !== '',
    canRemove: pageRemovable,
    onReservePage: () => setPanel('page-reserve'),
    onBookmarkPage: () => setPanel('page-bookmark'),
    emptyPockets: pageEmptyPockets,
    onFillPage: () => setPanel('page-fill'),
    onInsertPages: () => setPanel('insert-pages'),
    onMoveTo: () => setPanel('move-page'),
    onEarlier: () => reorder(-1),
    onLater: () => reorder(1),
    onArrange: () => setPanel('manage'),
    onRemovePage: () => {
      if (versionId && currentPage)
        void run(
          'Page removed.',
          (revision) => binderApi.deletePage(versionId, currentPage.id, revision),
          null,
        );
    },
  };

  const displayControls = (
    <div className="binder-display-controls">
      <span className="binder-display-label">Show neighbouring pages</span>
      <SegmentedControl<string>
        label="Neighbouring columns shown"
        value={String(peek)}
        onChange={(value) =>
          void patchDisplay({
            peekColumns: Number(value) === 2 ? 2 : Number(value) === 1 ? 1 : 0,
          })
        }
        options={[
          { value: '0', label: 'None' },
          { value: '1', label: '1 column' },
          { value: '2', label: '2 columns' },
        ]}
      />
      <span className="binder-display-label">Card frame</span>
      <SegmentedControl<string>
        label="Card frame"
        value={showFrame ? 'on' : 'off'}
        onChange={(value) => void patchDisplay({ showFrame: value === 'on' })}
        options={[
          { value: 'on', label: 'On' },
          { value: 'off', label: 'Off' },
        ]}
      />
      <span className="binder-display-label">Page header shows</span>
      <SegmentedControl<PageSection>
        label="Page header shows"
        value={pageSection}
        onChange={(value) => void patchDisplay({ pageSection: value })}
        options={[
          { value: 'reserved', label: 'Page name' },
          { value: 'bookmark', label: 'Any bookmark' },
          { value: 'none', label: 'Nothing' },
        ]}
      />
    </div>
  );

  const closePhoneSheet = (): void => setPhoneSheet(null);

  const selectedTitle = selectedSlot ? pocketTitle(selectedSlot, cards) : '';
  const where = selected
    ? `Page ${selected.page + 1} · row ${selected.row + 1}, pocket ${selected.column + 1}`
    : '';

  return (
    <section className="binder-view binder-scope" aria-labelledby="binder-heading">
      <header className="binder-header">
        <div className="binder-heading">
          <nav aria-label="Breadcrumb" className="binder-breadcrumb">
            <a
              href="#binders"
              onClick={(event) => {
                event.preventDefault();
                onOpenLibrary();
              }}
            >
              Back to all binders
            </a>
          </nav>
          <h1 id="binder-heading">{binder.name}</h1>
          {/* The pager sits under the pages, so the header keeps a quiet read-only
              "where am I" for when the pager is scrolled out of view. */}
          <p className="binder-meta">
            <span className="binder-page-indicator">
              Page {pageIndex + 1} / {Math.max(pageCount, 1)}
            </span>
            {phone ? null : <> · {metaText}</>}
          </p>
        </div>
        {phone ? (
          <div className="binder-header-actions">
            <button
              type="button"
              className="button-icon binder-tools-trigger"
              aria-label="Binder tools"
              onClick={() => setPhoneSheet('tools')}
            >
              <Icon name="settings" />
            </button>
          </div>
        ) : (
          <div className="binder-header-actions binder-toolbar">
            <SpaceSearch
              key={versionId}
              versionId={versionId}
              query={search.q}
              pending={pending}
              onQueryChange={(q) => navigate({ ...search, q }, true)}
              onJump={jumpToSpace}
            />
            <BookmarkJump
              bookmarks={bookmarks.data ?? []}
              pending={pending}
              onJump={jumpToBookmark}
            />
            <PageMenu
              pageIndex={pageIndex}
              pageCount={pageCount}
              editable={editable}
              pending={pending}
              actions={pageMenuActions}
            />
            {/* Peek and frame are set once per binder and rarely touched again, so they
                sit behind one trigger instead of a row of controls. */}
            <MenuButton
              kind="dialog"
              className="binder-display"
              popoverClassName="binder-scope binder-display"
              align="end"
              menuLabel="Display"
              label={
                <>
                  <Icon name="eye" /> <span className="menu-button-text">Display</span>
                </>
              }
            >
              {() => displayControls}
            </MenuButton>
            <button type="button" onClick={() => setPanel('manage')}>
              <Icon name="settings" />
              Manage binder
            </button>
          </div>
        )}
      </header>
      {/* On a phone, finding a card and jumping to a bookmark are how you move around a
          big binder, so they stay on screen rather than behind the Tools sheet. */}
      {phone ? (
        <div className="binder-phone-finders">
          <SpaceSearch
            key={versionId}
            versionId={versionId}
            query={search.q}
            pending={pending}
            onQueryChange={(q) => navigate({ ...search, q }, true)}
            onJump={jumpToSpace}
          />
          <BookmarkJump
            bookmarks={bookmarks.data ?? []}
            pending={pending}
            onJump={jumpToBookmark}
          />
        </div>
      ) : null}

      {version?.status === 'archived' ? (
        <p className="binder-banner binder-banner-muted" role="status">
          This archived binder is read-only.
        </p>
      ) : null}
      {viewingDraft ? (
        <div className="binder-banner binder-banner-accent" role="status">
          <span>
            You’re editing a draft. The active binder is unchanged until you make this draft active.
          </span>
          <button type="button" onClick={() => setPanel('manage')}>
            Make active or discard
          </button>
        </div>
      ) : null}
      {writer.conflict ? (
        <div className="binder-banner binder-banner-warning" role="alert">
          <span>
            {writer.conflict.message}{' '}
            {writer.conflict.changed.length > 0
              ? `On page ${writer.conflict.pageNumber}, ${writer.conflict.changed.length} ${writer.conflict.changed.length === 1 ? 'pocket' : 'pockets'} changed (${writer.conflict.changed
                  .slice(0, 4)
                  .map((at) => `row ${at.row + 1}, pocket ${at.column + 1}`)
                  .join('; ')}${writer.conflict.changed.length > 4 ? '; …' : ''}).`
              : 'Nothing on this page changed; the edit was elsewhere in the binder.'}{' '}
            Nothing of yours was saved.
          </span>
          <button type="button" onClick={writer.conflict.retry} disabled={pending}>
            Try again on the latest
          </button>
          <button type="button" className="button-text" onClick={writer.dismissConflict}>
            Dismiss
          </button>
        </div>
      ) : null}
      {writer.capacityNeed ? (
        <div className="binder-banner binder-banner-warning" role="alert">
          <span>{writer.error}</span>
          <button type="button" onClick={() => setPanel('manage')}>
            Open Manage binder
          </button>
        </div>
      ) : writer.error && !panel ? (
        <p className="binder-banner binder-banner-warning" role="alert">
          {writer.error}
        </p>
      ) : null}
      {clipboard ? (
        <div className="binder-banner" role="status">
          <span>
            {clipboard.cards.length} {clipboard.cards.length === 1 ? 'card' : 'cards'} copied.
            Select a pocket and choose “Paste here”.
          </span>
          <button type="button" className="button-text" onClick={clearCardClipboard}>
            Clear copied cards
          </button>
        </div>
      ) : null}
      {inactiveHere.length > 0 ? (
        <div className="binder-banner binder-banner-warning" role="status">
          <span>
            {inactiveHere.length === 1
              ? 'One target points'
              : `${inactiveHere.length} targets point`}{' '}
            at a card no longer in the catalogue:{' '}
            {inactiveHere
              .slice(0, 3)
              .map(
                (target) =>
                  `${target.cardName} (${target.setName} ${target.number}) on page ${target.page + 1}`,
              )
              .join(', ')}
            .
          </span>
          {inactiveHere[0] ? (
            <button
              type="button"
              disabled={!editable}
              onClick={() => {
                const first = inactiveHere[0];
                if (first)
                  jumpTo({ page: first.page, row: first.row, column: first.column }, 'change');
              }}
            >
              Change target
            </button>
          ) : null}
        </div>
      ) : null}

      {phone ? (
        <>
          <Sheet
            open={phoneSheet === 'jump'}
            onClose={closePhoneSheet}
            title="Go to a page"
            className="binder-scope"
          >
            <div className="binder-sheet">
              <PageJumpForm
                pageIndex={pageIndex}
                pageCount={Math.max(pageCount, 1)}
                pending={pending}
                onGo={(index) => {
                  closePhoneSheet();
                  goToPage(index);
                }}
              />
              <BookmarkJump
                bookmarks={bookmarks.data ?? []}
                pending={pending}
                onJump={(bookmark) => {
                  closePhoneSheet();
                  jumpToBookmark(bookmark);
                }}
              />
            </div>
          </Sheet>
          <Sheet
            open={phoneSheet === 'tools'}
            onClose={closePhoneSheet}
            title="Binder tools"
            className="binder-scope"
          >
            <div className="binder-sheet">
              <section className="binder-sheet-section" aria-labelledby="binder-sheet-page">
                <h3 id="binder-sheet-page">Manage page {pageIndex + 1}</h3>
                <PageActionList
                  pageIndex={pageIndex}
                  pageCount={pageCount}
                  editable={editable}
                  pending={pending}
                  actions={pageMenuActions}
                  onDone={closePhoneSheet}
                />
              </section>
              <button
                type="button"
                onClick={() => {
                  closePhoneSheet();
                  setPanel('manage');
                }}
              >
                <Icon name="settings" />
                Manage binder
              </button>
              <section className="binder-sheet-section binder-display" aria-label="Display">
                <h3>Display</h3>
                {displayControls}
              </section>
            </div>
          </Sheet>
        </>
      ) : null}

      {moveSource ? (
        <div className="binder-banner binder-banner-accent" role="status">
          <span>
            Moving {moveSource.title} from page {moveSource.at.page + 1}, row{' '}
            {moveSource.at.row + 1}, pocket {moveSource.at.column + 1}. Choose a destination pocket;
            you can change pages first. Arrow keys choose, Enter drops.
          </span>
          <button type="button" onClick={cancelMove}>
            Cancel move
          </button>
        </div>
      ) : null}

      <div className="binder-stage">
        {currentQuery?.isError ? (
          <div className="binder-banner binder-banner-warning" role="alert">
            <span>{binderErrorMessage(currentQuery.error)}</span>
            <button type="button" onClick={() => void currentQuery.refetch()}>
              Try again
            </button>
          </div>
        ) : version ? (
          <PageTrack
            pages={trackPages}
            sectionFor={sectionFor}
            currentIndex={pageIndex}
            pageCount={pageCount}
            rows={rows}
            columns={columns}
            peek={peek}
            showFrame={showFrame}
            cards={cards}
            palette={palette}
            selected={moveSource ? null : selected}
            moveSource={moveSource?.at ?? null}
            moveCursor={moveSource ? moveCursor : null}
            inactive={inactiveKeys}
            editable={editable && !pending}
            reducedMotion={reducedMotion}
            onPocketClick={(at, slot) => {
              if (moveSource) {
                drop(moveSource.at, at);
                return;
              }
              const page = windows[windowIndexes.indexOf(at.page)]?.pages[0];
              if (page) select(at, slot, page);
            }}
            onPocketKeyDown={onPocketKeyDown}
            onDrop={drop}
            onFlip={(delta) => goToPage(pageIndex + delta)}
            edgeButtons={phone ? 'overlay' : 'beside'}
            busy={pending}
          />
        ) : (
          <p role="status" className="binder-loading">
            Loading page {pageIndex + 1}…
          </p>
        )}
      </div>

      {/* Paging reads after the content, like the foot of a book page. */}
      {phone ? (
        <PhonePageStepper
          pageIndex={pageIndex}
          pageCount={Math.max(pageCount, 1)}
          pending={pending}
          onGo={goToPage}
          onOpenJump={() => setPhoneSheet('jump')}
        />
      ) : (
        <PageStepper
          pageIndex={pageIndex}
          pageCount={Math.max(pageCount, 1)}
          pending={pending}
          onGo={goToPage}
        />
      )}

      {selectedSlot && selected && !moveSource && !panel ? (
        <PocketActions
          phone={phone}
          summary={{
            imageUrl: selectedCard?.imageLowUrl ?? null,
            faded: !selectedSlot.assignedCardId,
            title: selectedTitle,
            where,
            status: placedStatus(selectedSlot, cards),
            frame: selectedCard
              ? {
                  card: frameCardFrom(selectedCard),
                  variant: 'card',
                  state: selectedSlot.assignedCardId ? 'placed' : 'unowned',
                }
              : selectedSlot.entryKind === 'pokemon' && selectedSlot.pokemonNumber
                ? {
                    card: anyFrameCard(selectedSlot.pokemonNumber),
                    variant: 'any',
                    state: 'unowned',
                  }
                : null,
            palette,
          }}
          items={actionItems}
          onClose={deselect}
        />
      ) : !selectedSlot && !moveSource ? (
        <p className="binder-hint">
          Select a pocket for its actions. Drag a card onto a neighbouring page to move it; hold it
          over the edge to turn the page.
        </p>
      ) : null}

      {/* The same card flyout the rest of the app uses: one inspector, one surface. */}
      {panel === 'view' && selectedCardId && selectedSlot && currentPage ? (
        <SidePanel open onClose={closeInspector} title="Card">
          <CardInspector
            cardId={selectedCardId}
            onClose={closeInspector}
            onDirtyChange={setDirtyInspector}
            context={{
              binderId,
              slotId: slotIdOf(currentPage.id, selectedSlot.row, selectedSlot.column),
            }}
          />
        </SidePanel>
      ) : null}
      {panel === 'find' && selectedSlot && selected && versionId ? (
        <FindCardsPanelContainer
          versionId={versionId}
          slot={selectedSlot}
          at={selected}
          slotId={search.sel ?? ''}
          title={selectedTitle}
          reservedPage={reservedPage}
          editable={editable}
          palette={palette}
          binderId={binderId}
          exactCard={
            selectedSlot.entryKind === 'exact-card' && selectedSlot.cardId
              ? cards.get(selectedSlot.cardId)
              : undefined
          }
          // A new copy is placed through the card's own place endpoint, which only
          // writes to the binder's active version.
          addBlockedReason={
            version?.status === 'active'
              ? null
              : 'Adding a copy places it in the active binder, so it’s not available while you edit a draft.'
          }
          pending={pending}
          error={writer.error}
          onAssign={(candidate) =>
            void run(`${candidate.name} placed.`, (revision) =>
              binderApi.assign(versionId, selected, candidate.cardId, revision),
            )
          }
          onAddAndPlace={(card, place) =>
            void run(`Added a copy of ${card.name} and placed it.`, place)
          }
          onUnassign={() =>
            void run('Physical placement removed.', (revision) =>
              binderApi.assign(versionId, selected, null, revision),
            )
          }
          onPageBreak={(starts) =>
            void run(starts ? 'Target starts a new page.' : 'Page break removed.', (revision) =>
              binderApi.pageBreak(versionId, selected, starts, revision),
            )
          }
          onClose={closePanel}
        />
      ) : null}
      {panel === 'change' && selectedSlot && selected && versionId ? (
        <ChangeTargetPanel
          slot={selectedSlot}
          pocketLabel={where}
          cards={cards}
          palette={palette}
          pending={pending}
          error={writer.error}
          onChoose={(card) =>
            // No copy choice: a copy already placed here stays placed when it is the new
            // target card, and goes back to loose only when it no longer fits.
            void run(`${card.name} is now the target for this pocket.`, (revision) =>
              binderApi.setSlot(versionId, selected, card.id, revision),
            )
          }
          onClose={closePanel}
        />
      ) : null}
      {panel === 'insert' && selected && selectedSlot && versionId ? (
        <InsertPanel
          versionId={versionId}
          at={selected}
          reservedPage={reservedPage}
          pageSize={version ? version.layout.rows * version.layout.columns : 9}
          palette={palette}
          pending={pending}
          error={writer.error}
          shift={
            pocketState(selectedSlot) !== 'empty'
              ? {
                  onShift: (offset) =>
                    void run('Selected and later targets shifted.', (revision) =>
                      binderApi.shift(versionId, selected, offset, revision),
                    ),
                }
              : undefined
          }
          onInsert={(at, entries) =>
            void run(
              `${entries.length} ${entries.length === 1 ? 'target' : 'targets'} inserted.`,
              (revision) => binderApi.insert(versionId, at, entries, revision),
              at,
            )
          }
          onClose={closePanel}
        />
      ) : null}
      {panel === 'paste' &&
      selected &&
      clipboard &&
      versionId &&
      revisionRef.current !== undefined ? (
        <PastePanel
          versionId={versionId}
          revision={revisionRef.current}
          at={selected}
          clipboard={clipboard}
          // The paste goes in at the revision its preview was calculated for, so the
          // counts Gordon confirmed are the counts that land (or it conflicts).
          onPaste={(request) =>
            run(
              `${request.cardIds.length} ${request.cardIds.length === 1 ? 'card' : 'cards'} pasted.`,
              () => binderApi.paste(versionId, request),
              selected,
            )
          }
          onClose={closePanel}
        />
      ) : null}
      {panel === 'bookmark' && selectedSlot && selected && versionId && currentPage ? (
        <BookmarkPanel
          initialName={selectedBookmark?.name ?? bookmarkDefaultName(selectedSlot, cards)}
          hasBookmark={selectedBookmark !== undefined}
          onSave={(name) =>
            binderApi
              .setBookmark(versionId, {
                pageId: currentPage.id,
                row: selected.row,
                column: selected.column,
                name,
              })
              .then(() => {
                leavePocket();
                return queryClient.invalidateQueries({
                  queryKey: queryKeys.binders.bookmarks(versionId),
                });
              })
          }
          onRemove={() =>
            selectedBookmark
              ? binderApi.removeBookmark(versionId, selectedBookmark.id).then(() => {
                  leavePocket();
                  return queryClient.invalidateQueries({
                    queryKey: queryKeys.binders.bookmarks(versionId),
                  });
                })
              : Promise.resolve()
          }
          onClose={closePanel}
        />
      ) : null}
      {panel === 'remove' && selectedSlot && selected && versionId ? (
        <RemovePanel
          slot={selectedSlot}
          pending={pending}
          error={writer.error}
          onLeaveGap={() =>
            void run(
              selectedSlot.entryKind === 'reserved'
                ? 'Sleeve unreserved.'
                : 'Card removed. The sleeve is now empty.',
              (revision) => binderApi.setSlot(versionId, selected, null, revision),
            )
          }
          onCloseGap={() =>
            void run('Removed and later targets closed the gap.', (revision) =>
              binderApi.compactRemove(versionId, selected, revision),
            )
          }
          onClose={closePanel}
        />
      ) : null}
      {panel === 'reserve' && selected && versionId ? (
        <ReserveSleevePanel
          pending={pending}
          error={writer.error}
          onReserve={(label) =>
            void run('Sleeve reserved.', (revision) =>
              binderApi.insert(versionId, selected, [{ kind: 'reserved', label }], revision),
            )
          }
          onClose={closePanel}
        />
      ) : null}
      {panel === 'page-reserve' && versionId ? (
        <PageReservePanel
          reserved={reservedPage}
          initialLabel={currentPage?.label ?? ''}
          pending={pending}
          error={writer.error}
          onSave={(label) =>
            void run(reservedPage ? 'Page label saved.' : 'Page reserved.', (revision) =>
              binderApi.reservePage(versionId, pageIndex, true, label, revision),
            ).then(
              () =>
                void queryClient.invalidateQueries({
                  queryKey: queryKeys.binders.bookmarks(versionId),
                }),
            )
          }
          onUnreserve={() =>
            void run('Page unreserved.', (revision) =>
              binderApi.reservePage(versionId, pageIndex, false, null, revision),
            ).then(
              () =>
                void queryClient.invalidateQueries({
                  queryKey: queryKeys.binders.bookmarks(versionId),
                }),
            )
          }
          onClose={closePanel}
        />
      ) : null}
      {panel === 'page-bookmark' && versionId ? (
        <PageBookmarkPanel
          initialName={pageBookmarkName}
          pending={pending}
          error={writer.error}
          onSave={(name) =>
            void run(`Page bookmarked as ${name}.`, (revision) =>
              binderApi.reservePage(versionId, pageIndex, false, name, revision),
            ).then(
              () =>
                void queryClient.invalidateQueries({
                  queryKey: queryKeys.binders.bookmarks(versionId),
                }),
            )
          }
          onRemove={() =>
            void run('Page bookmark removed.', (revision) =>
              binderApi.reservePage(versionId, pageIndex, false, null, revision),
            ).then(
              () =>
                void queryClient.invalidateQueries({
                  queryKey: queryKeys.binders.bookmarks(versionId),
                }),
            )
          }
          onClose={closePanel}
        />
      ) : null}
      {panel === 'page-fill' && versionId ? (
        <PageFillPanel
          emptyPockets={pageEmptyPockets}
          pending={pending}
          error={writer.error}
          onFill={(target, name) =>
            void run(`Page reserved for any ${name}.`, (revision) =>
              binderApi.fillPage(versionId, pageIndex, target, revision),
            )
          }
          onClose={closePanel}
        />
      ) : null}
      {panel === 'insert-pages' && versionId ? (
        <InsertPagesPanel
          pageIndex={pageIndex}
          pending={pending}
          error={writer.error}
          onInsert={(beforePosition, count) =>
            run(
              `${count === 1 ? 'A blank page was' : `${count} blank pages were`} added ${beforePosition === pageIndex ? 'before' : 'after'} page ${pageIndex + 1}.`,
              (revision) => binderApi.insertPages(versionId, beforePosition, count, revision),
              { page: beforePosition, row: 0, column: 0 },
            )
          }
          onClose={closePanel}
        />
      ) : null}
      {panel === 'move-page' && versionId && version ? (
        <MovePagePanel
          pageIndex={pageIndex}
          pageCount={pageCount}
          lastPagePartial={capacity % (rows * columns) !== 0}
          pending={pending}
          error={writer.error}
          onMove={(to) => movePageTo(to)}
          onClose={closePanel}
        />
      ) : null}
      {panel === 'manage' && version && versionId ? (
        <ManagePanelContainer
          versionId={versionId}
          version={version}
          usage={
            phone ? (
              <>
                {meta}
                {usage}
              </>
            ) : (
              usage
            )
          }
          editable={editable}
          pending={pending}
          error={writer.error}
          suggestedCapacity={writer.capacityNeed?.required ?? null}
          selected={selected}
          drafts={{ viewingDraft, draftVersionId, activeVersionId: binder.activeVersionId }}
          onResize={(value) => void resizeThenRetry(value)}
          onArrange={(mode) =>
            void run(
              'Targets arranged.',
              (revision) => binderApi.arrange(versionId, mode, revision),
              null,
            )
          }
          onPreviewArrangeInDraft={(mode) =>
            void run(
              'Draft created and arranged. Review it, then make it active or discard it.',
              async (revision) => {
                const draft = await binderApi.clone(versionId, revision);
                return binderApi.arrange(draft.version.id, mode, draft.version.revision);
              },
              null,
            )
          }
          onClone={() =>
            void run('Draft created.', (revision) => binderApi.clone(versionId, revision), null)
          }
          onOpenDraft={() => {
            if (draftVersionId) {
              setPanel(null);
              navigate({ page: 1, q: '', v: draftVersionId }, false);
            }
          }}
          onOpenActive={() => {
            setPanel(null);
            navigate({ page: 1, q: '' }, false);
          }}
          onActivate={() =>
            void run(
              'Draft is now the active binder.',
              (revision) => binderApi.activate(versionId, revision),
              null,
            )
          }
          onDiscard={() => setPanel('discard')}
          onFullPokedex={(at, regionPageBreaks) =>
            void run(
              'All 1,025 Pokémon inserted.',
              (revision) => binderApi.fullPokedex(versionId, at, regionPageBreaks, revision),
              at,
            )
          }
          onAddPage={() =>
            void run(
              'Page added at the end.',
              (revision) => binderApi.addPage(versionId, revision),
              null,
            )
          }
          onPrint={() => {
            setPanel(null);
            requestAnimationFrame(() => window.print());
          }}
          onDelete={() => setPanel('delete')}
          onClose={closePanel}
        />
      ) : null}
      <ConfirmDialog
        open={panel === 'discard'}
        title="Discard draft"
        description="This throws away the draft and every change made in it. The active binder stays exactly as it is."
        confirmLabel="Discard draft"
        cancelLabel="Keep draft"
        destructive
        pending={discarding}
        onCancel={() => setPanel(null)}
        onConfirm={discardDraft}
        success="Draft discarded. The active binder is unchanged."
        describeError={binderErrorMessage}
      />
      <ConfirmDialog
        open={panel === 'delete'}
        title="Delete binder"
        description={`This permanently deletes “${binder.name}”, every page and every target in it. Your owned cards stay in your collection.`}
        confirmLabel="Permanently delete binder"
        cancelLabel="Cancel deletion"
        destructive
        requireTypedConfirmation={binder.name}
        onCancel={() => setPanel(null)}
        success={`${binder.name} was deleted.`}
        describeError={binderErrorMessage}
        onConfirm={() =>
          binderApi.remove(binderId, binder.name).then(() => {
            queryClient.removeQueries({ queryKey: ['binders', 'version', versionId] });
            void queryClient.invalidateQueries({ queryKey: queryKeys.binders.list() });
            // Only leave if this binder is still the one on screen; if Gordon opened
            // another binder meanwhile this component is gone and nothing navigates.
            if (mountedRef.current) onOpenLibrary();
          })
        }
      />
    </section>
  );

  // Resolves once the draft is gone (the dialog then closes and confirms); throws to
  // keep the dialog open with the reason inside it. A draft that was already discarded
  // or made active elsewhere isn't a failure to retry: the screen moves on to the
  // binder as it is now and says why.
  async function discardDraft(): Promise<boolean> {
    const revision = revisionRef.current;
    if (!versionId || revision === undefined || discarding) return false;
    setDiscarding(true);
    try {
      await binderApi.discardDraft(versionId, revision);
      queryClient.removeQueries({ queryKey: queryKeys.binders.version(versionId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.binders.list() });
      if (mountedRef.current) navigate({ page: 1, q: '' }, false);
      return true;
    } catch (cause) {
      if (!(cause instanceof ApiError && cause.status === 404)) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.binders.version(versionId) });
        throw cause;
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.binders.list() });
      if (mountedRef.current) {
        setPanel(null);
        navigate({ page: 1, q: '' }, false);
      }
      toast(
        'error',
        'This draft no longer exists; it was discarded or made active somewhere else. Showing the binder as it is now.',
      );
      return false;
    } finally {
      if (mountedRef.current) setDiscarding(false);
    }
  }

  // Growing the binder from the "needs more room" prompt finishes the action that asked
  // for the room, so it doesn't have to be set up again from scratch.
  async function resizeThenRetry(value: number): Promise<void> {
    if (!versionId) return;
    const need = writer.capacityNeed;
    const ok = await run(
      `Binder capacity is now ${value.toLocaleString('en-AU')} pockets.`,
      (revision) => binderApi.resize(versionId, value, revision),
      null,
    );
    if (ok && need && value >= need.required) {
      writer.clearCapacityNeed();
      await need.retry();
    }
  }

  // Sends the whole new order, which is what the page-order endpoint takes; the moved
  // page is where the binder opens afterwards.
  function movePageTo(to: number): Promise<boolean> {
    const ids = summary.data?.pageIds ?? [];
    if (!versionId || ids.length !== pageCount || to === pageIndex) return Promise.resolve(false);
    return run(
      `Page ${pageIndex + 1} moved to page ${to + 1}.`,
      (revision) => binderApi.reorderPages(versionId, movedPageOrder(ids, pageIndex, to), revision),
      { page: to, row: 0, column: 0 },
    );
  }

  function reorder(direction: -1 | 1): void {
    const ids = [...(summary.data?.pageIds ?? [])];
    const target = pageIndex + direction;
    const currentId = ids[pageIndex];
    const targetId = ids[target];
    if (!versionId || !currentId || !targetId) return;
    ids[pageIndex] = targetId;
    ids[target] = currentId;
    void run(
      direction < 0 ? 'Page moved earlier.' : 'Page moved later.',
      (revision) => binderApi.reorderPages(versionId, ids, revision),
      { page: target, row: 0, column: 0 },
    );
  }
}
