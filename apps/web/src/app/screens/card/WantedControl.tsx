import { useState, type ReactElement } from 'react';
import { useBinders } from '../../api/queries/binders';
import { useWantedScopes, useSetWanted } from '../../api/queries/wanted';
import { Link } from '@tanstack/react-router';
import './wanted-control.css';
export function WantedControl({
  cardId,
  binderId,
}: {
  cardId: string;
  binderId?: string | null;
}): ReactElement {
  const [scope, setScope] = useState(binderId ?? 'general');
  const lists = useWantedScopes(cardId);
  const binders = useBinders();
  const mutation = useSetWanted();
  const marked = lists.data?.some((w) => w.scope === scope) ?? false;
  return (
    <section className="wanted-control" aria-label="Wanted lists">
      <div className="wanted-control-heading">
        <h3>Wanted</h3>
        <Link
          to="/wanted"
          search={{ scope: 'all', includeUnfilled: false, q: '', sort: 'name', offset: 0 }}
        >
          Open shopping list
        </Link>
      </div>
      <div className="wanted-control-actions">
        <label>
          List
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            disabled={mutation.isPending}
          >
            <option value="general">General</option>
            {binders.data?.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          aria-pressed={marked}
          disabled={lists.isPending || lists.isError || mutation.isPending}
          onClick={() =>
            mutation.mutate({
              cardId,
              binderId: scope === 'general' ? null : scope,
              wanted: !marked,
            })
          }
        >
          {mutation.isPending ? 'Saving…' : marked ? 'Wanted ✓' : 'Mark as wanted'}
        </button>
      </div>
      {lists.isError ? (
        <p role="alert">
          Wanted status could not load.{' '}
          <button type="button" onClick={() => void lists.refetch()}>
            Try again
          </button>
        </p>
      ) : null}
      {mutation.isError ? <p role="alert">Could not update the wanted list. Try again.</p> : null}
      {lists.data?.length ? (
        <p className="wanted-control-status" role="status">
          Wanted for {lists.data.map((w) => w.binderName ?? 'General').join(', ')}.
        </p>
      ) : (
        <p className="wanted-control-status">Choose the list you want this card for.</p>
      )}
    </section>
  );
}
