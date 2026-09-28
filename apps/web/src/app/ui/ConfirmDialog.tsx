import { useId, useState, type ReactElement, type ReactNode } from 'react';
import { Dialog } from './Dialog';
import { useOverlayAction, type OverlayActionOptions } from './overlay';
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
  success,
  describeError,
  /** e.g. a binder's name — typing it back is the guard for an unrecoverable delete. */
  requireTypedConfirmation,
}: {
  open: boolean;
  /** Closes the dialog: Cancel, Escape, the backdrop, the ×, and a confirmed action
   * that succeeded all end here. */
  onCancel: () => void;
  /** Return the request's promise to have the dialog close itself when it succeeds
   * (then toast `success`) and keep the error inside the dialog when it fails. */
  onConfirm: () => void | Promise<unknown>;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  pending?: boolean;
  success?: OverlayActionOptions<unknown>['success'];
  describeError?: (cause: unknown) => string;
  requireTypedConfirmation?: string;
}): ReactElement {
  return (
    <Dialog open={open} onClose={onCancel} title={title}>
      <ConfirmBody
        onCancel={onCancel}
        onConfirm={onConfirm}
        description={description}
        confirmLabel={confirmLabel}
        cancelLabel={cancelLabel}
        destructive={destructive}
        pending={pending}
        success={success}
        describeError={describeError}
        requireTypedConfirmation={requireTypedConfirmation}
      />
    </Dialog>
  );
}

function ConfirmBody({
  onCancel,
  onConfirm,
  description,
  confirmLabel,
  cancelLabel,
  destructive,
  pending,
  success,
  describeError,
  requireTypedConfirmation,
}: {
  onCancel: () => void;
  onConfirm: () => void | Promise<unknown>;
  description?: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  destructive: boolean;
  pending: boolean;
  success?: OverlayActionOptions<unknown>['success'];
  describeError?: (cause: unknown) => string;
  requireTypedConfirmation?: string;
}): ReactElement {
  const inputId = useId();
  const [typed, setTyped] = useState('');
  const action = useOverlayAction();
  const busy = pending || action.pending;
  const guardSatisfied =
    requireTypedConfirmation === undefined || typed === requireTypedConfirmation;

  function confirm(): void {
    const result = onConfirm();
    if (result instanceof Promise) void action.run(() => result, { success, describeError });
  }

  return (
    <>
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
        <button type="button" onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </button>
        <button
          type="button"
          className={destructive ? 'dialog-action-destructive' : 'dialog-action-primary'}
          onClick={confirm}
          disabled={busy || !guardSatisfied}
        >
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </>
  );
}
