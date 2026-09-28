import type { BinderSlotLocation } from '@pokedex/shared';
import type { ComponentProps, ReactElement } from 'react';
import {
  useAssignmentCandidates,
  useInsertDestinations,
  type BinderSlotView,
} from '../../../api/queries/binders';
import { binderErrorMessage } from '../model';
import { ManageBinderPanel } from './ManageBinderPanel';
import { FindCardsPanel } from './PocketPanels';

type FindProps = ComponentProps<typeof FindCardsPanel>;

/** Loads the owned copies that fit only while Find cards is open, so selecting pockets
 * never fires candidate requests on its own. */
export function FindCardsPanelContainer({
  versionId,
  slot,
  at,
  slotId,
  ...rest
}: Omit<FindProps, 'candidates' | 'candidatesLoading' | 'candidatesError'> & {
  versionId: string;
  slot: BinderSlotView;
  at: BinderSlotLocation;
  slotId: string;
}): ReactElement {
  const candidates = useAssignmentCandidates(versionId, slotId, at);
  return (
    <FindCardsPanel
      {...rest}
      slot={slot}
      candidates={candidates.data}
      candidatesLoading={candidates.isLoading}
      candidatesError={candidates.isError ? binderErrorMessage(candidates.error) : null}
    />
  );
}

type ManageProps = ComponentProps<typeof ManageBinderPanel>;

/** Works out where a full Pokédex insert would start: the selected pocket if there is
 * one, otherwise the binder's end-of-content append point. */
export function ManagePanelContainer({
  versionId,
  selected,
  onFullPokedex,
  ...rest
}: Omit<ManageProps, 'fullPokedexAt' | 'onFullPokedex'> & {
  versionId: string;
  selected: BinderSlotLocation | null;
  onFullPokedex: (at: BinderSlotLocation, regionPageBreaks: boolean) => void;
}): ReactElement {
  const destinations = useInsertDestinations(versionId, selected === null);
  const at = selected ?? destinations.data?.appendAt ?? null;
  return (
    <ManageBinderPanel
      {...rest}
      fullPokedexAt={at}
      onFullPokedex={(regionPageBreaks) => {
        if (at) onFullPokedex(at, regionPageBreaks);
      }}
    />
  );
}
