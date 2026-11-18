import type { FrameType } from '@pokedex/shared';
import type { ReactElement } from 'react';
import type { ResolvedCard } from '../../../api/queries/binders';
import { useSetWanted, useWantedScopes } from '../../../api/queries/wanted';
import { CardFrame } from '../../../cards/CardFrame';
import { binderErrorMessage, frameCardFrom } from '../model';

/** Wishlist clicks only change the chosen list, never the pocket or collection. */
export function WantedTile({
  card,
  binderId,
  palette,
}: {
  card: ResolvedCard;
  binderId: string | null;
  palette: Record<FrameType, string>;
}): ReactElement {
  const scopes = useWantedScopes(card.id);
  const mutation = useSetWanted();
  const wanted = scopes.data?.some((s) => s.scope === (binderId ?? 'general')) ?? false;
  const busy = scopes.isPending || mutation.isPending;
  return (
    <div className="find-wanted-tile">
      <button
        type="button"
        className="card-picker-item find-cards-item"
        aria-pressed={wanted}
        aria-label={`${wanted ? 'Remove' : 'Add'} ${card.name} ${wanted ? 'from' : 'to'} wishlist`}
        disabled={busy || scopes.isError}
        onClick={() => mutation.mutate({ cardId: card.id, binderId, wanted: !wanted })}
      >
        <CardFrame card={frameCardFrom(card)} state="owned" forceSolid palette={palette} />
        <span className="card-picker-name">{card.name}</span>
        <span className="card-picker-meta">
          {card.number} · {card.setName}
        </span>
        <span className="find-cards-action">
          {scopes.isPending
            ? 'Loading…'
            : mutation.isPending
              ? 'Saving…'
              : wanted
                ? '✓ Wanted'
                : '+ Add to wishlist'}
        </span>
      </button>
      {scopes.isError ? (
        <p role="alert">
          Wishlist status could not load.{' '}
          <button type="button" onClick={() => void scopes.refetch()}>
            Try again
          </button>
        </p>
      ) : null}
      {mutation.isError ? <p role="alert">{binderErrorMessage(mutation.error)}</p> : null}
    </div>
  );
}
