import { useState, type ReactElement } from 'react';
import { useCreateCustomCard } from '../../api/queries/catalogue';
import { useOverlayAction } from '../../ui/overlay';

/** "Add a card that is not in TCGdex": rarely needed, so it lives in Settings rather
 * than the catalogue's menus. The card gets fixed language, category and set details
 * and is visible only to the person who made it. */
export function CustomCardsTab(): ReactElement {
  const [name, setName] = useState('');
  const create = useCreateCustomCard();
  const action = useOverlayAction();
  const busy = create.isPending || action.pending;

  async function submit(): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    const added = await action.run(() => create.mutateAsync(trimmed), {
      success: `${trimmed} added. Find it in the catalogue by name.`,
      failure: 'Could not add that card.',
    });
    if (added) setName('');
  }

  return (
    <section className="settings-card" aria-labelledby="custom-cards-heading">
      <div className="settings-card-header">
        <h2 id="custom-cards-heading">Custom cards</h2>
      </div>
      <p className="settings-help">
        For a physical card TCGdex doesn&apos;t list. It only needs a name; the language, category
        and set are fixed, and only you can see it.
      </p>
      <form
        className="settings-inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label>
          <span>Card name</span>
          <input value={name} maxLength={200} onChange={(event) => setName(event.target.value)} />
        </label>
        <button type="submit" className="button-primary" disabled={!name.trim() || busy}>
          {busy ? 'Adding…' : 'Add custom card'}
        </button>
      </form>
    </section>
  );
}
