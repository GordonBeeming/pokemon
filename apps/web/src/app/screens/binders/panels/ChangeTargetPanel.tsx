import type { FrameType } from '@pokedex/shared';
import { useState, type ReactElement } from 'react';
import type { BinderSlotView, ResolvedCard } from '../../../api/queries/binders';
import { SegmentedControl } from '../../../ui/SegmentedControl';
import { isGroupTarget, type CardLookup } from '../model';
import { CardPicker, type PickerQuery } from './CardPicker';
import { Panel } from './Panel';
import { TargetConfirm } from './TargetConfirm';

type Mode = 'same' | 'any';

/** Filters for "same type": the target's species, or for a non-Pokémon exact card its
 * catalogue category. Null when the target carries neither. */
export function sameTypeFilters(
  slot: BinderSlotView,
  cards: CardLookup,
): Record<string, string> | null {
  if (slot.entryKind === 'trainer' && slot.groupKey) return { trainer: slot.groupKey };
  if (slot.entryKind === 'energy' && slot.groupKey) return { energy: slot.groupKey };
  if (slot.entryKind === 'illustrator' && slot.groupKey)
    return { artist: slot.groupName ?? slot.groupKey };
  if (slot.entryKind === 'set' && slot.setId && slot.setLanguage)
    return { set: slot.setId, language: slot.setLanguage };
  const original = slot.cardId ? cards.get(slot.cardId) : undefined;
  const species = slot.pokemonNumber ?? original?.pokedexNumber;
  if (species) return { pokedexNumber: String(species) };
  if (original && original.category !== 'pokemon') return { category: original.category };
  return null;
}

/** Sleeves that ask for any card of a kind (a Pokémon, set, illustrator, trainer or
 * energy) rather than one exact card. Picking a card of the same type for one of these
 * places that copy; the sleeve keeps asking for the whole kind. */
export function isTypedTarget(slot: BinderSlotView): boolean {
  return slot.entryKind === 'pokemon' || slot.entryKind === 'set' || isGroupTarget(slot);
}

export function ChangeTargetPanel({
  slot,
  pocketLabel,
  cards,
  palette,
  pending,
  error,
  onChoose,
  onPlace,
  onClose,
}: {
  slot: BinderSlotView;
  pocketLabel: string;
  cards: CardLookup;
  palette: Record<FrameType, string>;
  pending: boolean;
  error: string | null;
  onChoose: (card: ResolvedCard) => void;
  /** Places a copy without changing the target, for a typed sleeve in same-type mode. */
  onPlace: (card: ResolvedCard) => void;
  onClose: () => void;
}): ReactElement {
  const sameFilters = sameTypeFilters(slot, cards);
  const [mode, setMode] = useState<Mode>(sameFilters ? 'same' : 'any');
  const [picked, setPicked] = useState<ResolvedCard | null>(null);
  const query: PickerQuery =
    mode === 'same' && sameFilters ? { q: '', filters: sameFilters } : { q: '' };
  const places = mode === 'same' && isTypedTarget(slot);

  return (
    <Panel title={`Change target · ${pocketLabel}`} onClose={onClose} wide>
      {error ? (
        <p role="alert" className="panel-error">
          {error}
        </p>
      ) : null}
      {picked ? (
        <TargetConfirm
          card={picked}
          pending={pending}
          palette={palette}
          heading={places ? 'Place this copy here?' : undefined}
          confirmLabel={places ? 'Place this copy' : undefined}
          onConfirm={() => (places ? onPlace(picked) : onChoose(picked))}
          onBack={() => setPicked(null)}
        />
      ) : (
        <>
          <SegmentedControl<Mode>
            label="Replace with"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'same', label: 'Replace with same type' },
              { value: 'any', label: 'Replace with any card' },
            ]}
          />
          {mode === 'same' && !sameFilters ? (
            <p className="panel-help">
              This pocket has no Pokémon species recorded. Use Replace with any card.
            </p>
          ) : (
            <>
              <p className="panel-help">
                {places
                  ? 'Choose the copy to show. This sleeve keeps its target, so any card of this type still fits it.'
                  : 'Choose a replacement for this sleeve. Other sleeves stay in place.'}
              </p>
              <CardPicker
                key={mode}
                query={query}
                palette={palette}
                pending={pending}
                autoSearch={mode === 'same'}
                onPick={setPicked}
              />
            </>
          )}
        </>
      )}
    </Panel>
  );
}
