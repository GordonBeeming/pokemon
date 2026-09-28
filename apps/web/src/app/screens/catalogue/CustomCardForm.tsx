import { useState, type ReactElement } from 'react';
import { useCreateCustomCard } from '../../api/queries/catalogue';
import { useToast } from '../../ui/Toast';

/** "Add a card that is not in TCGdex" — fixed language/category/set metadata, per
 * FEATURES.md's Catalogue section. */
export function CustomCardForm(): ReactElement {
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
    } catch (cause) {
      toast('error', cause instanceof Error ? cause.message : 'Could not add that card.');
    }
  }

  return (
    <details className="custom-card-tools">
      <summary>Add a card that is not in TCGdex</summary>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label>
          Custom card name
          <input value={name} maxLength={200} onChange={(event) => setName(event.target.value)} />
        </label>
        <button type="submit" disabled={!name.trim() || create.isPending}>
          {create.isPending ? 'Adding…' : 'Add custom card'}
        </button>
      </form>
    </details>
  );
}
