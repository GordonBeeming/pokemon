import type { ReactElement, ReactNode } from 'react';
import { Dialog } from '../../../ui/Dialog';
import { Sheet } from '../../../ui/Sheet';
import { PHONE_QUERY, useMediaQuery } from '../useMediaQuery';

/** Every pocket tool opens in the same surface: a dialog on desktop, a bottom sheet on
 * phone. Both trap focus and hand it back to the control that opened them. */
export function Panel({
  title,
  onClose,
  wide = false,
  bare = false,
  children,
}: {
  title: string;
  onClose: () => void;
  wide?: boolean;
  /** Skip the binder panel styling, for embedded screens that bring their own. */
  bare?: boolean;
  children: ReactNode;
}): ReactElement | null {
  const phone = useMediaQuery(PHONE_QUERY);
  if (phone)
    return (
      <Sheet open onClose={onClose} title={title}>
        {bare ? children : <div className="binder-panel">{children}</div>}
      </Sheet>
    );
  return (
    <Dialog open onClose={onClose} title={title} wide={wide}>
      {bare ? children : <div className="binder-panel">{children}</div>}
    </Dialog>
  );
}
