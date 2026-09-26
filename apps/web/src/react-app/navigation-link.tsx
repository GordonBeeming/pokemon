import type { ComponentPropsWithoutRef, ReactElement } from 'react';

/** Keep browser link gestures native; only plain clicks use local navigation. */
export function NavigationLink({
  onNavigate,
  ...props
}: Omit<ComponentPropsWithoutRef<'a'>, 'onClick'> & {
  onNavigate: () => void;
}): ReactElement {
  return (
    <a
      {...props}
      onClick={(event) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          props.download !== undefined ||
          (props.target && props.target !== '_self')
        )
          return;
        event.preventDefault();
        onNavigate();
      }}
    />
  );
}
