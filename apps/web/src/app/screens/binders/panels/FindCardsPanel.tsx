import type { FrameType } from '@pokedex/shared';
import type { ReactElement } from 'react';
import type {
  BinderCandidate,
  BinderMutation,
  BinderSlotView,
  ResolvedCard,
} from '../../../api/queries/binders';
import { usePlaceCard } from '../../../api/queries/card';
import { CardFrame } from '../../../cards/CardFrame';
import { frameCardFrom } from '../model';
import { CardPicker } from './CardPicker';
import { Panel } from './Panel';

/** A spare owned copy that fits this pocket, with its card for the tile. */
export interface SpareCopy {
  candidate: BinderCandidate;
  card: ResolvedCard | undefined;
}

/** Adds one copy of a printing to the collection and places it in this pocket, in the
 * same single batch the card inspector's "Add a copy and place" uses. The pocket's
 * target is never rewritten: an any-printing target stays any-printing. */
export type AddAndPlace = (revision: number) => Promise<BinderMutation>;

function AddAndPlaceTile({
  card,
  palette,
  disabled,
  binderId,
  slotId,
  onAddAndPlace,
}: {
  card: ResolvedCard;
  palette: Record<FrameType, string>;
  disabled: boolean;
  binderId: string;
  slotId: string;
  onAddAndPlace: (card: ResolvedCard, place: AddAndPlace) => void;
}): ReactElement {
  const place = usePlaceCard(card.id);
  return (
    <button
      type="button"
      className="card-picker-item find-cards-item"
      disabled={disabled}
      onClick={() =>
        onAddAndPlace(card, (revision) =>
          place.mutateAsync({ binderId, slotId, addCopy: true, expectedRevision: revision }),
        )
      }
    >
      <CardFrame card={frameCardFrom(card)} state="owned" forceSolid palette={palette} />
      <span className="card-picker-name">{card.name}</span>
      <span className="card-picker-meta">
        {card.setName} · {card.number}
      </span>
      <span className="find-cards-action">Add a copy and place</span>
    </button>
  );
}

/**
 * Find cards fills this pocket and never changes what the binder wants in it (that's
 * Change target). Spare owned copies that fit come first and place with one tap; then
 * every printing that fits (every active printing of the species for an any-printing
 * target, or the one card for an exact target), each with one-tap "Add a copy and
 * place".
 */
export function FindCardsPanel({
  slot,
  title,
  reservedPage,
  editable,
  palette,
  binderId,
  slotId,
  spares,
  sparesLoading,
  sparesError,
  exactCard,
  addBlockedReason,
  pending,
  error,
  onAssign,
  onAddAndPlace,
  onUnassign,
  onPageBreak,
  onClose,
}: {
  slot: BinderSlotView;
  title: string;
  reservedPage: boolean;
  editable: boolean;
  palette: Record<FrameType, string>;
  binderId: string;
  slotId: string;
  spares: SpareCopy[] | undefined;
  sparesLoading: boolean;
  sparesError: string | null;
  /** The target's own card, for an exact-card target. */
  exactCard: ResolvedCard | undefined;
  /** Why a new copy can't be added and placed here, or null when it can. */
  addBlockedReason: string | null;
  pending: boolean;
  error: string | null;
  onAssign: (candidate: BinderCandidate) => void;
  onAddAndPlace: (card: ResolvedCard, place: AddAndPlace) => void;
  onUnassign: () => void;
  onPageBreak: (startsNewPage: boolean) => void;
  onClose: () => void;
}): ReactElement {
  const usableSpares = (spares ?? []).filter((spare) => spare.candidate.available > 0);
  const spareIds = new Set(usableSpares.map((spare) => spare.candidate.cardId));
  const addDisabled = !editable || pending || addBlockedReason !== null;
  const tile = (card: ResolvedCard): ReactElement => (
    <AddAndPlaceTile
      key={card.id}
      card={card}
      palette={palette}
      disabled={addDisabled}
      binderId={binderId}
      slotId={slotId}
      onAddAndPlace={onAddAndPlace}
    />
  );

  return (
    <Panel title={`Find cards · ${title}`} onClose={onClose} wide>
      {error ? (
        <p role="alert" className="panel-error">
          {error}
        </p>
      ) : null}
      {slot.assignedCardId ? (
        <div className="panel-actions">
          <p className="panel-help">A copy is placed here. Choose another to swap it.</p>
          <button type="button" disabled={!editable || pending} onClick={onUnassign}>
            Remove physical placement
          </button>
        </div>
      ) : null}

      <section className="panel-section" aria-labelledby="find-owned-heading">
        <h3 id="find-owned-heading">Your spare copies</h3>
        {sparesLoading ? (
          <p role="status">Loading your copies…</p>
        ) : sparesError ? (
          <p role="alert" className="panel-error">
            {sparesError}
          </p>
        ) : usableSpares.length > 0 ? (
          <div className="card-picker-grid" aria-label="Your spare copies">
            {usableSpares.map(({ candidate, card }) => (
              <button
                key={candidate.cardId}
                type="button"
                className="card-picker-item find-cards-item"
                disabled={!editable || pending}
                onClick={() => onAssign(candidate)}
              >
                {card ? (
                  <CardFrame card={frameCardFrom(card)} state="owned" palette={palette} />
                ) : null}
                <span className="card-picker-name">{candidate.name}</span>
                <span className="card-picker-meta">
                  {candidate.setCode ?? candidate.setName} · {candidate.number} ·{' '}
                  {candidate.available} spare
                </span>
                <span className="find-cards-action">Place</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="panel-help">No spare copy fits this pocket.</p>
        )}
      </section>

      <section className="panel-section" aria-labelledby="find-printings-heading">
        <h3 id="find-printings-heading">Add a copy</h3>
        {addBlockedReason ? <p className="panel-help">{addBlockedReason}</p> : null}
        {exactCard ? (
          spareIds.has(exactCard.id) ? (
            <p className="panel-help">You have a spare copy of this card above.</p>
          ) : (
            <div className="card-picker-grid" aria-label="Printings that fit">
              {tile(exactCard)}
            </div>
          )
        ) : slot.pokemonNumber ? (
          <CardPicker
            query={{ q: '', filters: { pokedexNumber: String(slot.pokemonNumber) } }}
            palette={palette}
            pending={pending}
            autoSearch
            searchLabel="Narrow by set, number or name"
            placeholder="Set, number or name"
            hideIds={spareIds}
            renderItem={tile}
          />
        ) : (
          <p className="panel-help">This target names no card or Pokémon to look for.</p>
        )}
      </section>

      {!reservedPage ? (
        <label className="panel-check">
          <input
            type="checkbox"
            checked={slot.startsNewPage === true}
            disabled={!editable || pending}
            onChange={(event) => onPageBreak(event.target.checked)}
          />
          Start this target on a new page
        </label>
      ) : null}
    </Panel>
  );
}
