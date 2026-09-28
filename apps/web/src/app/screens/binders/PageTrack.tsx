import type { BinderSlotLocation, FrameType, PeekColumns } from '@pokedex/shared';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react';
import type { BinderPageView, BinderSlotView } from '../../api/queries/binders';
import { pocketState, trackGeometry, type CardLookup } from './model';
import { Pocket } from './Pocket';

// How long a dragged card has to hover over a neighbouring page's edge before the page
// turns. Long enough that sweeping past the edge doesn't flip it by accident.
const EDGE_FLIP_DELAY_MS = 700;
// A touch has to rest this long on a card before it becomes a drag, so an ordinary
// swipe between pages still scrolls the binder instead of picking the card up.
const TOUCH_PICKUP_DELAY_MS = 350;
const MOUSE_DRAG_THRESHOLD_PX = 6;
const SWIPE_THRESHOLD_PX = 50;

export interface TrackPage {
  index: number;
  page: BinderPageView | undefined;
}

export interface PageTrackProps {
  pages: TrackPage[];
  currentIndex: number;
  pageCount: number;
  rows: number;
  columns: number;
  peek: PeekColumns;
  showFrame: boolean;
  cards: CardLookup;
  palette: Record<FrameType, string>;
  selected: BinderSlotLocation | null;
  moveSource: BinderSlotLocation | null;
  moveCursor: BinderSlotLocation | null;
  inactive: ReadonlySet<string>;
  editable: boolean;
  reducedMotion: boolean;
  onPocketClick: (at: BinderSlotLocation, slot: BinderSlotView) => void;
  onPocketKeyDown: (
    event: KeyboardEvent<HTMLButtonElement>,
    at: BinderSlotLocation,
    slot: BinderSlotView,
  ) => void;
  onDrop: (source: BinderSlotLocation, target: BinderSlotLocation) => void;
  onFlip: (delta: -1 | 1) => void;
}

export const locationKey = (at: BinderSlotLocation): string => `${at.page}:${at.row}:${at.column}`;

function sameLocation(a: BinderSlotLocation | null, b: BinderSlotLocation): boolean {
  return a !== null && a.page === b.page && a.row === b.row && a.column === b.column;
}

function parsePocketAttribute(value: string | undefined): BinderSlotLocation | null {
  const match = value ? /^(\d+):(\d+):(\d+)$/u.exec(value) : null;
  if (!match) return null;
  return { page: Number(match[1]), row: Number(match[2]), column: Number(match[3]) };
}

interface DragState {
  pointerId: number;
  source: BinderSlotLocation;
  startX: number;
  startY: number;
  touch: boolean;
  started: boolean;
  pickupTimer: ReturnType<typeof setTimeout> | null;
}

export function PageTrack(props: PageTrackProps): ReactElement {
  const { currentIndex, columns, peek, showFrame } = props;
  const viewportRef = useRef<HTMLDivElement>(null);
  const currentPageRef = useRef<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const [ghost, setGhost] = useState<{ x: number; y: number; label: string } | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const drag = useRef<DragState | null>(null);
  const flip = useRef<{ delta: -1 | 1; timer: ReturnType<typeof setTimeout> } | null>(null);
  const suppressClick = useRef(false);
  const swipe = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const latest = useRef(props);
  latest.current = props;

  useLayoutEffect(() => {
    const element = viewportRef.current?.parentElement;
    if (!element) return;
    setWidth(element.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const geometry = trackGeometry(width || 960, columns, peek);

  useLayoutEffect(() => {
    const element = currentPageRef.current;
    if (!element) return;
    setHeight(element.offsetHeight);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setHeight(element.offsetHeight));
    observer.observe(element);
    return () => observer.disconnect();
  });

  function clearFlip(): void {
    if (flip.current) clearTimeout(flip.current.timer);
    flip.current = null;
  }

  function armFlip(delta: -1 | 1): void {
    if (flip.current?.delta === delta) return;
    clearFlip();
    const target = latest.current.currentIndex + delta;
    if (target < 0 || target >= latest.current.pageCount) return;
    flip.current = {
      delta,
      timer: setTimeout(() => {
        flip.current = null;
        latest.current.onFlip(delta);
      }, EDGE_FLIP_DELAY_MS),
    };
  }

  function endDrag(): void {
    const state = drag.current;
    if (state?.pickupTimer) clearTimeout(state.pickupTimer);
    drag.current = null;
    clearFlip();
    setGhost(null);
    setHover(null);
  }

  // Window-level listeners while a drag is tracked: the pointer leaves the pocket it
  // started on immediately, and may leave the viewport entirely on its way to an edge.
  useEffect(() => {
    function hitTest(x: number, y: number): BinderSlotLocation | null {
      const element = document.elementFromPoint(x, y);
      const pocket = element instanceof Element ? element.closest('[data-pocket]') : null;
      return parsePocketAttribute(pocket?.getAttribute('data-pocket') ?? undefined);
    }
    function onMove(event: PointerEvent): void {
      const state = drag.current;
      if (!state || event.pointerId !== state.pointerId) return;
      const dx = event.clientX - state.startX;
      const dy = event.clientY - state.startY;
      if (!state.started) {
        if (state.touch) {
          // Moving before the pickup delay means this touch is a scroll or swipe.
          if (Math.hypot(dx, dy) > 10) endDrag();
          return;
        }
        if (Math.hypot(dx, dy) < MOUSE_DRAG_THRESHOLD_PX) return;
        state.started = true;
      }
      event.preventDefault();
      setGhost((current) => ({
        x: event.clientX,
        y: event.clientY,
        label: current?.label ?? 'Moving card',
      }));
      const over = hitTest(event.clientX, event.clientY);
      setHover(over ? locationKey(over) : null);
      const viewport = viewportRef.current?.getBoundingClientRect();
      const g = geometry;
      if (!viewport) return;
      const leftEdge = viewport.left + Math.max(g.offset, 24);
      const rightEdge = viewport.right - Math.max(g.offset, 24);
      if (event.clientX < leftEdge) armFlip(-1);
      else if (event.clientX > rightEdge) armFlip(1);
      else clearFlip();
    }
    function onUp(event: PointerEvent): void {
      const state = drag.current;
      if (!state || event.pointerId !== state.pointerId) return;
      if (state.started) {
        suppressClick.current = true;
        const target = hitTest(event.clientX, event.clientY);
        if (target && !sameLocation(state.source, target))
          latest.current.onDrop(state.source, target);
      }
      endDrag();
    }
    function onCancel(event: PointerEvent): void {
      if (drag.current && event.pointerId === drag.current.pointerId) endDrag();
    }
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
  });

  useEffect(() => () => endDrag(), []);

  function pocketPointerDown(
    event: ReactPointerEvent<HTMLButtonElement>,
    at: BinderSlotLocation,
    slot: BinderSlotView,
    label: string,
  ): void {
    if (!props.editable || at.page !== currentIndex || pocketState(slot) === 'empty') return;
    if (event.button !== 0) return;
    const touch = event.pointerType !== 'mouse';
    const state: DragState = {
      pointerId: event.pointerId,
      source: at,
      startX: event.clientX,
      startY: event.clientY,
      touch,
      started: false,
      pickupTimer: null,
    };
    if (touch)
      state.pickupTimer = setTimeout(() => {
        if (drag.current !== state) return;
        state.started = true;
        setGhost({ x: state.startX, y: state.startY, label });
      }, TOUCH_PICKUP_DELAY_MS);
    drag.current = state;
    setGhost(null);
    // Seed the ghost label now so the first move shows the right name.
    setTimeout(() => {
      if (drag.current === state && state.started)
        setGhost((current) => (current ? { ...current, label } : current));
    }, 0);
  }

  function viewportPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.pointerType === 'mouse') return;
    swipe.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  }
  function viewportPointerUp(event: ReactPointerEvent<HTMLDivElement>): void {
    const start = swipe.current;
    swipe.current = null;
    if (!start || start.pointerId !== event.pointerId || drag.current?.started) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) > SWIPE_THRESHOLD_PX && Math.abs(dx) > Math.abs(dy) * 1.5) {
      suppressClick.current = true;
      props.onFlip(dx < 0 ? 1 : -1);
    }
  }

  const trackX = geometry.offset - currentIndex * geometry.stride;
  const firstPeekColumn = columns - peek;

  return (
    <div className="page-track-frame">
      <div
        ref={viewportRef}
        className="page-track-viewport"
        style={{ width: geometry.viewportWidth, height: height || undefined }}
        onPointerDown={viewportPointerDown}
        onPointerUp={viewportPointerUp}
        onClickCapture={(event) => {
          if (suppressClick.current) {
            suppressClick.current = false;
            event.stopPropagation();
            event.preventDefault();
          }
        }}
      >
        <div
          className="page-track"
          style={{
            transform: `translateX(${trackX}px)`,
            transition: props.reducedMotion
              ? 'none'
              : 'transform 360ms cubic-bezier(0.2, 0.7, 0.2, 1)',
          }}
        >
          {props.pages.map(({ index, page }) => {
            const direction = index < currentIndex ? -1 : index > currentIndex ? 1 : 0;
            const reserved = page?.kind === 'reserved';
            return (
              <section
                key={index}
                ref={
                  direction === 0 ? (element) => void (currentPageRef.current = element) : undefined
                }
                className={`binder-page${direction === 0 ? '' : ' binder-page-peek'}${reserved ? ' binder-page-reserved' : ''}`}
                aria-label={
                  direction === 0 ? `Page ${index + 1}` : `Page ${index + 1}, neighbouring`
                }
                aria-hidden={direction !== 0 && peek === 0 ? true : undefined}
                style={{
                  left: index * geometry.stride,
                  width: geometry.pageWidth,
                  padding: geometry.pad,
                  gap: geometry.gap,
                }}
              >
                {reserved ? (
                  <p className="binder-page-reserved-label">
                    Reserved page{page.label ? `: ${page.label}` : ''}
                  </p>
                ) : null}
                <div
                  className="binder-page-grid"
                  style={{
                    gridTemplateColumns: `repeat(${columns}, ${geometry.pocketWidth}px)`,
                    gap: geometry.gap,
                  }}
                >
                  {page
                    ? page.slots.map((slot) => {
                        const at = { page: index, row: slot.row, column: slot.column };
                        const key = locationKey(at);
                        const isSelected = sameLocation(props.selected, at);
                        const peekEdge =
                          showFrame && direction === -1 && slot.column === firstPeekColumn
                            ? 'left'
                            : showFrame && direction === 1 && slot.column === peek - 1
                              ? 'right'
                              : undefined;
                        const focusable =
                          direction === 0 &&
                          (isSelected ||
                            (props.selected === null && slot.row === 0 && slot.column === 0) ||
                            (props.selected !== null &&
                              props.selected.page !== currentIndex &&
                              slot.row === 0 &&
                              slot.column === 0));
                        return (
                          <Pocket
                            key={key}
                            slot={slot}
                            at={at}
                            cards={props.cards}
                            palette={props.palette}
                            showFrame={showFrame}
                            peekEdge={peek > 0 ? peekEdge : undefined}
                            selected={isSelected}
                            moveSource={sameLocation(props.moveSource, at)}
                            moveCursor={sameLocation(props.moveCursor, at)}
                            dropHover={hover === key}
                            inactive={props.inactive.has(key)}
                            tabIndex={focusable ? 0 : -1}
                            onClick={() => props.onPocketClick(at, slot)}
                            onKeyDown={(event) => props.onPocketKeyDown(event, at, slot)}
                            onPointerDown={(event) =>
                              pocketPointerDown(event, at, slot, slot.label ?? 'Moving card')
                            }
                          />
                        );
                      })
                    : Array.from({ length: props.rows * columns }, (_unused, cell) => (
                        <span
                          key={cell}
                          className="pocket-skeleton"
                          style={{ width: geometry.pocketWidth }}
                          aria-hidden="true"
                        />
                      ))}
                </div>
              </section>
            );
          })}
        </div>
      </div>
      {ghost ? (
        <div
          className="pocket-drag-ghost"
          style={{ left: ghost.x, top: ghost.y }}
          role="status"
          aria-live="polite"
        >
          {flip.current ? 'Hold to turn the page' : 'Drop on a pocket to move'}
        </div>
      ) : null}
    </div>
  );
}
