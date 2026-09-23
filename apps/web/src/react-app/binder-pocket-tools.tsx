import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { BinderSlotLocation } from '@pokedex/shared';

export type PocketTool = 'same' | 'any' | 'shift' | 'remove' | 'placement' | 'insert' | 'reserve';
const tools: Array<{ tool: PocketTool; label: string; path: string }> = [
  {
    tool: 'same',
    label: 'Replace with same type',
    path: 'M5 7h12l-3-3m3 3-3 3M19 17H7l3 3m-3-3 3-3',
  },
  {
    tool: 'any',
    label: 'Replace with any card',
    path: 'M14 14l6 6M16 9a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  },
  { tool: 'shift', label: 'Insert a gap or shift sleeves', path: 'M12 4v16M4 12h16' },
  {
    tool: 'remove',
    label: 'Remove card',
    path: 'M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7',
  },
  { tool: 'placement', label: 'Owned copies and page break', path: 'M5 3v18M5 4h13l-3 5 3 5H5' },
  { tool: 'insert', label: 'Insert targets here', path: 'M4 3h12v18H4zM16 12h6M19 9v6' },
  { tool: 'reserve', label: 'Reserve sleeve', path: 'M5 3h14v18l-7-5-7 5z' },
];

export function PocketTools({
  target,
  reserved,
  pending,
  alignEnd,
  onTool,
}: {
  target: boolean;
  reserved: boolean;
  pending: boolean;
  alignEnd: boolean;
  onTool: (tool: PocketTool) => void;
}): ReactElement {
  const rail = useRef<HTMLDivElement | null>(null);
  const [left, setLeft] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const update = () => {
      const element = rail.current;
      if (!element || !element.parentElement) return;
      if (window.innerWidth > 820) {
        setLeft(undefined);
        return;
      }
      const rect = element.parentElement.getBoundingClientRect();
      setLeft(
        Math.max(16, Math.min(rect.left, window.innerWidth - 16 - element.offsetWidth)) - rect.left,
      );
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [target, reserved]);
  const visible = target
    ? ['same', 'any', 'shift', 'remove', 'placement']
    : reserved
      ? ['insert', 'remove']
      : ['insert', 'reserve'];
  return (
    <div
      ref={rail}
      style={left === undefined ? undefined : { left, right: 'auto' }}
      className={`binder-pocket-tools${alignEnd ? ' align-end' : ''}`}
      role="toolbar"
      aria-label="Selected pocket tools"
    >
      {tools
        .filter(({ tool }) => visible.includes(tool))
        .map(({ tool, label, path }) => (
          <button
            key={tool}
            type="button"
            className="icon-button"
            title={label}
            aria-label={label}
            disabled={pending}
            onClick={() => onTool(tool)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d={path} />
            </svg>
          </button>
        ))}
    </div>
  );
}

export function PocketPanel({
  anchor,
  title,
  wide = false,
  children,
  footer,
  onClose,
}: {
  anchor: BinderSlotLocation | null;
  title: string;
  wide?: boolean;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
}): ReactElement {
  const panel = useRef<HTMLElement | null>(null);
  const close = useRef(onClose);
  const [position, setPosition] = useState({ left: 16, top: 16, modal: wide });
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);
  useLayoutEffect(() => {
    const update = () => {
      const element = panel.current;
      if (!element) return;
      const modal = wide || window.innerWidth <= 820;
      const rect = anchor
        ? document
            .querySelector(`[data-binder-slot="${anchor.page}-${anchor.row}-${anchor.column}"]`)
            ?.getBoundingClientRect()
        : null;
      const width = Math.min(wide ? 640 : 360, window.innerWidth - 32);
      const left =
        modal || !rect
          ? (window.innerWidth - width) / 2
          : rect.right + width + 24 <= window.innerWidth
            ? rect.right + 12
            : Math.max(16, rect.left - width - 12);
      const top =
        modal || !rect
          ? Math.min(64, window.innerHeight * 0.08)
          : Math.max(16, Math.min(rect.top, window.innerHeight - 520));
      setPosition((current) =>
        current.left === left && current.top === top && current.modal === modal
          ? current
          : { left, top, modal },
      );
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    if (panel.current) observer?.observe(panel.current);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [anchor, wide]);
  useEffect(() => {
    if (!position.modal) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [position.modal]);
  useEffect(() => {
    const trigger = document.activeElement;
    panel.current
      ?.querySelector<HTMLButtonElement>('.pocket-panel-close')
      ?.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close.current();
      }
      if (event.key === 'Tab' && panel.current?.getAttribute('aria-modal') === 'true') {
        const controls = Array.from(
          panel.current.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]',
          ),
        ).filter((node) => node.getClientRects().length > 0);
        const first = controls[0],
          last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      if (!panel.current?.contains(event.target) && !event.target.closest('.binder-pocket-tools'))
        close.current();
    };
    document.addEventListener('keydown', keydown);
    document.addEventListener('pointerdown', outside);
    return () => {
      document.removeEventListener('keydown', keydown);
      document.removeEventListener('pointerdown', outside);
      if (trigger instanceof HTMLElement && trigger.isConnected)
        trigger.focus({ preventScroll: true });
    };
  }, []);
  return (
    <>
      {position.modal ? <div className="pocket-panel-backdrop" aria-hidden="true" /> : null}
      <section
        ref={panel}
        className={`surface pocket-editor-popup${wide ? ' wide' : ''}`}
        role="dialog"
        aria-label={title}
        aria-modal={position.modal}
        style={{
          left: position.left,
          top: position.top,
          maxHeight: `calc(100dvh - ${position.top + 16}px)`,
        }}
      >
        <header className="pocket-panel-heading">
          <h2>{title}</h2>
          <button
            className="icon-button pocket-panel-close"
            type="button"
            aria-label="Close pocket editor"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div className="pocket-panel-body">{children}</div>
        {footer ? <footer className="pocket-panel-footer">{footer}</footer> : null}
      </section>
    </>
  );
}
