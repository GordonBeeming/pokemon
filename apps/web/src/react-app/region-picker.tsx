import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';

export interface RegionOption {
  value: string;
  count: number;
}

function optionLabel(option: RegionOption | undefined): string {
  if (!option) return 'All';
  return `${option.value} (${option.count.toLocaleString('en-AU')})`;
}

export function RegionPicker({
  value,
  options,
  onChange,
}: {
  value: string;
  options: RegionOption[];
  onChange: (value: string) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const listbox = useRef<HTMLDivElement>(null);
  const labelId = useId();
  const listboxId = useId();
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const selected = options[selectedIndex] ?? options[0];

  useEffect(() => setActiveIndex(selectedIndex), [selectedIndex]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && !listbox.current?.parentElement?.contains(target))
        setOpen(false);
    };
    addEventListener('pointerdown', dismiss);
    return () => removeEventListener('pointerdown', dismiss);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => {
      listbox.current?.querySelector<HTMLElement>('[data-region-active="true"]')?.focus();
    });
  }, [open]);

  const choose = (index: number): void => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setOpen(false);
    button.current?.focus();
  };
  const onButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex(selectedIndex);
      setOpen(true);
    }
  };
  const onListboxKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Tab') {
      setTimeout(() => setOpen(false), 0);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      button.current?.focus();
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      choose(activeIndex);
      return;
    }
    const lastIndex = options.length - 1;
    const nextIndex =
      event.key === 'ArrowDown'
        ? Math.min(lastIndex, activeIndex + 1)
        : event.key === 'ArrowUp'
          ? Math.max(0, activeIndex - 1)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? lastIndex
              : null;
    if (nextIndex !== null) {
      event.preventDefault();
      setActiveIndex(nextIndex);
      listbox.current?.querySelector<HTMLElement>(`[data-region-index="${nextIndex}"]`)?.focus();
    }
  };
  const description = useMemo(
    () => `${selected?.value ?? 'All'}, ${selected?.count ?? 0} matching species`,
    [selected],
  );

  return (
    <div
      className="region-picker"
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) setOpen(false);
      }}
    >
      <span id={labelId} className="field-label">
        First found region
      </span>
      <button
        ref={button}
        className="region-picker-trigger"
        type="button"
        aria-labelledby={labelId}
        aria-describedby={`${listboxId}-description`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onButtonKeyDown}
      >
        <span>{optionLabel(selected)}</span>
        <svg className="region-picker-chevron" viewBox="0 0 16 16" aria-hidden="true">
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>
      <span id={`${listboxId}-description`} className="sr-only">
        {description}
      </span>
      {open ? (
        <div
          ref={listbox}
          id={listboxId}
          className="region-picker-popover"
          role="listbox"
          aria-labelledby={labelId}
          aria-activedescendant={`${listboxId}-option-${activeIndex}`}
          onKeyDown={onListboxKeyDown}
        >
          {options.map((option, index) => (
            <button
              key={option.value}
              id={`${listboxId}-option-${index}`}
              data-region-index={index}
              data-region-active={index === activeIndex}
              type="button"
              role="option"
              aria-selected={option.value === value}
              tabIndex={index === activeIndex ? 0 : -1}
              onFocus={() => setActiveIndex(index)}
              onClick={() => choose(index)}
            >
              <span>{optionLabel(option)}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
