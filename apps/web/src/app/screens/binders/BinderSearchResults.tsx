import type { BinderSearchMatch, FrameType } from '@pokedex/shared';
import { useState, type ReactElement } from 'react';
import {
  type ResolvedCard,
  useBinderSpaceSearch,
  useResolvedCardGroups,
  useOwnedPrintings,
} from '../../api/queries/binders';
import { CardFrame, type CardFrameCard } from '../../cards/CardFrame';
import { EmptyState } from '../../ui/EmptyState';
import { CardFrameSkeleton } from '../../ui/Skeleton';
import { anyFrameCard, binderErrorMessage, frameCardFrom } from './model';

const PAGE_SIZE = 50;
/** Owned printings fetched per Pokémon: enough for a few open pockets of one species
 * to each show a different copy. */
const OWNED_PRINTINGS = 6;
/** How many Pokémon on one results page look up their owned printings. A broad query
 * ("a", a region) can match 50 open pockets; past this many, an open pocket shows the
 * faded "any printing" card without the lookup. */
const LOOKED_UP_SPECIES = 12;

interface Tile {
  key: string;
  match: BinderSearchMatch;
  /** What the tile draws; null for a pocket with no card to show. */
  frame: { card: CardFrameCard; variant: 'card' | 'any'; faded: boolean } | null;
  /** The card's name, set and number, read out with the pocket. */
  title: string;
  note: string;
  /** "N owned printings" when an open pocket could take more than the one it shows. */
  extra?: string;
}

function cardTile(key: string, match: BinderSearchMatch, card: ResolvedCard, note: string): Tile {
  return {
    key,
    match,
    frame: { card: frameCardFrom(card), variant: 'card', faded: !owned(card) && note !== 'Placed' },
    title: `${card.name} · ${card.setName} · ${card.number}`,
    note,
  };
}

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
  /** Cards already drawn somewhere in the results; an open pocket adds the one it shows. */
  taken: Set<string>,
): Tile[] {
  const base = `${match.page}-${match.row}-${match.column}`;
  const placed = match.assignedCardId ? cards.get(match.assignedCardId) : undefined;
  if (placed) return [cardTile(base, match, placed, 'Placed')];
  const target = match.targetCardId ? cards.get(match.targetCardId) : undefined;
  if (target)
    return [
      cardTile(
        base,
        match,
        target,
        owned(target) ? 'Owned · pocket open' : 'Not owned · pocket open',
      ),
    ];
  // One tile per pocket. An open "any printing" pocket shows a printing you own that
  // isn't drawn elsewhere in the results, at full colour; with none, the faded "any"
  // card below, the same way the catalogue fades what you don't have.
  const owns =
    match.kind === 'pokemon' && match.pokemonNumber
      ? printings.get(match.pokemonNumber)
      : undefined;
  const free = owns?.cards.find((card) => owned(card) && !taken.has(card.id));
  if (free) {
    taken.add(free.id);
    const tile = cardTile(base, match, free, 'Owned · pocket open');
    if (owns && owns.total > 1) tile.extra = `${owns.total} owned printings`;
    return [tile];
  }
  if (match.kind === 'pokemon' && match.pokemonNumber)
    return [
      {
        key: base,
        match,
        frame: { card: anyFrameCard(match.pokemonNumber), variant: 'any', faded: true },
        title: match.label,
        note: !owns
          ? // Not looked up (past the per-page cap) or not loaded: say nothing about ownership.
            'Any printing · pocket open'
          : owns.total === 0
            ? 'Not owned · pocket open'
            : owns.cards.length >= owns.total
              ? 'Owned copies shown elsewhere · pocket open'
              : 'Any printing · pocket open',
      },
    ];
  // Set, group, reserved and empty pockets have no one card to draw, so they stay empty.
  return [{ key: base, match, frame: null, title: match.label, note: match.label }];
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
  const openSpecies = [
    ...new Set(
      matches
        .filter((match) => match.kind === 'pokemon' && !match.placed && match.pokemonNumber)
        .map((match) => match.pokemonNumber as number),
    ),
  ].slice(0, LOOKED_UP_SPECIES);
  const speciesQueries = useOwnedPrintings(openSpecies, OWNED_PRINTINGS);

  const cards = new Map<string, ResolvedCard>();
  for (const query of resolved) for (const card of query.data ?? []) cards.set(card.id, card);
  const printings = new Map<number, { cards: ResolvedCard[]; total: number }>();
  openSpecies.forEach((pokemonNumber, index) => {
    const data = speciesQueries[index]?.data;
    if (data) printings.set(pokemonNumber, { cards: data.cards, total: data.total });
  });

  const loading =
    results.isPending ||
    resolved.some((item) => item.isPending) ||
    speciesQueries.some((item) => item.isPending);
  const taken = new Set(
    matches.flatMap((match) =>
      [match.assignedCardId, match.targetCardId].filter((id): id is string => Boolean(id)),
    ),
  );
  const tiles = matches.flatMap((match) => tilesFor(match, cards, printings, taken));
  // A failed card or printing lookup must not pass for a pocket with nothing in it.
  const failedLookups = [...resolved, ...speciesQueries].filter((item) => item.isError);
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
      {!loading && failedLookups.length > 0 ? (
        <div className="binder-banner binder-banner-warning" role="alert">
          <span>
            Some cards could not be drawn, so their pockets show as empty.{' '}
            {binderErrorMessage(failedLookups[0]?.error)}
          </span>
          <button
            type="button"
            onClick={() => {
              for (const item of failedLookups) void item.refetch();
            }}
          >
            Try again
          </button>
        </div>
      ) : null}
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
            return (
              <li key={tile.key} className="binder-result">
                <button
                  type="button"
                  className="binder-result-button"
                  aria-label={
                    (tile.frame
                      ? `Go to ${where}: ${tile.title}. ${tile.note}`
                      : `Go to ${where}: ${tile.note}`) + (tile.extra ? `. ${tile.extra}` : '')
                  }
                  onClick={() => onJump(tile.match)}
                >
                  {tile.frame ? (
                    <CardFrame
                      card={tile.frame.card}
                      variant={tile.frame.variant}
                      state={tile.frame.faded ? 'unowned' : 'owned'}
                      palette={palette}
                    />
                  ) : (
                    <span className="binder-result-empty">{tile.note}</span>
                  )}
                  <span className="binder-result-caption">
                    <span className="binder-result-where">{where}</span>
                    {tile.frame ? <span className="binder-result-note">{tile.note}</span> : null}
                    {tile.extra ? <span className="binder-result-note">{tile.extra}</span> : null}
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
