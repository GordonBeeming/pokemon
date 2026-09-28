import type { BinderFullPokedexPreview, BinderSlotLocation } from '@pokedex/shared';
import { useEffect, useState, type ReactElement } from 'react';
import {
  ARRANGE_MODES,
  binderApi,
  useBinderShortages,
  type ArrangeMode,
  type BinderVersionView,
} from '../../../api/queries/binders';
import { binderErrorMessage, capacityDescription } from '../model';
import { Panel } from './Panel';

export const ARRANGE_LABELS: Record<ArrangeMode, { label: string; help: string }> = {
  'pokedex-number': {
    label: 'Pokédex number',
    help: 'Lowest National Pokédex number first; cards with no species go last.',
  },
  'set-number': { label: 'Set number', help: 'By set name, then card number within the set.' },
  'release-date': {
    label: 'Release date',
    help: 'Oldest set first; sets without a release date go last.',
  },
  language: { label: 'Language', help: 'Grouped by card language, then by set and number.' },
};

export interface DraftState {
  /** The version on screen is a draft. */
  viewingDraft: boolean;
  /** A draft exists for this binder (possibly the one on screen). */
  draftVersionId: string | null;
  activeVersionId: string | null;
}

export function ManageBinderPanel({
  version,
  editable,
  pending,
  error,
  suggestedCapacity,
  drafts,
  fullPokedexAt,
  onResize,
  onArrange,
  onPreviewArrangeInDraft,
  onClone,
  onOpenDraft,
  onOpenActive,
  onActivate,
  onDiscard,
  onFullPokedex,
  onAddPage,
  onPrint,
  onDelete,
  onClose,
}: {
  version: BinderVersionView;
  editable: boolean;
  pending: boolean;
  error: string | null;
  suggestedCapacity: number | null;
  drafts: DraftState;
  fullPokedexAt: BinderSlotLocation | null;
  onResize: (capacity: number) => void;
  onArrange: (mode: ArrangeMode) => void;
  onPreviewArrangeInDraft: (mode: ArrangeMode) => void;
  onClone: () => void;
  onOpenDraft: () => void;
  onOpenActive: () => void;
  onActivate: () => void;
  onDiscard: () => void;
  onFullPokedex: (regionPageBreaks: boolean) => void;
  onAddPage: () => void;
  onPrint: () => void;
  onDelete: () => void;
  onClose: () => void;
}): ReactElement {
  const capacity =
    version.capacity ?? version.pageCount * version.layout.rows * version.layout.columns;
  const face = version.layout.rows * version.layout.columns;
  const [resize, setResize] = useState(suggestedCapacity ? String(suggestedCapacity) : '');
  const [mode, setMode] = useState<ArrangeMode>('pokedex-number');
  const [regionBreaks, setRegionBreaks] = useState(true);
  const [preview, setPreview] = useState<BinderFullPokedexPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const shortages = useBinderShortages(version.id);

  useEffect(() => {
    if (suggestedCapacity) setResize(String(suggestedCapacity));
  }, [suggestedCapacity]);

  useEffect(() => {
    if (!fullPokedexAt || !editable) return;
    const controller = new AbortController();
    setPreview(null);
    setPreviewError(null);
    binderApi
      .previewFullPokedex(
        version.id,
        fullPokedexAt,
        regionBreaks,
        version.revision,
        controller.signal,
      )
      .then((value) => {
        if (!controller.signal.aborted) setPreview(value);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setPreviewError(binderErrorMessage(cause));
      });
    return () => controller.abort();
  }, [version.id, version.revision, fullPokedexAt, regionBreaks, editable]);

  const value = Number(resize || capacity);
  const invalid = !Number.isInteger(value) || value < 1;

  return (
    <Panel title="Manage binder" onClose={onClose} wide>
      {error ? (
        <p role="alert" className="panel-error">
          {error}
        </p>
      ) : null}

      <section className="panel-section" aria-labelledby="capacity-heading">
        <h3 id="capacity-heading">Binder capacity</h3>
        <div className="panel-inline">
          <label>
            <span>Binder capacity (pockets)</span>
            <input
              type="number"
              min="1"
              step="1"
              value={resize}
              placeholder={String(capacity)}
              disabled={!editable || pending}
              aria-describedby="capacity-help"
              aria-invalid={resize !== '' && invalid}
              onChange={(event) => setResize(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="button-primary"
            disabled={!editable || pending || value === capacity || invalid}
            onClick={() => onResize(value)}
          >
            {value > capacity ? 'Grow binder' : 'Safely shrink binder'}
          </button>
        </div>
        <p id="capacity-help" className="panel-help" aria-live="polite">
          {capacityDescription(value, face)}
          {suggestedCapacity
            ? ' Growing to this size runs the action that needed the room straight after.'
            : ''}
        </p>
      </section>

      <section className="panel-section" aria-labelledby="arrange-heading">
        <h3 id="arrange-heading">Arrange targets</h3>
        <fieldset className="panel-radios" disabled={!editable || pending}>
          <legend>Sort by</legend>
          {ARRANGE_MODES.map((option) => (
            <label key={option}>
              <input
                type="radio"
                name="arrange-mode"
                value={option}
                checked={mode === option}
                onChange={() => setMode(option)}
              />
              <span>
                <strong>{ARRANGE_LABELS[option].label}</strong>
                <small>{ARRANGE_LABELS[option].help}</small>
              </span>
            </label>
          ))}
        </fieldset>
        <p className="panel-help">
          Reserved pages and reserved sleeves stay where they are. Preview in a draft to see the
          result before it replaces the active binder.
        </p>
        <div className="panel-actions">
          <button
            type="button"
            disabled={!editable || pending || drafts.viewingDraft}
            onClick={() => onPreviewArrangeInDraft(mode)}
          >
            Preview in a draft
          </button>
          <button
            type="button"
            className="button-primary"
            disabled={!editable || pending}
            onClick={() => onArrange(mode)}
          >
            Arrange now
          </button>
        </div>
      </section>

      <section className="panel-section" aria-labelledby="drafts-heading">
        <h3 id="drafts-heading">Drafts</h3>
        {drafts.viewingDraft ? (
          <>
            <p className="panel-help">
              You’re editing a draft. The active binder stays as it was until you make this draft
              active.
            </p>
            <div className="panel-actions">
              <button type="button" disabled={pending} onClick={onOpenActive}>
                Back to the active binder
              </button>
              <button
                type="button"
                className="button-danger"
                disabled={pending}
                onClick={onDiscard}
              >
                Discard draft
              </button>
              <button
                type="button"
                className="button-primary"
                disabled={pending}
                onClick={onActivate}
              >
                Make this draft active
              </button>
            </div>
          </>
        ) : drafts.draftVersionId ? (
          <>
            <p className="panel-help">A draft of this binder is in progress.</p>
            <div className="panel-actions">
              <button type="button" className="button-primary" onClick={onOpenDraft}>
                Open the draft
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="panel-help">
              Copy this binder into a draft to try a different layout. Edit the draft freely, then
              make it active or discard it.
            </p>
            <div className="panel-actions">
              <button type="button" disabled={!editable || pending} onClick={onClone}>
                Clone into a draft
              </button>
            </div>
          </>
        )}
      </section>

      <section className="panel-section" aria-labelledby="pokedex-heading">
        <h3 id="pokedex-heading">Full National Pokédex</h3>
        <p className="panel-help">
          Inserts one “any printing” target for each of the 1,025 Pokémon
          {fullPokedexAt
            ? `, starting at page ${fullPokedexAt.page + 1}, pocket ${fullPokedexAt.row + 1}:${fullPokedexAt.column + 1}`
            : ''}
          .
        </p>
        <label className="panel-check">
          <input
            type="checkbox"
            checked={regionBreaks}
            disabled={!editable || pending}
            onChange={(event) => setRegionBreaks(event.target.checked)}
          />
          Start each region on a new page
        </label>
        {!fullPokedexAt ? (
          <p className="panel-help">There’s no free space at the end. Grow the binder first.</p>
        ) : previewError ? (
          <p role="alert" className="panel-error">
            {previewError}
          </p>
        ) : preview ? (
          <p className="panel-help" role="status">
            Needs {preview.requiredCapacity.toLocaleString('en-AU')} pockets (
            {preview.additionalPockets > 0
              ? `${preview.additionalPockets.toLocaleString('en-AU')} more than today; the binder grows to fit`
              : 'fits in the current capacity'}
            ). {preview.generatedPadding.toLocaleString('en-AU')} empty sleeves pad region breaks.
          </p>
        ) : (
          <p role="status" className="panel-help">
            Checking space…
          </p>
        )}
        <div className="panel-actions">
          <button
            type="button"
            className="button-primary"
            disabled={!editable || pending || !fullPokedexAt || !preview}
            onClick={() => onFullPokedex(regionBreaks)}
          >
            Insert all 1,025 Pokémon
          </button>
        </div>
      </section>

      <section className="panel-section" aria-labelledby="shortages-heading">
        <h3 id="shortages-heading">Shortages</h3>
        {shortages.isLoading ? (
          <p role="status">Counting missing copies…</p>
        ) : shortages.data ? (
          shortages.data.totalMissing === 0 ? (
            <p className="panel-help">Every target in this binder has a copy you own.</p>
          ) : (
            <p className="panel-help">
              {shortages.data.totalMissing.toLocaleString('en-AU')} copies missing across{' '}
              {shortages.data.totalEntries.toLocaleString('en-AU')} targets.
            </p>
          )
        ) : (
          <p className="panel-help">Shortages could not be loaded.</p>
        )}
      </section>

      <section className="panel-section" aria-labelledby="more-heading">
        <h3 id="more-heading">Pages and printing</h3>
        <div className="panel-actions">
          <button type="button" disabled={!editable || pending} onClick={onAddPage}>
            Add a page at the end
          </button>
          <button type="button" onClick={onPrint}>
            Print
          </button>
          <button type="button" className="button-danger" disabled={pending} onClick={onDelete}>
            Delete binder
          </button>
        </div>
      </section>
    </Panel>
  );
}
