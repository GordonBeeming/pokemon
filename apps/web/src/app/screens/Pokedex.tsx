import {
  formatDexNumber,
  frameTypeFor,
  NATIONAL_POKEDEX,
  type NationalPokedexEntry,
  POKEMON_DISCOVERY_CATEGORIES,
} from '@pokedex/shared';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import {
  recentlyDiscoveredSpecies,
  useDiscoverSpecies,
  useNationalPokedex,
  type NationalPokedexCoverage,
} from '../api/queries/pokedex';
import { CardFrame } from '../cards/CardFrame';
import {
  catalogueSearch,
  type PokedexOwnedFilter,
  type PokedexSearch,
} from '../routes/search-params';
import { EmptyState } from '../ui/EmptyState';
import { SegmentedControl } from '../ui/SegmentedControl';
import { SelectField } from '../ui/SelectField';
import { InfiniteLoader } from '../ui/InfiniteLoader';
import { useInfiniteWindow } from '../ui/useInfiniteWindow';
import './pokedex/pokedex.css';

function matches(
  entry: NationalPokedexEntry,
  state: NationalPokedexCoverage | undefined,
  needle: string,
): boolean {
  if (!needle) return true;
  const padded = formatDexNumber(entry.number).slice(1);
  return (
    entry.name.toLocaleLowerCase('en-AU').includes(needle) ||
    entry.discoveryCategory.toLocaleLowerCase('en-AU').includes(needle) ||
    padded.includes(needle.replace(/^#/u, '')) ||
    (state?.types.some((type) => type.toLocaleLowerCase('en-AU').includes(needle)) ?? false)
  );
}

// The select's key for "every region" (a key can't be an empty string).
const ALL_REGIONS = 'all';

export function Pokedex({ search }: { search: PokedexSearch }): ReactElement {
  const navigate = useNavigate({ from: '/pokedex' });
  const coverage = useNationalPokedex();
  const discover = useDiscoverSpecies();
  const [pendingNumber, setPendingNumber] = useState<number | null>(null);
  const list = useRef<HTMLDivElement>(null);

  const coverageByNumber = useMemo(
    () => new Map((coverage.data ?? []).map((entry) => [entry.number, entry])),
    [coverage.data],
  );

  // Restore keyboard focus once the species grid is present; the router restores scroll.
  useEffect(() => {
    if (coverage.isLoading) return;
    const focusedNumber = search.dex;
    if (focusedNumber !== undefined)
      requestAnimationFrame(() => {
        document
          .querySelector<HTMLButtonElement>(
            `.pokedex-grid button[aria-label*="Pokédex ${formatDexNumber(focusedNumber)}"]`,
          )
          ?.focus({ preventScroll: true });
      });
    // Runs once the data that makes the grid tall enough to scroll into exists —
    // not on every coverage refetch, and not keyed on `search.dex` since that
    // value should only drive focus on this initial restoration, never again
    // while the visitor is actively paging or filtering.
  }, [coverage.isLoading]);

  function updateSearch(patch: Partial<PokedexSearch>, resetPage = true): void {
    void navigate({
      search: (prev) => ({ ...prev, ...patch, page: resetPage ? 1 : (patch.page ?? prev.page) }),
    });
  }

  const needle = search.q.trim().toLocaleLowerCase('en-AU');
  const regionOptions = useMemo(() => {
    const matchesBase = (entry: NationalPokedexEntry): boolean => {
      const state = coverageByNumber.get(entry.number);
      const owned = (state?.ownedCards ?? 0) > 0;
      if (search.filter === 'owned' && !owned) return false;
      if (search.filter === 'missing' && owned) return false;
      return matches(entry, state, needle);
    };
    return [
      { value: '', label: 'All regions', count: NATIONAL_POKEDEX.filter(matchesBase).length },
      ...POKEMON_DISCOVERY_CATEGORIES.map((region) => ({
        value: region,
        label: region,
        count: NATIONAL_POKEDEX.filter(
          (entry) => entry.discoveryCategory === region && matchesBase(entry),
        ).length,
      })),
    ];
  }, [coverageByNumber, needle, search.filter]);

  const filtered = useMemo(
    () =>
      NATIONAL_POKEDEX.filter((entry) => {
        const state = coverageByNumber.get(entry.number);
        const owned = (state?.ownedCards ?? 0) > 0;
        if (search.filter === 'owned' && !owned) return false;
        if (search.filter === 'missing' && owned) return false;
        if (search.region && entry.discoveryCategory !== search.region) return false;
        return matches(entry, state, needle);
      }),
    [coverageByNumber, needle, search.filter, search.region],
  );

  const ownedSpecies = (coverage.data ?? []).filter((entry) => entry.ownedCards > 0).length;
  const windowed = useInfiniteWindow(
    filtered,
    JSON.stringify(['pokedex', search.q, search.filter, search.region]),
  );
  const visible = windowed.items;

  function openSpecies(entry: NationalPokedexEntry): void {
    if (pendingNumber !== null) return;
    if (!recentlyDiscoveredSpecies(entry.number)) {
      setPendingNumber(entry.number);
      discover.mutate(
        { number: entry.number, name: entry.name },
        { onSettled: () => setPendingNumber(null) },
      );
    }
    // Replaces (not pushes) this screen's own history entry so a single Back from
    // Catalogue restores the focused tile, rather than bouncing through an
    // intermediate entry — the focused tile survives leaving and returning.
    void navigate({
      to: '/pokedex',
      search: { ...search, dex: entry.number },
      replace: true,
      resetScroll: false,
    });
    void navigate({ to: '/catalogue', search: catalogueSearch.parse({ dex: entry.number }) });
  }

  return (
    <div className="pokedex-screen">
      <header className="page-heading">
        <div>
          <h1>Plan the full National Pokédex.</h1>
          <p>Open a species to see every English printing of it.</p>
          <Link
            className="trainer-dex-entry-link"
            to="/trainer-dex"
            search={{ q: '', region: 'all', available: true, page: 1 }}
          >
            Trainer Dex
          </Link>
        </div>
        <div className="pokedex-progress" aria-label={`${ownedSpecies} of 1,025 species owned`}>
          <strong>{ownedSpecies.toLocaleString('en-AU')}</strong>
          <span>of 1,025 species owned</span>
        </div>
      </header>

      <form className="pokedex-toolbar" role="search" onSubmit={(event) => event.preventDefault()}>
        <label>
          Find a Pokémon
          <input
            type="search"
            value={search.q}
            placeholder="Name, #number, type, or first-found region"
            onChange={(event) => updateSearch({ q: event.target.value })}
          />
        </label>
        <SelectField
          className="pokedex-region"
          label="First found region"
          value={search.region ?? ALL_REGIONS}
          options={regionOptions.map((option) => ({
            value: option.value || ALL_REGIONS,
            label: `${option.label} (${option.count.toLocaleString('en-AU')})`,
          }))}
          onChange={(region) =>
            updateSearch({ region: region === ALL_REGIONS ? undefined : region })
          }
        />
        <SegmentedControl<PokedexOwnedFilter>
          label="Collection"
          value={search.filter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'owned', label: 'Owned' },
            { value: 'missing', label: 'Missing' },
          ]}
          onChange={(filter) => updateSearch({ filter })}
        />
      </form>
      <p className="live-status" role="status" aria-live="polite" aria-atomic="true">
        Showing {visible.length.toLocaleString('en-AU')} of{' '}
        {filtered.length.toLocaleString('en-AU')} matching species.
      </p>

      {visible.length === 0 ? (
        <EmptyState icon="pokedex" title="No Pokémon match these filters." />
      ) : (
        <div className="pokedex-grid" ref={list}>
          {visible.map((entry) => {
            const state = coverageByNumber.get(entry.number);
            const owned = (state?.ownedCards ?? 0) > 0;
            const representative = state?.representative;
            // The coverage entry's own `types` gives the frame colour, derived the
            // same way the worker does for every other card.
            const frameType = state
              ? frameTypeFor({ category: 'pokemon', types: state.types, name: entry.name })
              : null;
            return (
              <CardFrame
                key={entry.number}
                card={
                  representative
                    ? {
                        id: representative.cardId,
                        name: entry.name,
                        frameType,
                        setCode: representative.setCode ?? null,
                        number: representative.number,
                        rarityKey: representative.rarityKey ?? null,
                        pokedexNumber: entry.number,
                        imageUrl: representative.imageLowUrl,
                      }
                    : {
                        id: `species-${entry.number}`,
                        name: entry.name,
                        frameType,
                        setCode: null,
                        number: null,
                        rarityKey: null,
                        pokedexNumber: entry.number,
                        imageUrl: null,
                      }
                }
                variant={representative ? 'card' : 'any'}
                state={owned ? 'owned' : 'unowned'}
                onView={() => openSpecies(entry)}
                className={pendingNumber === entry.number ? 'pokedex-tile-pending' : undefined}
              />
            );
          })}
        </div>
      )}

      <InfiniteLoader
        hasMore={windowed.hasMore}
        loading={false}
        loadedCount={visible.length}
        label="Pokémon"
        onLoadMore={windowed.loadMore}
      />
    </div>
  );
}
