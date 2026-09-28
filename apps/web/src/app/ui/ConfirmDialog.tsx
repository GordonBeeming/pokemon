import { useId, useState, type ReactElement, type ReactNode } from 'react';
import { Dialog } from './Dialog';
import './primitives.css';

export function ConfirmDialog({
  open,
  onCancel,
  onConfirm,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  pending = false,
  /** e.g. a binder's name — typing it back is the guard for an unrecoverable delete. */
  requireTypedConfirmation,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  pending?: boolean;
  requireTypedConfirmation?: string;
}): ReactElement {
  const inputId = useId();
  const [typed, setTyped] = useState('');
  const guardSatisfied =
    requireTypedConfirmation === undefined || typed === requireTypedConfirmation;

  return (
    <Dialog open={open} onClose={onCancel} title={title}>
      {description ? <p>{description}</p> : null}
      {requireTypedConfirmation !== undefined ? (
        <p className="confirm-dialog-typed-guard">
          <label htmlFor={inputId}>
            Type <strong>{requireTypedConfirmation}</strong> to confirm
          </label>
          <input
            id={inputId}
            type="text"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
          />
        </p>
      ) : null}
      <div className="dialog-actions">
        <button type="button" onClick={onCancel} disabled={pending}>
          {cancelLabel}
        </button>
        <button
          type="button"
          className={destructive ? 'dialog-action-destructive' : 'dialog-action-primary'}
          onClick={onConfirm}
          disabled={pending || !guardSatisfied}
        >
          {pending ? 'Working…' : confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}
