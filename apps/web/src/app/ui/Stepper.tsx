import type { ReactElement } from 'react';
import { Icon } from './icons';
import './primitives.css';

/** A quantity stepper — copies owned, page jumps, anywhere a bounded integer needs
 * both a keyboard-friendly control and large enough touch targets for phone. */
export function Stepper({
  label,
  value,
  min = 0,
  max = 9999,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  onChange: (value: number) => void;
}): ReactElement {
  return (
    <div className="stepper" role="group" aria-label={label}>
      <button
        type="button"
        aria-label={`Decrease ${label}`}
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
      >
        <Icon name="minus" />
      </button>
      <output aria-live="polite">{value}</output>
      <button
        type="button"
        aria-label={`Increase ${label}`}
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
      >
        <Icon name="plus" />
      </button>
    </div>
  );
}
