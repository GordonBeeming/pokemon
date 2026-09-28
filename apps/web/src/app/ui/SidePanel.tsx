import type { ReactElement, ReactNode } from 'react';
import { Overlay } from './overlay';

/** A panel that slides in from the right — the card inspector, filters, and similar
 * secondary surfaces that stay anchored to the edge instead of centering like Dialog.
 * On a phone it fills the screen. */
export function SidePanel({
  open,
  onClose,
  title,
  toolbar,
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Controls that take the header row in place of the visible title (the
   * inspector's previous/next), so they don't cost a second row above the content.
   * The title still names the dialog for assistive tech. */
  toolbar?: ReactNode;
  /** Extra class on the backdrop (a screen's style scope). */
  className?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <Overlay
      variant="side"
      className={className}
      open={open}
      onClose={onClose}
      title={title}
      toolbar={toolbar}
    >
      {children}
    </Overlay>
  );
}
