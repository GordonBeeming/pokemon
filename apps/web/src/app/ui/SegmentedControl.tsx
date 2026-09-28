import type { ReactElement } from 'react';
import './primitives.css';

export function SegmentedControl<Value extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ value: Value; label: string }>;
  value: Value;
  onChange: (value: Value) => void;
}): ReactElement {
  return (
    <div className="segmented-control" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          className={option.value === value ? 'segmented-control-option-active' : undefined}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
