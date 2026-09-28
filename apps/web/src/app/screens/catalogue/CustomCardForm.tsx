import { useState, type ReactElement } from 'react';
import { useCreateCustomCard } from '../../api/queries/catalogue';
import { useOverlayAction } from '../../ui/overlay';

/** "Add a card that is not in TCGdex" — fixed language/category/set metadata, per
 * FEATURES.md's Catalogue section. Rendered inside the Catalogue's More menu
 * dialog, which closes itself once the card exists. */
export function CustomCardForm({ onClose }: { onClose: () => void }): ReactElement {
  const [name, setName] = useState('');
  const create = useCreateCustomCard();
  const action = useOverlayAction();
  const busy = create.isPending || action.pending;

  function submit(): void {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    void action.run(() => create.mutateAsync(trimmed), {
      success: 'Custom card added.',
      failure: 'Could not add that card.',
    });
  }

  return (
    <form
      className="catalogue-dialog-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <p className="catalogue-dialog-hint">
        It gets fixed language, category and set details, so there is nothing else to choose.
      </p>
      <label>
        Custom card name
        <input value={name} maxLength={200} onChange={(event) => setName(event.target.value)} />
      </label>
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="dialog-action-primary" disabled={!name.trim() || busy}>
          {busy ? 'Adding…' : 'Add custom card'}
        </button>
      </div>
    </form>
  );
}
