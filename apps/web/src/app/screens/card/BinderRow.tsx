import type { BinderCardMatches, SlotRef } from '@pokedex/shared';
import { Link } from '@tanstack/react-router';
import { useState, type ReactElement } from 'react';
import { fetchBinderPage, useBinders } from '../../api/queries/binders';
import { usePlaceCard } from '../../api/queries/card';
import { useToast } from '../../ui/Toast';

export type BinderRowMatch = BinderCardMatches;

type Destination =
  { kind: 'next'; slot: SlotRef } | { kind: 'end'; slot: SlotRef } | { kind: 'full' };

/**
 * Priority order per the lead's fix-round-1 review: a matching open target this
 * card can fill directly, else the first empty pocket at the end of the binder
 * (POST /api/cards/:id/place turns that into a new exact-card target for this
 * printing in one atomic batch), else the binder has no room left at all.
 */
function destinationFor(match: BinderRowMatch): Destination {
  if (match.nextTarget) return { kind: 'next', slot: match.nextTarget };
  if (match.endDestination) return { kind: 'end', slot: match.endDestination };
  return { kind: 'full' };
}

/**
 * One binder row in the card inspector's Binders section: a status tag (Target
 * waiting / In binder / Not in binder), and an inline expansion every row gets —
 * offering the one action FEATURES.md describes ("Place here" when a copy is
 * already owned, "Add a copy and place" when it isn't), or "Binder is full" with a
 * link to the binder when there's nowhere left to put it.
 */
export function BinderRow({
  cardId,
  quantity,
  match,
  autoExpand,
}: {
  cardId: string;
  quantity: number;
  match: BinderRowMatch;
  autoExpand: boolean;
}): ReactElement {
  const [open, setOpen] = useState(autoExpand);
  const [placing, setPlacing] = useState(false);
  const destination = destinationFor(match);
  const inBinder = match.placed.length > 0;
  const tag = inBinder ? 'In binder' : match.nextTarget ? 'Target waiting' : 'Not in binder';
  const place = usePlaceCard(cardId);
  const toast = useToast();
  const binders = useBinders();

  async function confirmPlace(): Promise<void> {
    if (destination.kind === 'full') return;
    const activeVersionId = binders.data?.find(
      (binder) => binder.id === match.binderId,
    )?.activeVersionId;
    if (!activeVersionId) return;
    setPlacing(true);
    try {
      // /api/cards/:id/place takes the binder VERSION's expectedRevision (optimistic
      // concurrency on the binder mutation, not the card's own collection revision)
      // — read fresh right before placing, the same two-hop lookup the old app's
      // "Add to selected binder" flow used.
      const page = await fetchBinderPage(activeVersionId, 0);
      await place.mutateAsync({
        binderId: match.binderId,
        slotId: destination.slot.slotId,
        addCopy: quantity === 0,
        expectedRevision: page.version.revision,
      });
      toast('success', `Placed in ${match.name} — page ${destination.slot.page + 1}.`);
      setOpen(false);
    } catch (cause) {
      toast('error', cause instanceof Error ? cause.message : 'Could not place this card.');
    } finally {
      setPlacing(false);
    }
  }

  return (
    <div className={open ? 'binder-row binder-row-open' : 'binder-row'}>
      <button
        type="button"
        className="binder-row-toggle"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span>
          <strong>{match.name}</strong>
          {inBinder ? <small>{match.placed.length} placed here</small> : null}
        </span>
        <span
          className={`binder-row-tag binder-row-tag-${tag === 'In binder' ? 'in' : tag === 'Target waiting' ? 'waiting' : 'none'}`}
        >
          {tag}
        </span>
      </button>
      {open ? (
        <div className="binder-row-detail">
          {destination.kind === 'full' ? (
            <>
              <p>Binder is full — there's no empty pocket left to place this card.</p>
              <Link
                to="/binders/$binderId"
                params={{ binderId: match.binderId }}
                search={{ page: 1, q: '' }}
              >
                Open {match.name}
              </Link>
            </>
          ) : (
            <>
              <p>
                {destination.kind === 'next'
                  ? `Place in the waiting target — page ${destination.slot.page + 1}, pocket ${destination.slot.pocketIndex + 1}.`
                  : `Add at the end — page ${destination.slot.page + 1}, pocket ${destination.slot.pocketIndex + 1}. This becomes a new exact target for this printing.`}
              </p>
              <button
                type="button"
                onClick={() => void confirmPlace()}
                disabled={placing || place.isPending}
              >
                {placing || place.isPending
                  ? 'Placing…'
                  : quantity === 0
                    ? 'Add a copy and place'
                    : 'Place here'}
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
