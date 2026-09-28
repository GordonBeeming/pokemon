import { NATIONAL_POKEDEX, RARITY_LABELS, type FrameType, type RarityKey } from '@pokedex/shared';
import { Link, useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { useCatalogueSearch } from '../api/queries/catalogue';
import { recentlyDiscoveredSpecies, useDiscoverSpecies } from '../api/queries/pokedex';
import { useSets } from '../api/queries/sets';
import {
  catalogueSearch,
  pokedexSearch,
  type CatalogueOwnedFilter,
  type CatalogueSearch,
} from '../routes/search-params';
import { FilterChips, type FilterChipItem } from '../ui/Chip';
import { Dialog } from '../ui/Dialog';
import { Icon } from '../ui/icons';
import { MenuButton, MenuItem } from '../ui/MenuButton';
import { SegmentedControl } from '../ui/SegmentedControl';
import { Sheet } from '../ui/Sheet';
import { SidePanel } from '../ui/SidePanel';
import { SummaryDoneButton, SummaryPill } from '../ui/SummaryPill';
import { useToast } from '../ui/Toast';
import { BulkAddToBinder } from './catalogue/BulkAddToBinder';
import { CatalogueGallery } from './catalogue/CatalogueGallery';
import { CopyMenu } from './catalogue/CopyMenu';
import { CustomCardForm } from './catalogue/CustomCardForm';
import { FiltersPanel, FRAME_TYPE_LABELS } from './catalogue/FiltersPanel';
import { Pagination } from './catalogue/Pagination';
import { useIsDesktop } from './catalogue/useIsDesktop';
import { CardInspector } from './card/CardInspector';
import './catalogue/catalogue.css';

// The single canonical "no filters at all" state, derived from the schema's own
// defaults rather than duplicated here, so it never drifts from search-params.ts.
const BLANK_SEARCH = catalogueSearch.parse({});
const BLANK_POKEDEX_SEARCH = pokedexSearch.parse({});

const PAGE_SIZE = 50;

export function Catalogue({ search }: { search: CatalogueSearch }): ReactElement {
  const navigate = useNavigate({ from: '/catalogue' });
  const query = useCatalogueSearch(search);
  const setsFacet = useSets();
  const isDesktop = useIsDesktop();
  // Phones open straight to the cards; search, filters and the copy/bulk tools sit
  // behind one summary pill until it's tapped.
  const [phoneControlsOpen, setPhoneControlsOpen] = useState(false);
  const [rareAction, setRareAction] = useState<'bulk-add' | 'custom-card' | null>(null);
  const discover = useDiscoverSpecies();
  const galleryRef = useRef<HTMLDivElement>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [queryDraft, setQueryDraft] = useState(search.q);
  const [dirtyInspector, setDirtyInspector] = useState(false);
  const toast = useToast();

  useEffect(() => setQueryDraft(search.q), [search.q]);

  const updateSearch = useCallback(
    (patch: Partial<CatalogueSearch>, resetPage = true) => {
      void navigate({
        search: (prev) => ({ ...prev, ...patch, page: resetPage ? 1 : (patch.page ?? prev.page) }),
      });
    },
    [navigate],
  );

  const speciesEntry = search.dex
    ? NATIONAL_POKEDEX.find((entry) => entry.number === search.dex)
    : undefined;
  const discoveredNumber = useRef<number | undefined>(undefined);
  const discoverMutate = discover.mutate;
  // Only the species number decides whether a fresh discovery request is needed —
  // discoverMutate is stable across renders (react-query memoises mutate), so this
  // fires once per newly opened species, not on every render.
  useEffect(() => {
    if (!speciesEntry || discoveredNumber.current === speciesEntry.number) return;
    discoveredNumber.current = speciesEntry.number;
    if (recentlyDiscoveredSpecies(speciesEntry.number)) return;
    discoverMutate({ number: speciesEntry.number, name: speciesEntry.name });
  }, [speciesEntry, discoverMutate]);

  const cards = query.data?.cards ?? [];
  const total = query.data?.total ?? 0;
  const busy = query.isLoading || query.isFetching;
  // keepPreviousData holds the last page's cards while the next page loads; the grid
  // must not show them under the new page's "Showing X to Y" line, so it skeletons
  // until the cards for this exact URL arrive (the total still drives pagination).
  const galleryLoading = query.isLoading || query.isPlaceholderData;
  const contextual = Boolean(speciesEntry) || search.set.length === 1;
  const contextSetName = search.set.length === 1 ? cards[0]?.setName : undefined;

  function moveToPage(nextPage: number): void {
    updateSearch({ page: nextPage }, false);
    requestAnimationFrame(() => galleryRef.current?.scrollIntoView({ block: 'start' }));
  }

  function openCard(cardId: string): void {
    updateSearch({ card: cardId }, false);
  }

  // FEATURES.md: "a failed autosave keeps the inspector open and blocks leaving
  // until the draft saves or the user retries" — Escape, the backdrop, and the
  // chevrons all funnel through here rather than each re-implementing the guard.
  function requestCloseCard(): void {
    if (dirtyInspector) {
      toast(
        'error',
        'Notes are still saving. Wait a moment, or fix the save error, then try again.',
      );
      return;
    }
    updateSearch({ card: undefined }, false);
  }

  const selectedIndex = search.card ? cards.findIndex((card) => card.id === search.card) : -1;
  const preloadedArt = useRef<Map<string, HTMLImageElement>>(new Map());
  // Preloads the open card's immediate neighbours' high-res art so pressing
  // Next/Previous never shows a load flash — bounded the same way the old app's
  // did (evict the oldest once the cache grows past a handful of images).
  useEffect(() => {
    if (selectedIndex < 0 || cards.length < 2) return;
    for (const offset of [-1, 1]) {
      const neighbour = cards[(selectedIndex + offset + cards.length) % cards.length];
      const source = neighbour?.imageHighUrl;
      if (!source || preloadedArt.current.has(source)) continue;
      const image = new Image();
      image.decoding = 'async';
      image.src = source;
      preloadedArt.current.set(source, image);
    }
    while (preloadedArt.current.size > 6) {
      const oldest = preloadedArt.current.keys().next().value;
      if (typeof oldest !== 'string') break;
      preloadedArt.current.delete(oldest);
    }
  }, [cards, selectedIndex]);

  function moveCard(delta: 1 | -1): void {
    if (cards.length === 0) return;
    if (dirtyInspector) {
      toast(
        'error',
        'Notes are still saving. Wait a moment, or fix the save error, then try again.',
      );
      return;
    }
    const nextIndex = (Math.max(0, selectedIndex) + delta + cards.length) % cards.length;
    const next = cards[nextIndex];
    if (next) openCard(next.id);
  }

  // Listens on the window rather than the overlay's own element: the panel focuses its
  // Close button on open, which sits outside the chrome, so an element-level handler
  // missed the first arrow press after opening a card.
  const moveCardRef = useRef(moveCard);
  moveCardRef.current = moveCard;
  const cardOpen = Boolean(search.card);
  useEffect(() => {
    if (!cardOpen) return undefined;
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      const target = event.target;
      const editing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable);
      if (editing || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        moveCardRef.current(-1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        moveCardRef.current(1);
      }
    }
    globalThis.addEventListener('keydown', onKeyDown);
    return () => globalThis.removeEventListener('keydown', onKeyDown);
  }, [cardOpen]);

  const activeChips: FilterChipItem[] = [
    ...search.type.map((type) => ({
      key: `type:${type}`,
      label: `Type: ${FRAME_TYPE_LABELS[type as FrameType] ?? type}`,
    })),
    ...search.rarity.map((rarity) => ({
      key: `rarity:${rarity}`,
      label: `Rarity: ${RARITY_LABELS[rarity as RarityKey] ?? rarity}`,
    })),
    ...search.set.map((setId) => ({
      key: `set:${setId}`,
      label: `Set: ${setsFacet.data?.find((set) => set.setId === setId)?.setName ?? setId}`,
    })),
    ...(search.region ? [{ key: 'region', label: `Region: ${search.region}` }] : []),
    ...(search.artist
      ? [{ key: 'artist', label: search.artist, icon: 'illustrator' as const }]
      : []),
  ];
  const activeFilterCount =
    search.type.length +
    search.rarity.length +
    search.set.length +
    (search.region ? 1 : 0) +
    (search.artist ? 1 : 0);
  // The illustrator is named, not counted: arriving from their tile, the name is the
  // only sign on a phone of whose cards these are.
  const countedFilters = activeFilterCount - (search.artist ? 1 : 0);
  const phoneSummary = [
    search.q ? `“${search.q}”` : search.artist ? null : 'Search cards',
    search.artist ?? null,
    search.owned === 'owned' ? 'Owned' : search.owned === 'missing' ? 'Missing' : null,
    countedFilters > 0 ? `${countedFilters} filter${countedFilters === 1 ? '' : 's'}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  function removeChip(key: string): void {
    if (key === 'region') return updateSearch({ region: undefined });
    if (key === 'artist') return updateSearch({ artist: undefined });
    const [kind, value] = key.split(':');
    if (kind === 'type') updateSearch({ type: search.type.filter((item) => item !== value) });
    else if (kind === 'rarity')
      updateSearch({ rarity: search.rarity.filter((item) => item !== value) });
    else if (kind === 'set') updateSearch({ set: search.set.filter((item) => item !== value) });
  }

  const filtersPanel = <FiltersPanel filters={search} onChange={(patch) => updateSearch(patch)} />;

  return (
    <div className="catalogue-screen">
      <header className="page-heading">
        <div>
          {speciesEntry ? (
            <Link className="text-button back-link" to="/pokedex" search={BLANK_POKEDEX_SEARCH}>
              Back to National Pokédex
            </Link>
          ) : search.set.length === 1 ? (
            <Link className="text-button back-link" to="/sets">
              Back to Sets
            </Link>
          ) : null}
          {contextual ? (
            <Link className="text-button back-link" to="/catalogue" search={BLANK_SEARCH}>
              Show full catalogue
            </Link>
          ) : null}
          <h1>
            {speciesEntry
              ? `${speciesEntry.name} card gallery.`
              : contextSetName
                ? `${contextSetName} card gallery.`
                : 'Find a physical card.'}
          </h1>
          {speciesEntry ? (
            <p className="indexing-status">
              {discover.isPending ? (
                'Checking TCGdex for additional printings…'
              ) : discover.isError ? (
                <>
                  Printing refresh failed.{' '}
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      discover.mutate({ number: speciesEntry.number, name: speciesEntry.name })
                    }
                  >
                    Try again
                  </button>
                </>
              ) : (
                'English physical printings'
              )}
            </p>
          ) : null}
        </div>
      </header>

      {!isDesktop ? (
        <SummaryPill
          className="catalogue-summary-pill"
          summary={phoneSummary}
          count={total}
          expanded={phoneControlsOpen}
          controlsId="catalogue-controls"
          onToggle={() => setPhoneControlsOpen((open) => !open)}
        />
      ) : null}
      {isDesktop || phoneControlsOpen ? (
        <div
          id="catalogue-controls"
          className={isDesktop ? 'catalogue-controls' : 'catalogue-controls summary-panel'}
        >
          <form
            className="catalogue-search-bar"
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              updateSearch({ q: queryDraft });
            }}
          >
            <label className="catalogue-search-field">
              Search
              <input
                value={queryDraft}
                maxLength={200}
                placeholder="Name, set, number or artist"
                onChange={(event) => setQueryDraft(event.target.value)}
              />
            </label>
            <div className="bar-field">
              <span className="bar-field-label" aria-hidden="true">
                Collection
              </span>
              <SegmentedControl<CatalogueOwnedFilter>
                label="Collection"
                value={search.owned}
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'owned', label: 'Owned' },
                  { value: 'missing', label: 'Missing' },
                ]}
                onChange={(owned) => updateSearch({ owned })}
              />
            </div>
            <button type="button" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(true)}>
              <Icon name="filter" /> Filters
              {activeFilterCount > 0 ? (
                <span className="filter-count-badge">{activeFilterCount}</span>
              ) : null}
            </button>
            <button type="submit" disabled={busy}>
              {busy ? 'Searching…' : 'Search'}
            </button>
            <CopyMenu filters={search} cards={cards} total={total} busy={busy} />
            <MenuButton
              className="catalogue-more-menu"
              align="end"
              triggerLabel="More catalogue actions"
              menuLabel="More catalogue actions"
              label={<Icon name="more" />}
            >
              {(close) => (
                <>
                  <MenuItem
                    label="Add these results to a binder…"
                    hint="Every result, in catalogue order."
                    onSelect={() => {
                      close();
                      setRareAction('bulk-add');
                    }}
                  />
                  {!speciesEntry ? (
                    <MenuItem
                      label="Add a card that is not in TCGdex…"
                      hint="A custom card with just a name."
                      onSelect={() => {
                        close();
                        setRareAction('custom-card');
                      }}
                    />
                  ) : null}
                </>
              )}
            </MenuButton>
          </form>

          {activeChips.length > 0 ? (
            <div className="catalogue-active-filters">
              <FilterChips items={activeChips} onRemove={removeChip} />
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  updateSearch({
                    type: [],
                    rarity: [],
                    set: [],
                    region: undefined,
                    artist: undefined,
                  })
                }
              >
                Clear all
              </button>
            </div>
          ) : null}

          {!isDesktop ? (
            <SummaryDoneButton
              className="catalogue-show-results"
              count={total}
              onDone={() => setPhoneControlsOpen(false)}
            />
          ) : null}
        </div>
      ) : null}

      <div ref={galleryRef}>
        <CatalogueGallery
          cards={cards}
          total={total}
          page={search.page}
          loading={galleryLoading}
          selectedCardId={search.card}
          onOpen={openCard}
        />
      </div>
      <Pagination
        page={search.page}
        totalPages={Math.max(1, Math.ceil(total / PAGE_SIZE))}
        pending={busy}
        label="Catalogue pages"
        onPage={moveToPage}
      />

      {isDesktop ? (
        <SidePanel open={filtersOpen} onClose={() => setFiltersOpen(false)} title="Filters">
          {filtersPanel}
        </SidePanel>
      ) : (
        <Sheet open={filtersOpen} onClose={() => setFiltersOpen(false)} title="Filters">
          {filtersPanel}
        </Sheet>
      )}

      <RareActionOverlay
        desktop={isDesktop}
        open={rareAction === 'bulk-add'}
        onClose={() => setRareAction(null)}
        title="Add these results to a binder"
      >
        <BulkAddToBinder filters={search} total={total} onClose={() => setRareAction(null)} />
      </RareActionOverlay>
      <RareActionOverlay
        desktop={isDesktop}
        open={rareAction === 'custom-card'}
        onClose={() => setRareAction(null)}
        title="Add a card that is not in TCGdex"
      >
        <CustomCardForm onClose={() => setRareAction(null)} />
      </RareActionOverlay>

      {search.card ? (
        <SidePanel
          open
          onClose={requestCloseCard}
          title="Card"
          toolbar={
            <div className="card-overlay-nav">
              <button
                type="button"
                aria-label="Previous card"
                onClick={() => moveCard(-1)}
                disabled={cards.length < 2}
              >
                <Icon name="chevron-left" />
              </button>
              <button
                type="button"
                aria-label="Next card"
                onClick={() => moveCard(1)}
                disabled={cards.length < 2}
              >
                <Icon name="chevron-right" />
              </button>
              {selectedIndex >= 0 ? (
                <span>
                  {selectedIndex + 1} of {cards.length}
                </span>
              ) : null}
            </div>
          }
        >
          <CardInspector
            cardId={search.card}
            onClose={requestCloseCard}
            onDirtyChange={setDirtyInspector}
          />
        </SidePanel>
      ) : null}
    </div>
  );
}

function RareActionOverlay({
  desktop,
  open,
  onClose,
  title,
  children,
}: {
  desktop: boolean;
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}): ReactElement {
  return desktop ? (
    <Dialog open={open} onClose={onClose} title={title}>
      {children}
    </Dialog>
  ) : (
    <Sheet open={open} onClose={onClose} title={title}>
      {children}
    </Sheet>
  );
}
