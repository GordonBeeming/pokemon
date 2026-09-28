import { useCallback, useId, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import {
  Button,
  Dialog as AriaDialog,
  DialogTrigger,
  Menu,
  MenuItem as AriaMenuItem,
  MenuTrigger,
  Popover,
  Text,
} from 'react-aria-components';
import { OverlaySurfaceProvider } from './overlay';
import './primitives.css';

/**
 * One small trigger that opens a popover of secondary actions and collapses again —
 * the progressive-disclosure pattern every control bar uses instead of laying rarely
 * used options out before anyone asks for them. React Aria places the popover against
 * the trigger and keeps it inside the screen (flipping when a wrapped phone bar puts
 * the trigger near an edge), and handles arrow keys, typeahead, Escape, outside
 * presses and focus return.
 *
 * `children` receives `close` so an item that keeps the menu open while it works
 * (`closeOnSelect={false}`) can close it once it's done. `kind="dialog"` is for a
 * small settings popover (form controls rather than menu items): it stays open while
 * its controls change.
 */
export function MenuButton({
  label,
  menuLabel,
  children,
  align = 'start',
  triggerLabel,
  className,
  kind = 'menu',
  popoverClassName,
}: {
  /** Visible trigger content (text and/or an icon). */
  label: ReactNode;
  /** Accessible name for the popover itself. */
  menuLabel: string;
  children: (close: () => void) => ReactNode;
  /** Which trigger edge the popover prefers to line up with; it flips when that edge
   * would run off-screen. */
  align?: 'start' | 'end';
  /** Accessible name for an icon-only trigger. */
  triggerLabel?: string;
  className?: string;
  kind?: 'menu' | 'dialog';
  /** Extra class on the popover: it renders at the end of the document, so a
   * screen's style scope has to be handed to it. */
  popoverClassName?: string;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // React Aria names a menu after its trigger by default; the popover gets its own,
  // fuller name ("Copy catalogue cards" rather than "Copy").
  const nameId = useId();
  const close = useCallback(() => setOpen(false), []);
  // Menu items that run an action report through the same surface contract as the
  // modal overlays: success closes the menu, a failure shows inside it.
  const surface = useMemo(() => ({ close, setError }), [close]);
  const onOpenChange = (next: boolean): void => {
    setOpen(next);
    if (next) setError(null);
  };

  const trigger = (
    <Button
      className={
        triggerLabel ? 'menu-button-trigger menu-button-trigger-icon' : 'menu-button-trigger'
      }
      aria-label={triggerLabel}
    >
      {label}
    </Button>
  );
  const popoverProps = {
    className: popoverClassName ? `menu-popover ${popoverClassName}` : 'menu-popover',
    placement: align === 'start' ? ('bottom start' as const) : ('bottom end' as const),
    offset: 6,
    containerPadding: 8,
  };
  const note = (
    <>
      {error ? (
        <p role="alert" className="menu-note menu-note-error">
          {error}
        </p>
      ) : null}
    </>
  );

  return (
    <div className={className ? `menu-button ${className}` : 'menu-button'}>
      {kind === 'menu' ? (
        <MenuTrigger isOpen={open} onOpenChange={onOpenChange}>
          {trigger}
          <Popover {...popoverProps}>
            {note}
            <span id={nameId} hidden>
              {menuLabel}
            </span>
            <OverlaySurfaceProvider value={surface}>
              <Menu aria-labelledby={nameId} className="menu-list">
                {children(close)}
              </Menu>
            </OverlaySurfaceProvider>
          </Popover>
        </MenuTrigger>
      ) : (
        <DialogTrigger isOpen={open} onOpenChange={onOpenChange}>
          {trigger}
          <Popover {...popoverProps}>
            <AriaDialog aria-label={menuLabel} className="menu-dialog">
              {note}
              <OverlaySurfaceProvider value={surface}>{children(close)}</OverlaySurfaceProvider>
            </AriaDialog>
          </Popover>
        </DialogTrigger>
      )}
    </div>
  );
}

/** A popover row: a label plus an optional one-line hint (or the reason it's disabled). */
export function MenuItem({
  label,
  hint,
  disabled = false,
  tone,
  closeOnSelect = true,
  onSelect,
}: {
  label: string;
  hint?: string;
  disabled?: boolean;
  tone?: 'danger';
  /** False for an item that works before the menu can go (an async copy): it closes
   * the menu itself when it's done. */
  closeOnSelect?: boolean;
  onSelect: () => void;
}): ReactElement {
  return (
    <AriaMenuItem
      textValue={label}
      className={tone === 'danger' ? 'menu-item menu-item-danger' : 'menu-item'}
      isDisabled={disabled}
      shouldCloseOnSelect={closeOnSelect}
      onAction={onSelect}
    >
      <Text slot="label" className="menu-item-label">
        {label}
      </Text>
      {hint ? (
        <Text slot="description" className="menu-item-hint">
          {hint}
        </Text>
      ) : null}
    </AriaMenuItem>
  );
}
