import { useEffect, useMemo, useRef, type ReactElement } from 'react';
import type { NationalPokedexCoverage, NationalPokedexPreview } from './api';
import { NATIONAL_POKEDEX, type NationalPokedexEntry } from '@pokedex/shared';
import { SegmentedControl } from './segmented-control';
import { CardArt } from './card-art';
import { CardTile } from './card-tile';
import { Pagination } from './pagination';
import { RegionPicker } from './region-picker';

export type OwnershipFilter = 'all' | 'owned' | 'missing';

function RepresentativeArt({
  entry,
  preview,
}: {
  entry?: NationalPokedexCoverage;
  preview?: NationalPokedexPreview;
}): ReactElement {
  const image = entry?.representative.imageLowUrl ?? preview?.imageLowUrl;
  const highImage = entry?.representative.imageHighUrl ?? preview?.imageHighUrl;
  return (
    <CardArt
      src={image}
      highSrc={highImage}
      alt=""
      missingText="Card preview unavailable"
      dimmed={(entry?.ownedCards ?? 0) === 0}
    />
  );
}

export function NationalPokedexView({
  coverage,
  previews,
  query,
  ownership,
  page,
  region = 'All',
  focusNumber,
  restoreScrollY,
  pendingNumber,
  onQueryChange,
  onOwnershipChange,
  onPageChange,
  onRegionChange = () => undefined,
  onChoose,
}: {
  coverage: NationalPokedexCoverage[];
  previews: NationalPokedexPreview[];
  query: string;
  ownership: OwnershipFilter;
  page: number;
  region?: string;
  focusNumber: number | null;
  restoreScrollY: number;
  pendingNumber: number | null;
  onQueryChange: (value: string) => void;
  onOwnershipChange: (value: OwnershipFilter) => void;
  onPageChange: (value: number) => void;
  onRegionChange?: (value: string) => void;
  onChoose: (entry: NationalPokedexEntry) => void;
}): ReactElement {
  const coverageByNumber = useMemo(
    () => new Map(coverage.map((entry) => [entry.number, entry])),
    [coverage],
  );
  const previewsByName = useMemo(
    () => new Map(previews.map((preview) => [preview.name, preview])),
    [previews],
  );
  const list = useRef<HTMLElement>(null);
  const ownedSpecies = coverage.filter((entry) => entry.ownedCards > 0).length;
  const regionOptions = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('en-AU');
    const matchesBaseFilters = (entry: NationalPokedexEntry): boolean => {
      const state = coverageByNumber.get(entry.number);
      const owned = (state?.ownedCards ?? 0) > 0;
      if (ownership === 'owned' && !owned) return false;
      if (ownership === 'missing' && owned) return false;
      return (
        !needle ||
        entry.name.toLocaleLowerCase('en-AU').includes(needle) ||
        entry.discoveryCategory.toLocaleLowerCase('en-AU').includes(needle) ||
        String(entry.number).padStart(4, '0').includes(needle.replace(/^#/u, '')) ||
        state?.types.some((type) => type.toLocaleLowerCase('en-AU').includes(needle)) === true
      );
    };
    const regions = [...new Set(NATIONAL_POKEDEX.map((entry) => entry.discoveryCategory))];
    return [
      { value: 'All', count: NATIONAL_POKEDEX.filter(matchesBaseFilters).length },
      ...regions.map((value) => ({
        value,
        count: NATIONAL_POKEDEX.filter(
          (entry) => entry.discoveryCategory === value && matchesBaseFilters(entry),
        ).length,
      })),
    ];
  }, [coverageByNumber, ownership, query]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('en-AU');
    return NATIONAL_POKEDEX.filter((entry) => {
      const state = coverageByNumber.get(entry.number);
      const owned = (state?.ownedCards ?? 0) > 0;
      if (ownership === 'owned' && !owned) return false;
      if (ownership === 'missing' && owned) return false;
      if (region !== 'All' && entry.discoveryCategory !== region) return false;
      return (
        !needle ||
        entry.name.toLocaleLowerCase('en-AU').includes(needle) ||
        entry.discoveryCategory.toLocaleLowerCase('en-AU').includes(needle) ||
        String(entry.number).padStart(4, '0').includes(needle.replace(/^#/u, '')) ||
        state?.types.some((type) => type.toLocaleLowerCase('en-AU').includes(needle)) === true
      );
    });
  }, [coverageByNumber, ownership, query, region]);
  useEffect(() => {
    window.scrollTo({ top: restoreScrollY });
    if (focusNumber === null) return;
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLButtonElement>(`[data-pokedex-number="${focusNumber}"]`)
        ?.focus({ preventScroll: true });
    });
  }, []);
  const pageSize = 50;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const visible = filtered.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const changePage = (nextPage: number): void => {
    onPageChange(nextPage);
    requestAnimationFrame(() => list.current?.scrollIntoView({ block: 'start' }));
  };

  return (
    <>
      <header className="page-heading national-heading">
        <div>
          <h1>Plan the full National Pokédex.</h1>
          <p>
            Every species stays visible. Open one to discover its English card variants, update
            copies, or choose the card that represents it here.
          </p>
        </div>
        <div className="national-progress" aria-label={`${ownedSpecies} of 1025 species owned`}>
          <strong>{ownedSpecies.toLocaleString('en-AU')}</strong>
          <span>of 1,025 species owned</span>
        </div>
      </header>

      <div className="national-toolbar">
        <label>
          Find a Pokémon
          <input
            value={query}
            type="search"
            placeholder="Name, # number, type, or first-found region"
            onChange={(event) => {
              onQueryChange(event.target.value);
              onPageChange(0);
            }}
          />
        </label>
        <RegionPicker
          value={region}
          options={regionOptions}
          onChange={(value) => {
            onRegionChange(value);
            onPageChange(0);
          }}
        />
        <SegmentedControl
          label="Collection state"
          value={ownership}
          options={[
            { value: 'all', label: 'All' },
            { value: 'missing', label: 'Missing' },
            { value: 'owned', label: 'Owned' },
          ]}
          onChange={(value) => {
            onOwnershipChange(value);
            onPageChange(0);
          }}
        />
        <p className="national-summary" role="status" aria-live="polite" aria-atomic="true">
          Showing {visible.length.toLocaleString('en-AU')} of{' '}
          {filtered.length.toLocaleString('en-AU')} matching species.
        </p>
      </div>

      <section className="species-list" aria-label="National Pokédex species" ref={list}>
        {visible.map((entry) => {
          const state = coverageByNumber.get(entry.number);
          const owned = (state?.ownedCards ?? 0) > 0;
          return (
            <CardTile
              className="species-row"
              key={entry.number}
              data-pokedex-number={entry.number}
              disabled={pendingNumber !== null}
              aria-label={`${String(entry.number).padStart(4, '0')} ${entry.name}. First found in ${entry.discoveryCategory}. ${owned ? 'Owned' : 'Missing'}. ${state?.totalCards ?? 0} card variants loaded.`}
              onClick={() => {
                if (pendingNumber === null) onChoose(entry);
              }}
              art={<RepresentativeArt entry={state} preview={previewsByName.get(entry.name)} />}
              title={entry.name}
              subtitle={`#${String(entry.number).padStart(4, '0')} · ${entry.discoveryCategory}`}
              quantity={state?.ownedCards ?? 0}
            />
          );
        })}
      </section>
      {visible.length === 0 ? (
        <div className="empty-state">
          <h2>No Pokémon match these filters.</h2>
          <p>Clear the name, change the collection state, or choose another first-found region.</p>
        </div>
      ) : null}
      <Pagination
        page={safePage}
        totalPages={totalPages}
        pending={pendingNumber !== null}
        label="National Pokédex pages"
        onPage={changePage}
      />
    </>
  );
}
