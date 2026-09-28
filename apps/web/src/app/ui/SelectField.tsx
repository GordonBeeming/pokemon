import type { ReactElement } from 'react';
import {
  Button,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  Select,
  SelectValue,
} from 'react-aria-components';
import { Icon } from './icons';
import './primitives.css';

export interface SelectOption<Value extends string> {
  value: Value;
  label: string;
  disabled?: boolean;
}

/**
 * A single-choice picker (region, sort, binder, role, jump to bookmark). The list is
 * a popover the width of the trigger, kept inside the screen, with the same keyboard
 * and screen-reader behaviour as a native select but our own look.
 */
export function SelectField<Value extends string>({
  label,
  hideLabel = false,
  value,
  options,
  placeholder,
  disabled = false,
  className,
  onChange,
}: {
  label: string;
  /** Keeps the label for assistive tech only (a bar with no room for one). */
  hideLabel?: boolean;
  /** Null shows the placeholder. */
  value: Value | null;
  options: ReadonlyArray<SelectOption<Value>>;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  onChange: (value: Value) => void;
}): ReactElement {
  return (
    <Select
      className={className ? `select-field ${className}` : 'select-field'}
      selectedKey={value}
      placeholder={placeholder}
      isDisabled={disabled}
      disabledKeys={options.filter((option) => option.disabled).map((option) => option.value)}
      onSelectionChange={(key) => {
        const option = options.find((item) => item.value === key);
        if (option) onChange(option.value);
      }}
    >
      <Label className={hideLabel ? 'sr-only' : 'select-label'}>{label}</Label>
      <Button className="select-trigger">
        <SelectValue className="select-value" />
        <Icon name="chevron-down" className="select-chevron" />
      </Button>
      <Popover className="select-popover" offset={4} containerPadding={8}>
        <ListBox className="select-list">
          {options.map((option) => (
            <ListBoxItem
              key={option.value}
              id={option.value}
              textValue={option.label}
              className="select-item"
            >
              {option.label}
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </Select>
  );
}
