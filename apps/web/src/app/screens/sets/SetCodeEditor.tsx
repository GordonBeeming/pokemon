import type { CatalogueSet } from '@pokedex/shared';
import { useState, type ReactElement } from 'react';
import { usePatchSetCode } from '../../api/queries/sets';
import { Dialog } from '../../ui/Dialog';
import { Icon } from '../../ui/icons';
import { useOverlayAction } from '../../ui/overlay';

/**
 * Owner-editable code for a set without a TCGdex-supplied one (or to disambiguate
 * a 30C-style clash) — FEATURES.md's "Sets without a TCGdex-supplied code ... get
 * an owner-editable code" and "two sets that would otherwise share a code ... are
 * disambiguated". Hidden entirely by the caller when the visitor isn't an admin.
 */
export function SetCodeEditor({ set, clash }: { set: CatalogueSet; clash: boolean }): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="set-code-edit-button"
        aria-label={`Edit code for ${set.setName}`}
        onClick={() => setOpen(true)}
      >
        <Icon name="pencil" />
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`Edit code — ${set.setName}`}>
        <SetCodeForm set={set} clash={clash} onCancel={() => setOpen(false)} />
      </Dialog>
    </>
  );
}

function SetCodeForm({
  set,
  clash,
  onCancel,
}: {
  set: CatalogueSet;
  clash: boolean;
  onCancel: () => void;
}): ReactElement {
  const [code, setCode] = useState(set.code ?? '');
  const patch = usePatchSetCode();
  const action = useOverlayAction();
  const busy = patch.isPending || action.pending;

  function save(): void {
    const trimmed = code.trim();
    void action.run(() => patch.mutateAsync({ setId: set.setId, code: trimmed || null }), {
      success: trimmed
        ? `${set.setName}'s code is now ${trimmed.toUpperCase()}.`
        : `${set.setName}'s code was cleared.`,
      failure: 'Could not save that code.',
    });
  }

  return (
    <form
      className="set-code-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) save();
      }}
    >
      {clash ? (
        <p role="alert">
          This code is shared with another set. Choose a distinct code so card frames tell them
          apart.
        </p>
      ) : null}
      <label>
        Set code (letters, numbers, hyphens — up to 8 characters)
        <input
          value={code}
          maxLength={8}
          autoFocus
          autoCapitalize="characters"
          onChange={(event) => setCode(event.target.value.toUpperCase())}
        />
      </label>
      <div className="dialog-actions">
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="dialog-action-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save code'}
        </button>
      </div>
    </form>
  );
}
