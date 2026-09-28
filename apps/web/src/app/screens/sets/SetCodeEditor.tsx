import type { CatalogueSet } from '@pokedex/shared';
import { useState, type ReactElement } from 'react';
import { usePatchSetCode } from '../../api/queries/sets';
import { Dialog } from '../../ui/Dialog';
import { Icon } from '../../ui/icons';
import { useToast } from '../../ui/Toast';

/**
 * Owner-editable code for a set without a TCGdex-supplied one (or to disambiguate
 * a 30C-style clash) — FEATURES.md's "Sets without a TCGdex-supplied code ... get
 * an owner-editable code" and "two sets that would otherwise share a code ... are
 * disambiguated". Hidden entirely by the caller when the visitor isn't an admin.
 */
export function SetCodeEditor({ set, clash }: { set: CatalogueSet; clash: boolean }): ReactElement {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState(set.code ?? '');
  const patch = usePatchSetCode();
  const toast = useToast();

  async function save(): Promise<void> {
    const trimmed = code.trim();
    try {
      await patch.mutateAsync({ setId: set.setId, code: trimmed || null });
      setOpen(false);
      toast(
        'success',
        trimmed
          ? `${set.setName}'s code is now ${trimmed.toUpperCase()}.`
          : `${set.setName}'s code was cleared.`,
      );
    } catch (cause) {
      toast('error', cause instanceof Error ? cause.message : 'Could not save that code.');
    }
  }

  return (
    <>
      <button
        type="button"
        className="set-code-edit-button"
        aria-label={`Edit code for ${set.setName}`}
        onClick={() => {
          setCode(set.code ?? '');
          setOpen(true);
        }}
      >
        <Icon name="pencil" />
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`Edit code — ${set.setName}`}>
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
            onChange={(event) => setCode(event.target.value.toUpperCase())}
          />
        </label>
        <div className="dialog-actions">
          <button type="button" onClick={() => setOpen(false)} disabled={patch.isPending}>
            Cancel
          </button>
          <button
            type="button"
            className="dialog-action-primary"
            onClick={() => void save()}
            disabled={patch.isPending}
          >
            {patch.isPending ? 'Saving…' : 'Save code'}
          </button>
        </div>
      </Dialog>
    </>
  );
}
