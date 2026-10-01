import type { FrameType } from '@pokedex/shared';
import { useState, type ReactElement } from 'react';
import type { BinderSlotView, ResolvedCard } from '../../../api/queries/binders';
import { SegmentedControl } from '../../../ui/SegmentedControl';
import type { CardLookup } from '../model';
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
  if (slot.entryKind === 'set' && slot.setId && slot.setLanguage)
    return { set: slot.setId, language: slot.setLanguage };
  const original = slot.cardId ? cards.get(slot.cardId) : undefined;
  const species = slot.pokemonNumber ?? original?.pokedexNumber;
  if (species) return { pokedexNumber: String(species) };
  if (original && original.category !== 'pokemon') return { category: original.category };
  return null;
}

export function ChangeTargetPanel({
  slot,
  pocketLabel,
  cards,
  palette,
  pending,
  error,
  onChoose,
  onClose,
}: {
  slot: BinderSlotView;
  pocketLabel: string;
  cards: CardLookup;
  palette: Record<FrameType, string>;
  pending: boolean;
  error: string | null;
  onChoose: (card: ResolvedCard) => void;
  onClose: () => void;
}): ReactElement {
  const sameFilters = sameTypeFilters(slot, cards);
  const [mode, setMode] = useState<Mode>(sameFilters ? 'same' : 'any');
  const [picked, setPicked] = useState<ResolvedCard | null>(null);
  const query: PickerQuery =
    mode === 'same' && sameFilters ? { q: '', filters: sameFilters } : { q: '' };

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
          onConfirm={() => onChoose(picked)}
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
                Choose a replacement for this sleeve. Other sleeves stay in place.
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
