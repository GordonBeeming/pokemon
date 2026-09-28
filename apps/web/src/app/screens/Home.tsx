import { Link, useNavigate } from '@tanstack/react-router';
import { useRef, useState, type ReactElement } from 'react';
import { activeShortageCount, useDashboard } from '../api/queries/dashboard';
import { CardFrame } from '../cards/CardFrame';
import { catalogueSearch, pokedexSearch } from '../routes/search-params';
import { ActiveShortagesPanel } from './home/ActiveShortagesPanel';
import './home/home.css';

function formatMoney(amountAud: number): string {
  return `A$${new Intl.NumberFormat('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amountAud)}`;
}

export function Home(): ReactElement {
  const dashboard = useDashboard();
  const navigate = useNavigate();
  const [shortagesOpen, setShortagesOpen] = useState(false);
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

  return (
    <div className="home-screen">
      <header className="page-heading">
        <div>
          <h1>Your card room.</h1>
          <p>Browse what is on the shelf, then move naturally into hunting or Pokédex planning.</p>
        </div>
        <div className="header-actions">
          <Link className="primary-button" to="/catalogue" search={catalogueSearch.parse({})}>
            Browse cards
          </Link>
          <Link to="/pokedex" search={pokedexSearch.parse({})}>
            Plan the Pokédex
          </Link>
        </div>
      </header>

      <section className="metric-grid" aria-label="Collection measures">
        <article className="metric">
          <p>Owned unique</p>
          <strong>{data.collection.uniqueOwned}</strong>
        </article>
        <article className="metric">
          <p>Total quantity</p>
          <strong>{data.collection.totalQuantity}</strong>
        </article>
        <article className="metric">
          <p>Collection estimate</p>
          <strong>{formatMoney(data.pricing.estimateAud)}</strong>
        </article>
        <button
          type="button"
          className="metric metric-action"
          ref={shortageTrigger}
          aria-expanded={shortagesOpen}
          aria-controls="active-shortages-panel"
          onClick={() => setShortagesOpen((current) => !current)}
        >
          <p>Active shortages</p>
          <strong>{shortageTotal}</strong>
          <span>{shortagesOpen ? 'Hide shortage report' : 'View shortage report'}</span>
        </button>
      </section>

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
                }}
                state="owned"
                copies={card.collection?.quantity}
                onView={() =>
                  void navigate({
                    to: '/catalogue',
                    search: catalogueSearch.parse({ q: card.name }),
                  })
                }
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
