import type { DashboardStillToFindItem } from '@pokedex/shared';
import { Link, useNavigate } from '@tanstack/react-router';
import { useRef, useState, type ReactElement } from 'react';
import { activeShortageCount, useDashboard } from '../api/queries/dashboard';
import { CardFrame } from '../cards/CardFrame';
import { CardInspector } from './card/CardInspector';
import { useIsDesktop } from './catalogue/useIsDesktop';
import { catalogueSearch } from '../routes/search-params';
import { SidePanel } from '../ui/SidePanel';
import { useToast } from '../ui/Toast';
import { ActiveShortagesPanel } from './home/ActiveShortagesPanel';
import type { HomeSearch } from './home/search';
import './home/home.css';
import { useShowPrices } from '../cards/PriceVisibility';

function formatMoney(amountAud: number): string {
  return `A$${new Intl.NumberFormat('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amountAud)}`;
}

/** Deep-links a "Still to find" row into the catalogue: a species target scopes to
 * its Pokédex gallery, an exact-printing target opens that card directly — the
 * same two link shapes ActiveShortagesPanel's full report already uses. */
function stillToFindHref(item: DashboardStillToFindItem) {
  if (item.kind === 'pokemon' && item.pokemonNumber !== null)
    return catalogueSearch.parse({ dex: item.pokemonNumber });
  return catalogueSearch.parse({ card: item.cardId ?? undefined });
}

export function Home({
  search,
  onOpenCard,
  onCloseCard,
}: {
  search: HomeSearch;
  /** Desktop: the shelf's open card lives in Home's own `?card=` search param, so
   * Back closes the panel instead of leaving Home. */
  onOpenCard: (cardId: string) => void;
  onCloseCard: () => void;
}): ReactElement {
  const showPrices = useShowPrices();
  const dashboard = useDashboard();
  const navigate = useNavigate();
  const isDesktop = useIsDesktop();
  const toast = useToast();
  const [shortagesOpen, setShortagesOpen] = useState(false);
  const [dirtyInspector, setDirtyInspector] = useState(false);
  const shortageTrigger = useRef<HTMLButtonElement>(null);

  if (dashboard.isLoading)
    return (
      <section aria-busy="true">
        <h1>Loading dashboard…</h1>
      </section>
    );

  if (dashboard.isError || !dashboard.data)
    return (
      <section>
        <h1>Dashboard could not load.</h1>
        <button type="button" onClick={() => void dashboard.refetch()}>
          Try again
        </button>
      </section>
    );

  const data = dashboard.data;
  const shortageTotal = activeShortageCount(data);

  // Gordon: "if you click on a recent card you want to see it... not as if you're
  // browsing the other full pages" — desktop keeps the shelf's card in Home's own
  // URL state (a side panel), phone goes to the standalone card route instead of a
  // panel that would cover the whole screen anyway.
  function openCard(cardId: string): void {
    if (isDesktop) onOpenCard(cardId);
    else void navigate({ to: '/card/$cardId', params: { cardId } });
  }

  function requestCloseCard(): void {
    if (dirtyInspector) {
      toast(
        'error',
        'Notes are still saving. Wait a moment, or fix the save error, then try again.',
      );
      return;
    }
    onCloseCard();
  }

  return (
    <div className="home-screen">
      <header className="page-heading">
        <h1>Your card room.</h1>
        <div className="header-actions">
          <Link className="primary-button" to="/catalogue" search={catalogueSearch.parse({})}>
            Find a card
          </Link>
        </div>
      </header>

      <section className="metric-grid" aria-label="Collection measures">
        <article className="metric">
          <p>Printings owned</p>
          <strong>{data.collection.uniqueOwned}</strong>
        </article>
        <article className="metric">
          <p>Copies</p>
          <strong>{data.collection.totalQuantity}</strong>
        </article>
        {showPrices ? (
          <article className="metric">
            <p>Estimated value</p>
            <strong>{formatMoney(data.pricing.estimateAud)}</strong>
          </article>
        ) : null}
      </section>

      <div className="home-body">
        <section className="collection-shelf" aria-labelledby="collection-shelf-heading">
          <div className="shelf-heading">
            <h2 id="collection-shelf-heading">Recently added cards</h2>
            <span>{data.collection.uniqueOwned} unique</span>
          </div>
          {data.cards.length === 0 ? (
            <div className="empty-state">
              <h2>Your shelf is ready.</h2>
              <p>Find a card to add the first physical copy.</p>
            </div>
          ) : (
            <div className="shelf-cards">
              {data.cards.map((card) => (
                <CardFrame
                  key={card.id}
                  card={{
                    id: card.id,
                    name: card.name,
                    frameType: card.frameType ?? null,
                    setCode: card.setCode ?? null,
                    number: card.number,
                    rarityKey: card.rarityKey ?? null,
                    pokedexNumber: card.pokedexNumber ?? null,
                    imageUrl: card.imageLowUrl,
                    priceAud: card.price.amountAud,
                  }}
                  state="owned"
                  onView={() => openCard(card.id)}
                />
              ))}
            </div>
          )}
        </section>

        <aside className="home-column">
          <section aria-labelledby="home-binders-heading" className="home-binders">
            <h2 id="home-binders-heading">Binders</h2>
            {data.binders.length === 0 ? (
              <p className="home-column-empty">No binders yet.</p>
            ) : (
              <div className="binder-progress-list">
                {data.binders.map((binder) => (
                  <Link
                    key={binder.id}
                    className="binder-progress-row"
                    to="/binders/$binderId"
                    params={{ binderId: binder.id }}
                    search={{ page: 1, q: '' }}
                  >
                    <span className="binder-progress-row-head">
                      <span>{binder.name}</span>
                      <span>
                        {binder.placed} of {binder.targets} placed
                      </span>
                    </span>
                    <span className="progress-track">
                      <span className="progress-fill" style={{ width: `${binder.percent}%` }} />
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </section>

          <section aria-labelledby="home-still-to-find-heading" className="home-still-to-find">
            <div className="section-heading-row">
              <h2 id="home-still-to-find-heading">Still to find</h2>
              <button
                type="button"
                className="text-button home-still-to-find-toggle"
                ref={shortageTrigger}
                aria-expanded={shortagesOpen}
                aria-controls="active-shortages-panel"
                onClick={() => setShortagesOpen((current) => !current)}
              >
                {shortagesOpen ? 'Hide' : `All ${shortageTotal}`}
              </button>
            </div>
            {data.stillToFind.length === 0 ? (
              <p className="home-column-empty">Nothing missing right now.</p>
            ) : (
              <ul className="still-to-find-list">
                {data.stillToFind.map((item) => (
                  <li key={`${item.kind}:${item.cardId ?? item.pokemonNumber}`}>
                    <Link to="/catalogue" search={stillToFindHref(item)}>
                      <span>{item.label}</span>
                      <span>{item.binderName ?? 'Any binder'}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {shortagesOpen ? (
              <div id="active-shortages-panel">
                <ActiveShortagesPanel
                  closeButtonRef={shortageTrigger}
                  onClose={() => {
                    setShortagesOpen(false);
                    requestAnimationFrame(() => shortageTrigger.current?.focus());
                  }}
                />
              </div>
            ) : null}
          </section>
        </aside>
      </div>

      {isDesktop && search.card ? (
        <SidePanel open onClose={requestCloseCard} title="Card">
          <CardInspector
            cardId={search.card}
            onClose={requestCloseCard}
            onDirtyChange={setDirtyInspector}
            context={{ from: 'home' }}
          />
        </SidePanel>
      ) : null}
    </div>
  );
}
