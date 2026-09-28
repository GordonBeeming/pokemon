import { DEFAULT_FRAME_PALETTE, RARITY_LABELS, regionForDex } from '@pokedex/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { binderApi } from '../../api/queries/binders';
import { useCardBinderMatches } from '../../api/queries/card';
import { useCardDetail } from '../../api/queries/catalogue';
import { useIncrementCollection, usePatchCollectionNotes } from '../../api/queries/collection';
import { queryKeys } from '../../api/keys';
import { useSetNationalRepresentative } from '../../api/queries/pokedex';
import { CardFrame } from '../../cards/CardFrame';
import { RARITY_VISUALS } from '../../cards/rarity-visuals';
import { Icon } from '../../ui/icons';
import { CardFrameSkeleton } from '../../ui/Skeleton';
import { useToast } from '../../ui/Toast';
import { BinderRow } from './BinderRow';
import { WhereFromDialog } from './WhereFromDialog';
import './card-inspector.css';

const NOTES_MAX = 2000;
const AUTOSAVE_DEBOUNCE_MS = 650;

function formatMoney(amountAud: number | null): string {
  if (amountAud === null) return 'No price yet';
  return `A$${new Intl.NumberFormat('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amountAud)}`;
}

export interface CardInspectorProps {
  cardId: string;
  onClose: () => void;
  /** Set when reached from a specific binder pocket ("View card") — auto-expands
   * that binder's row so the answer to "why did I open this" is immediately visible. */
  context?: { binderId: string; slotId: string };
  /** Not part of the spec's minimal 3-prop contract, but additive and optional: lets
   * an embedding chrome (Catalogue's overlay, the standalone /card/$cardId page) know
   * when a save is in flight or failed, so it can hold off closing instead of
   * discarding an edit. Safe to ignore — every other prop still works standalone. */
  onDirtyChange?: (dirty: boolean) => void;
}

/**
 * The reusable card detail surface FEATURES.md's Card inspector section describes:
 * high-res art (never faded), quantity split, notes autosave, and the binder
 * placement rows. Chrome (prev/next, close, focus trap) is owned by whoever embeds
 * this — Catalogue's overlay, the standalone full-page route, or a binder pocket's
 * "View card" — so the same content works in all three without duplicating it.
 */
export function CardInspector({
  cardId,
  onClose,
  context,
  onDirtyChange,
}: CardInspectorProps): ReactElement {
  const detail = useCardDetail(cardId);
  const binderMatches = useCardBinderMatches(cardId);
  const increment = useIncrementCollection(cardId);
  const patchNotes = usePatchCollectionNotes(cardId);
  const setRepresentative = useSetNationalRepresentative();
  const toast = useToast();

  const card = detail.data;
  const quantity = card?.collection?.quantity ?? 0;
  const savedNotes = card?.collection?.notes ?? '';
  const [notes, setNotes] = useState(savedNotes);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [removeOpen, setRemoveOpen] = useState(false);
  const draftCardId = useRef(cardId);
  const saveTimer = useRef<number | undefined>(undefined);

  // Switching cards resets the draft to the new card's own saved notes rather than
  // leaking the previous card's edit — FEATURES.md's "switching card resets draft".
  useEffect(() => {
    if (draftCardId.current !== cardId) {
      draftCardId.current = cardId;
      setNotes(savedNotes);
      setSaveState('idle');
    }
  }, [cardId, savedNotes]);

  const dirty = notes.trim() !== savedNotes.trim();
  useEffect(() => {
    onDirtyChange?.(dirty || saveState === 'saving' || saveState === 'error');
  }, [dirty, saveState, onDirtyChange]);

  const save = useCallback(
    async (nextNotes: string): Promise<void> => {
      if (!card) return;
      setSaveState('saving');
      try {
        await patchNotes.mutateAsync({
          expectedRevision: card.collection?.revision ?? 0,
          notes: nextNotes.trim() || null,
        });
        setSaveState('saved');
      } catch {
        setSaveState('error');
      }
    },
    [card, patchNotes],
  );

  function onNotesChange(value: string): void {
    setNotes(value);
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void save(value), AUTOSAVE_DEBOUNCE_MS);
  }

  function onNotesBlur(): void {
    window.clearTimeout(saveTimer.current);
    if (notes.trim() !== savedNotes.trim()) void save(notes);
  }

  useEffect(() => () => window.clearTimeout(saveTimer.current), []);

  if (detail.isLoading || !card) {
    return (
      <div className="card-inspector">
        <CardFrameSkeleton />
      </div>
    );
  }

  const pokedexNumber = card.pokedexNumber ?? null;
  const region = pokedexNumber ? regionForDex(pokedexNumber) : null;
  const rarityVisual = card.rarityKey ? RARITY_VISUALS[card.rarityKey] : null;
  const rarityName = card.rarityKey ? RARITY_LABELS[card.rarityKey] : null;
  const placedIn = (binderMatches.data ?? []).flatMap((match) =>
    match.placed.map((slot) => ({
      binderId: match.binderId,
      binderName: match.name,
      slotId: slot.slotId,
      page: slot.page,
      row: slot.row,
      col: slot.col,
    })),
  );
  const loose = Math.max(0, quantity - placedIn.length);

  return (
    <div className="card-inspector">
      <div className="card-inspector-top">
        <div className="card-inspector-frame">
          <CardFrame
            card={{
              id: card.id,
              name: card.name,
              frameType: card.frameType ?? null,
              setCode: card.setCode ?? null,
              number: card.number,
              rarityKey: card.rarityKey ?? null,
              pokedexNumber,
              imageUrl: card.imageHighUrl ?? card.imageLowUrl,
            }}
            state={quantity > 0 ? 'owned' : 'unowned'}
            forceSolid
            palette={DEFAULT_FRAME_PALETTE}
          />
        </div>
        <div className="card-inspector-meta">
          <h2>{card.name}</h2>
          <p>
            {card.setName} · <span className="mono">{card.number}</span>
          </p>
          {region ? (
            <p>
              #{String(pokedexNumber).padStart(4, '0')} · first found in {region}
            </p>
          ) : null}
          {rarityName ? (
            <p>
              {rarityVisual ? (
                <span aria-hidden="true" className="card-inspector-rarity-icon">
                  {rarityVisual.icon}
                </span>
              ) : null}
              {rarityName}
            </p>
          ) : null}
          {card.artist ? <p>Illustrated by {card.artist}</p> : null}
          <span className={quantity > 0 ? 'state-chip state-chip-owned' : 'state-chip'}>
            {quantity > 0 ? `Owned ×${quantity}` : 'Not owned'}
          </span>
          <p>Market estimate: {formatMoney(card.price.amountAud)}</p>
          {pokedexNumber ? (
            <button
              type="button"
              className="text-button"
              disabled={setRepresentative.isPending}
              onClick={() =>
                void setRepresentative
                  .mutateAsync({ number: pokedexNumber, cardId: card.id })
                  .then(() => toast('success', `${card.name} is now the National Pokédex image.`))
                  .catch((cause: unknown) =>
                    toast('error', cause instanceof Error ? cause.message : 'Could not save that.'),
                  )
              }
            >
              Use as Pokédex image
            </button>
          ) : null}
        </div>
      </div>

      <section aria-labelledby="card-inspector-copies-heading">
        <h3 id="card-inspector-copies-heading">Your copies</h3>
        {quantity === 0 ? (
          <button
            type="button"
            className="primary-button"
            disabled={increment.isPending}
            onClick={() => void increment.mutateAsync({ delta: 1 })}
          >
            <Icon name="plus" /> Add first copy
          </button>
        ) : (
          <div className="card-inspector-copies-row">
            <span>
              {placedIn.length} in a binder · {loose} loose
            </span>
            <div className="stepper">
              <button type="button" aria-label="Remove a copy" onClick={() => setRemoveOpen(true)}>
                <Icon name="minus" />
              </button>
              <output>{quantity}</output>
              <button
                type="button"
                aria-label="Add a copy"
                disabled={increment.isPending || quantity >= 9999}
                onClick={() => void increment.mutateAsync({ delta: 1 })}
              >
                <Icon name="plus" />
              </button>
            </div>
          </div>
        )}
      </section>

      <section aria-labelledby="card-inspector-notes-heading">
        <label htmlFor="card-inspector-notes" id="card-inspector-notes-heading">
          Notes
        </label>
        <textarea
          id="card-inspector-notes"
          value={notes}
          maxLength={NOTES_MAX}
          rows={3}
          placeholder="Where it came from, which sleeve, anything else"
          onChange={(event) => onNotesChange(event.target.value)}
          onBlur={onNotesBlur}
        />
        <small>
          {notes.length.toLocaleString('en-AU')} of {NOTES_MAX.toLocaleString('en-AU')} characters
        </small>
        <p
          className={saveState === 'error' ? 'autosave-status error' : 'autosave-status'}
          role="status"
        >
          {saveState === 'error' ? (
            <>
              Changes could not be saved.{' '}
              <button type="button" className="text-button" onClick={() => void save(notes)}>
                Try again
              </button>
            </>
          ) : saveState === 'saving' ? (
            'Saving…'
          ) : dirty ? (
            'Changes save automatically.'
          ) : (
            'Saved.'
          )}
        </p>
      </section>

      <section aria-labelledby="card-inspector-binders-heading">
        <h3 id="card-inspector-binders-heading">Binders</h3>
        {binderMatches.isLoading ? (
          <p>Loading binders…</p>
        ) : (binderMatches.data ?? []).length === 0 ? (
          <p>Create a binder in Binders first.</p>
        ) : (
          (binderMatches.data ?? []).map((match) => (
            <BinderRow
              key={match.binderId}
              cardId={cardId}
              quantity={quantity}
              match={match}
              autoExpand={context?.binderId === match.binderId}
            />
          ))
        )}
        <NewBinderRow />
      </section>

      <WhereFromDialog
        open={removeOpen}
        onClose={() => setRemoveOpen(false)}
        cardId={cardId}
        cardName={card.name}
        placedIn={placedIn}
        looseCopies={loose}
        onRemoved={() => {
          setRemoveOpen(false);
          toast('success', 'Copy removed.');
        }}
      />

      <div className="card-inspector-close">
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

/**
 * "A 'New binder' row at the end. No separate 'Add to a binder' button." Full
 * binder creation (page-face layout choice, capacity) is the Binders screen's own
 * form (ws-screens-b); this row creates one with a sensible 3x3 default so a target
 * exists to fill next time this section is opened, rather than duplicating that form.
 */
function NewBinderRow(): ReactElement {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const toast = useToast();

  const queryClient = useQueryClient();

  async function create(): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) return;
    setPending(true);
    try {
      await binderApi.create(trimmed, { kind: '3x3', rows: 3, columns: 3 }, 9);
      void queryClient.invalidateQueries({ queryKey: queryKeys.binders.list() });
      setName('');
      setOpen(false);
      toast('success', `${trimmed} created. Reopen this card to place it there.`);
    } catch (cause) {
      toast('error', cause instanceof Error ? cause.message : 'Could not create that binder.');
    } finally {
      setPending(false);
    }
  }

  if (!open)
    return (
      <button type="button" className="new-binder-row" onClick={() => setOpen(true)}>
        New binder
      </button>
    );
  return (
    <form
      className="new-binder-row-form"
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
    >
      <input
        autoFocus
        value={name}
        maxLength={120}
        placeholder="Binder name"
        onChange={(event) => setName(event.target.value)}
      />
      <button type="submit" disabled={pending || !name.trim()}>
        {pending ? 'Creating…' : 'Create'}
      </button>
    </form>
  );
}
