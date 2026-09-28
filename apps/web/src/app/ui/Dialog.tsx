import type { ReactElement, ReactNode } from 'react';
import { Overlay } from './overlay';

export function Dialog({
  open,
  onClose,
  title,
  children,
  wide = false,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Room for a result grid (binder insert/paste pickers) instead of a short form. */
  wide?: boolean;
  /** Extra class on the backdrop (a screen's style scope). */
  className?: string;
}): ReactElement {
  return (
    <Overlay
      variant="dialog"
      className={className}
      open={open}
      onClose={onClose}
      title={title}
      wide={wide}
    >
      {children}
    </Overlay>
  );
}
