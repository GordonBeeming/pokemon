import { useState, type ReactElement } from 'react';
import { useCreateCustomCard } from '../../api/queries/catalogue';
import { useToast } from '../../ui/Toast';

/** "Add a card that is not in TCGdex" — fixed language/category/set metadata, per
 * FEATURES.md's Catalogue section. Rendered inside the Catalogue's More menu
 * dialog; `onClose` closes it once the card exists. */
export function CustomCardForm({ onClose }: { onClose: () => void }): ReactElement {
  const [name, setName] = useState('');
  const create = useCreateCustomCard();
  const toast = useToast();

  async function submit(): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      await create.mutateAsync(trimmed);
      setName('');
      toast('success', 'Custom card added.');
      onClose();
    } catch (cause) {
      toast('error', cause instanceof Error ? cause.message : 'Could not add that card.');
    }
  }

  return (
    <form
      className="catalogue-dialog-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
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
        <button
          type="submit"
          className="dialog-action-primary"
          disabled={!name.trim() || create.isPending}
        >
          {create.isPending ? 'Adding…' : 'Add custom card'}
        </button>
      </div>
    </form>
  );
}
