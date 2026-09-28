import {
  frameTypeFor,
  NATIONAL_POKEDEX,
  POKEMON_DISCOVERY_CATEGORIES,
  type NationalPokedexEntry,
} from '@pokedex/shared';
import { useNavigate } from '@tanstack/react-router';
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
import { Pagination } from './catalogue/Pagination';
import './pokedex/pokedex.css';

const PAGE_SIZE = 50;
const SCROLL_KEY = 'pokedex:scroll-y';

function matches(
  entry: NationalPokedexEntry,
  state: NationalPokedexCoverage | undefined,
  needle: string,
): boolean {
  if (!needle) return true;
  const padded = String(entry.number).padStart(4, '0');
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

  // Scroll position survives leaving and returning — restored once, on the first
  // paint after the coverage data (and therefore the grid) is actually present.
  useEffect(() => {
    if (coverage.isLoading) return;
    const saved = Number(sessionStorage.getItem(SCROLL_KEY) ?? '0');
    if (saved > 0) window.scrollTo({ top: saved });
    if (search.dex !== undefined)
      requestAnimationFrame(() => {
        document
          .querySelector<HTMLButtonElement>(`[data-pokedex-number="${search.dex}"]`)
          ?.focus({ preventScroll: true });
      });
    // Runs once the data that makes the grid tall enough to scroll into exists —
    // not on every coverage refetch, and not keyed on `search.dex` since that
    // value should only drive focus on this initial restoration, never again
    // while the visitor is actively paging or filtering.
  }, [coverage.isLoading]);

  useEffect(() => {
    const onScroll = (): void => {
      try {
        sessionStorage.setItem(SCROLL_KEY, String(window.scrollY));
      } catch {
        // Storage can be unavailable in private/locked-down contexts; losing scroll
        // restoration on return is a minor cost, not worth failing the screen for.
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

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
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(search.page, totalPages);
  const visible = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

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
    void navigate({ to: '/pokedex', search: { ...search, dex: entry.number }, replace: true });
    void navigate({ to: '/catalogue', search: catalogueSearch.parse({ dex: entry.number }) });
  }

  return (
    <div className="pokedex-screen">
      <header className="page-heading">
        <div>
          <h1>Plan the full National Pokédex.</h1>
          <p>Open a species to see every English printing of it.</p>
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

      <Pagination
        page={safePage}
        totalPages={totalPages}
        pending={coverage.isLoading}
        label="National Pokédex pages"
        onPage={(page) => {
          updateSearch({ page }, false);
          requestAnimationFrame(() => list.current?.scrollIntoView({ block: 'start' }));
        }}
      />
    </div>
  );
}
