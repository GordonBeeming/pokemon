import type { BinderSearchMatch, FrameType } from '@pokedex/shared';
import { useState, type ReactElement } from 'react';
import {
  type ResolvedCard,
  useBinderSpaceSearch,
  useResolvedCardGroups,
  useSpeciesPrintings,
} from '../../api/queries/binders';
import { CardFrame } from '../../cards/CardFrame';
import { EmptyState } from '../../ui/EmptyState';
import { CardFrameSkeleton } from '../../ui/Skeleton';
import { binderErrorMessage, frameCardFrom } from './model';

const PAGE_SIZE = 50;
/** How many printings an unfilled "any printing" pocket shows before "+N more". */
const PRINTINGS_PER_POCKET = 24;

type Tile =
  | {
      key: string;
      match: BinderSearchMatch;
      card: ResolvedCard;
      faded: boolean;
      note: string;
    }
  | { key: string; match: BinderSearchMatch; card: null; note: string };

function whereOf(match: BinderSearchMatch): string {
  return match.row !== null && match.column !== null
    ? `Page ${match.page + 1} · row ${match.row + 1}, pocket ${match.column + 1}`
    : `Page ${match.page + 1}`;
}

function owned(card: ResolvedCard): boolean {
  return (card.collection?.quantity ?? 0) > 0;
}

function tilesFor(
  match: BinderSearchMatch,
  cards: ReadonlyMap<string, ResolvedCard>,
  printings: ReadonlyMap<number, { cards: ResolvedCard[]; total: number }>,
): Tile[] {
  const base = `${match.page}-${match.row}-${match.column}`;
  const placed = match.assignedCardId ? cards.get(match.assignedCardId) : undefined;
  if (placed) return [{ key: base, match, card: placed, faded: false, note: 'Placed' }];
  const target = match.targetCardId ? cards.get(match.targetCardId) : undefined;
  if (target)
    return [
      {
        key: base,
        match,
        card: target,
        faded: !owned(target),
        note: owned(target) ? 'Owned · pocket open' : 'Not owned · pocket open',
      },
    ];
  // An open "any printing" pocket shows every printing it could hold, the same way the
  // catalogue does: what you own at full colour, the rest faded.
  const species =
    match.kind === 'pokemon' && match.pokemonNumber
      ? printings.get(match.pokemonNumber)
      : undefined;
  if (species && species.cards.length > 0)
    return species.cards.map((card) => ({
      key: `${base}-${card.id}`,
      match,
      card,
      faded: !owned(card),
      note: owned(card) ? 'Owned · pocket open' : 'Not owned · pocket open',
    }));
  // Set, group, reserved and empty pockets have no one card to draw, so they stay empty.
  return [{ key: base, match, card: null, note: match.label }];
}

/** "Find in this binder" as a card grid: every matching pocket drawn the way the
 * catalogue draws cards. Choosing a tile jumps to that pocket in the binder. */
export function BinderSearchResults({
  versionId,
  query,
  palette,
  onJump,
}: {
  versionId: string;
  query: string;
  palette: Record<FrameType, string>;
  onJump: (match: BinderSearchMatch) => void;
}): ReactElement {
  const [offset, setOffset] = useState(0);
  const results = useBinderSpaceSearch(versionId, query, offset);
  const matches = results.data?.matches ?? [];
  const nextOffset = results.data?.nextOffset ?? null;
  const cardIds = matches.flatMap((match) =>
    [match.assignedCardId, match.targetCardId].filter((id): id is string => Boolean(id)),
  );
  const resolved = useResolvedCardGroups([cardIds]);
  const openSpecies = matches
    .filter((match) => match.kind === 'pokemon' && !match.placed && match.pokemonNumber)
    .map((match) => match.pokemonNumber as number);
  const speciesQueries = useSpeciesPrintings(openSpecies, PRINTINGS_PER_POCKET);

  const cards = new Map<string, ResolvedCard>();
  for (const query of resolved) for (const card of query.data ?? []) cards.set(card.id, card);
  const printings = new Map<number, { cards: ResolvedCard[]; total: number }>();
  [...new Set(openSpecies)].forEach((pokemonNumber, index) => {
    const data = speciesQueries[index]?.data;
    if (data) printings.set(pokemonNumber, { cards: data.cards, total: data.total });
  });

  const loading =
    results.isPending ||
    resolved.some((item) => item.isPending) ||
    speciesQueries.some((item) => item.isPending);
  const tiles = matches.flatMap((match) => tilesFor(match, cards, printings));
  const status = results.isError
    ? binderErrorMessage(results.error)
    : loading
      ? 'Searching binder…'
      : matches.length
        ? `${matches.length} matching ${matches.length === 1 ? 'pocket' : 'pockets'}${offset > 0 || nextOffset !== null ? `, ${offset + 1} to ${offset + matches.length}` : ''}.`
        : '';

  return (
    <section className="binder-results" aria-label={`Binder matches for ${query}`}>
      <p className="live-status" role="status" aria-live="polite" aria-atomic="true">
        {status}
      </p>
      {results.isError ? null : loading ? (
        <div className="binder-results-grid">
          {Array.from({ length: 8 }, (_, index) => (
            <CardFrameSkeleton key={index} />
          ))}
        </div>
      ) : matches.length === 0 ? (
        <EmptyState
          icon="magnifier"
          title="Nothing in this binder matches."
          description="Try a Pokémon, set, number or artist, or clear the search to see the pages."
        />
      ) : (
        <ul className="binder-results-grid">
          {tiles.map((tile) => {
            const where = whereOf(tile.match);
            const more =
              tile.card && tile.match.kind === 'pokemon' && tile.match.pokemonNumber
                ? printings.get(tile.match.pokemonNumber)
                : undefined;
            const isLastPrinting = more && more.cards.at(-1)?.id === tile.card?.id;
            return (
              <li key={tile.key} className="binder-result">
                <button
                  type="button"
                  className="binder-result-button"
                  aria-label={`Go to ${where}: ${tile.card ? `${tile.card.name} · ${tile.card.setName} · ${tile.card.number}` : tile.note}. ${tile.card ? tile.note : ''}`}
                  onClick={() => onJump(tile.match)}
                >
                  {tile.card ? (
                    <CardFrame
                      card={frameCardFrom(tile.card)}
                      state={tile.faded ? 'unowned' : 'owned'}
                      palette={palette}
                    />
                  ) : (
                    <span className="binder-result-empty">{tile.note}</span>
                  )}
                  <span className="binder-result-caption">
                    <span className="binder-result-where">{where}</span>
                    {tile.card ? <span className="binder-result-note">{tile.note}</span> : null}
                    {isLastPrinting && more.total > more.cards.length ? (
                      <span className="binder-result-note">
                        +{more.total - more.cards.length} more printings
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {offset > 0 || nextOffset !== null ? (
        <div className="binder-results-paging">
          <button
            type="button"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            Previous matches
          </button>
          <button
            type="button"
            disabled={nextOffset === null}
            onClick={() => {
              if (nextOffset !== null) setOffset(nextOffset);
            }}
          >
            More matches
          </button>
        </div>
      ) : null}
    </section>
  );
}
