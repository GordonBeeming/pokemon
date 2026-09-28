import { RARITY_KEYS, RARITY_LABELS } from '@pokedex/shared';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { Button, Disclosure, DisclosurePanel, Heading } from 'react-aria-components';
import { useSession } from '../api/queries/session';
import { useSetCodes, useSets } from '../api/queries/sets';
import { RARITY_VISUALS, rarityToneColour } from '../cards/rarity-visuals';
import { catalogueSearch, illustratorsSearch, type SetsSearch } from '../routes/search-params';
import { EmptyState } from '../ui/EmptyState';
import { Icon } from '../ui/icons';
import { useIsDesktop } from './catalogue/useIsDesktop';
import { useMediaQuery } from './binders/useMediaQuery';
import { SetCodeEditor } from './sets/SetCodeEditor';
import './sets/sets.css';

// Wide enough for the legend to sit beside a grid that still has room for its cards.
const LEGEND_BESIDE_QUERY = '(min-width: 1280px)';

function formatReleaseDate(value: string | null): string {
  if (!value) return 'Release date unknown';
  return new Intl.DateTimeFormat('en-AU', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(new Date(value));
}

/** Every rarity with its symbol drawn exactly as a card frame draws it on a pale
 * (unowned) frame: same symbol, same metal colour. */
function RarityLegendList(): ReactElement {
  return (
    <ul className="rarity-legend-list">
      {RARITY_KEYS.map((key) => {
        const visual = RARITY_VISUALS[key];
        return (
          <li key={key}>
            <span
              className="rarity-symbol"
              aria-hidden="true"
              style={{ color: rarityToneColour(visual.tone, false, 'var(--ink)') }}
            >
              {visual.icon}
            </span>
            <span className="rarity-name">{RARITY_LABELS[key]}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function Sets({ search }: { search: SetsSearch }): ReactElement {
  const navigate = useNavigate({ from: '/sets' });
  const session = useSession();
  // `role` is optional (a worker from before multi-user landed omits it entirely),
  // so an absent role still means admin — the fallback this workstream's spec asks
  // for is the same "field not there yet" case the session schema already covers.
  const isAdmin = session.data?.role === undefined || session.data.role === 'admin';
  const setCodes = useSetCodes();
  // Contract B's own list (code/codeSource/releaseDate/cardCount) doesn't carry
  // owned counts; the pre-existing facets endpoint does — joined here by
  // setId+language rather than asking ws-data-2 to widen their contract for one row.
  const facets = useSets();
  const [query, setQuery] = useState('');
  const legendBeside = useMediaQuery(LEGEND_BESIDE_QUERY);
  const isDesktop = useIsDesktop();

  const facetByKey = useMemo(
    () => new Map((facets.data ?? []).map((facet) => [`${facet.setId}:${facet.language}`, facet])),
    [facets.data],
  );

  const clashedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const clash of setCodes.data?.codeClashes ?? [])
      for (const setId of clash.setIds) ids.add(setId);
    return ids;
  }, [setCodes.data]);

  const needle = query.trim().toLocaleLowerCase('en-AU');
  const filtered = (setCodes.data?.sets ?? []).filter(
    (set) =>
      !needle ||
      set.setName.toLocaleLowerCase('en-AU').includes(needle) ||
      (set.code ?? set.setId).toLocaleLowerCase('en-AU').includes(needle),
  );

  // A set opened from here scrolls back into view on return, matching the same
  // "survives leaving and returning" treatment Pokédex gives its focused tile.
  useEffect(() => {
    if (!search.set) return;
    document.getElementById(`set-row-${search.set}`)?.scrollIntoView({ block: 'center' });
  }, [search.set, setCodes.data]);

  function openSet(setId: string, language: string): void {
    void navigate({ to: '/sets', search: { set: setId }, replace: true });
    void navigate({
      to: '/catalogue',
      search: catalogueSearch.parse({ set: [setId], language }),
    });
  }

  return (
    <div className="sets-screen">
      <section aria-labelledby="sets-heading" className="sets-list-section">
        <header className="page-heading">
          <div>
            <h1 id="sets-heading">Sets</h1>
            <p>The code is what card frames show.</p>
          </div>
          {/* Desktop reaches Illustrators from the rail; the phone tab bar has no
              room for a 7th icon, so this is its only route in. */}
          {isDesktop ? null : (
            <Link
              className="sets-illustrators-link"
              to="/illustrators"
              search={illustratorsSearch.parse({})}
            >
              <Icon name="illustrator" />
              Illustrators
            </Link>
          )}
        </header>
        <label className="sr-only" htmlFor="sets-find">
          Find a set
        </label>
        <input
          id="sets-find"
          type="search"
          placeholder="Find a set by name or code"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {legendBeside ? null : (
          <Disclosure className="sets-legend-disclosure">
            <Heading className="sets-legend-heading">
              <Button slot="trigger" className="sets-legend-trigger">
                <Icon name="chevron-down" className="sets-legend-chevron" />
                Rarity symbols
              </Button>
            </Heading>
            <DisclosurePanel>
              <RarityLegendList />
            </DisclosurePanel>
          </Disclosure>
        )}
        <p className="sets-status" role="status" aria-live="polite">
          Showing all {filtered.length} matching sets.
        </p>

        {setCodes.isError ? (
          <EmptyState
            icon="sets"
            title="Nothing to show yet."
            description="Set codes could not load."
          />
        ) : filtered.length === 0 && !setCodes.isLoading ? (
          <EmptyState icon="sets" title="Nothing to show yet." />
        ) : (
          <ul className="sets-list">
            {filtered.map((set) => {
              const facet = facetByKey.get(`${set.setId}:${set.language}`);
              const total = facet?.total ?? set.cardCount;
              const owned = facet?.owned ?? 0;
              const clash = clashedIds.has(set.setId);
              return (
                <li
                  key={`${set.setId}:${set.language}`}
                  id={`set-row-${set.setId}`}
                  className="set-card"
                >
                  {set.code ? (
                    <span className={clash ? 'set-code set-code-clash' : 'set-code'}>
                      {set.code}
                    </span>
                  ) : (
                    // What card frames print when a set has no official code.
                    <span
                      className="set-code set-code-suggested"
                      title="No official code; edit to set one"
                    >
                      {set.setId.toUpperCase()}
                      <span className="sr-only"> (no official code)</span>
                    </span>
                  )}
                  <button
                    type="button"
                    className="set-row-link"
                    onClick={() => openSet(set.setId, set.language)}
                  >
                    <span className="set-name">{set.setName}</span>
                    <span className="set-meta">
                      {formatReleaseDate(set.releaseDate)} · {set.language.toUpperCase()}
                    </span>
                  </button>
                  {isAdmin ? <SetCodeEditor set={set} clash={clash} /> : null}
                  {clash ? (
                    <span className="set-clash-note">Shares this code with another set.</span>
                  ) : null}
                  <span className="set-progress">
                    <span className="set-progress-numbers">
                      {owned} / {total}
                    </span>
                    <span className="set-progress-bar">
                      <span
                        style={{ width: `${total ? Math.min(100, (owned / total) * 100) : 0}%` }}
                      />
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {legendBeside ? (
        <aside aria-labelledby="rarity-heading" className="sets-rarity-legend">
          <h2 id="rarity-heading">Rarity symbols</h2>
          <RarityLegendList />
        </aside>
      ) : null}
    </div>
  );
}
