import type { ReactElement, ReactNode } from 'react';
import { Overlay } from './overlay';

/**
 * The phone equivalent of SidePanel: rises from the bottom, sized to its content up
 * to 85% of the dynamic viewport, and pads for the home indicator. Only the header
 * (handle, title, ×) drags it down to dismiss; the body scrolls on its own and never
 * hands a pull on to the page, so pulling inside a sheet can't trigger the browser's
 * pull-to-refresh.
 */
export function Sheet({
  open,
  onClose,
  title,
  header,
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Replaces the plain title row's visible text (a card summary, say); `title`
   * still names the dialog for assistive tech. */
  header?: ReactNode;
  /** Extra class on the backdrop (a screen's style scope). */
  className?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <Overlay
      variant="sheet"
      className={className}
      open={open}
      onClose={onClose}
      title={title}
      header={header}
    >
      {children}
    </Overlay>
  );
}
