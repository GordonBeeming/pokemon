import type { CatalogueCardView } from '@pokedex/shared';
import type { ReactElement } from 'react';
import { CardFrame } from '../../cards/CardFrame';
import { CardFrameSkeleton } from '../../ui/Skeleton';
import { EmptyState } from '../../ui/EmptyState';

const PAGE_SIZE = 50;

function toFrameCard(card: CatalogueCardView) {
  return {
    id: card.id,
    name: card.name,
    frameType: card.frameType ?? null,
    setCode: card.setCode ?? null,
    number: card.number,
    rarityKey: card.rarityKey ?? null,
    pokedexNumber: card.pokedexNumber ?? null,
    imageUrl: card.imageLowUrl,
  };
}

export function CatalogueGallery({
  cards,
  total,
  page,
  loading,
  selectedCardId,
  onOpen,
}: {
  cards: CatalogueCardView[];
  total: number;
  page: number;
  loading: boolean;
  selectedCardId: string | undefined;
  onOpen: (cardId: string) => void;
}): ReactElement {
  const first = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const last = Math.min(total, (page - 1) * PAGE_SIZE + cards.length);

  return (
    <section className="catalogue-gallery" aria-label="Catalogue results">
      <p className="live-status" role="status" aria-live="polite" aria-atomic="true">
        {loading ? '' : `Showing ${first} to ${last} of ${total} cards.`}
      </p>
      {loading ? (
        <div className="catalogue-grid">
          {Array.from({ length: 12 }, (_, index) => (
            <CardFrameSkeleton key={index} />
          ))}
        </div>
      ) : cards.length === 0 ? (
        <EmptyState
          icon="magnifier"
          title="No cards match this search."
          description="Try fewer words or clear the search."
        />
      ) : (
        <div className="catalogue-grid">
          {cards.map((card) => {
            const owned = (card.collection?.quantity ?? 0) > 0;
            return (
              <CardFrame
                key={card.id}
                card={toFrameCard(card)}
                state={owned ? 'owned' : 'unowned'}
                copies={card.collection?.quantity}
                selected={selectedCardId === card.id}
                onView={() => onOpen(card.id)}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}
