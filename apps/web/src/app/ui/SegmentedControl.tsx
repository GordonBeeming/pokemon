import type { ReactElement } from 'react';
import { Radio, RadioGroup } from 'react-aria-components';
import './primitives.css';

/** A one-of-few choice laid out as a segmented bar: a radio group underneath, so
 * arrow keys move between options and each option announces as a radio. */
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
    <RadioGroup
      className="segmented-control"
      aria-label={label}
      orientation="horizontal"
      value={value}
      onChange={(next) => {
        const option = options.find((item) => item.value === next);
        if (option) onChange(option.value);
      }}
    >
      {options.map((option) => (
        <Radio
          key={option.value}
          value={option.value}
          className={({ isSelected }) =>
            isSelected
              ? 'segmented-control-option segmented-control-option-active'
              : 'segmented-control-option'
          }
        >
          {option.label}
        </Radio>
      ))}
    </RadioGroup>
  );
}
