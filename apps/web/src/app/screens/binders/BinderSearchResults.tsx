import type { BinderSearchMatch, FrameType } from '@pokedex/shared';
import { useState, type ReactElement } from 'react';
import {
  type ResolvedCard,
  useBinderSpaceSearch,
  useResolvedCardGroups,
  useSpeciesPrintings,
} from '../../api/queries/binders';
import { CardFrame, type CardFrameCard } from '../../cards/CardFrame';
import { EmptyState } from '../../ui/EmptyState';
import { CardFrameSkeleton } from '../../ui/Skeleton';
import { anyFrameCard, binderErrorMessage, frameCardFrom } from './model';

const PAGE_SIZE = 50;
/** Printings fetched per Pokémon. The catalogue lists owned printings first for a
 * Pokémon, so this is enough for a few open pockets of one species to each show a
 * different owned copy, or real art to fade when nothing is owned. */
const PRINTINGS = 6;
/** How many Pokémon on one results page look up their printings. A broad query ("a", a
 * region) can match 50 open pockets; past this many, an open pocket shows the faded
 * "any printing" card without the lookup. */
const LOOKED_UP_SPECIES = 12;

/** How strongly a card draws: in this binder at full strength, owned but not in the
 * binder a step back, anything else faded the way the catalogue fades what you lack. */
type Tier = 'binder' | 'owned' | 'missing';

interface Tile {
  key: string;
  match: BinderSearchMatch;
  /** What the tile draws; null for a pocket with no card to show. */
  frame: { card: CardFrameCard; variant: 'card' | 'any'; tier: Tier } | null;
  /** The card's name, set and number, read out with the pocket. */
  title: string;
  note: string;
}

function cardTile(
  key: string,
  match: BinderSearchMatch,
  card: ResolvedCard,
  tier: Tier,
  note: string,
): Tile {
  return {
    key,
    match,
    frame: { card: frameCardFrom(card), variant: 'card', tier },
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
  if (placed) return [cardTile(base, match, placed, 'binder', 'In this binder')];
  const target = match.targetCardId ? cards.get(match.targetCardId) : undefined;
  if (target)
    return [
      owned(target)
        ? cardTile(base, match, target, 'owned', 'Owned · not in this binder')
        : cardTile(base, match, target, 'missing', 'Not owned'),
    ];
  // One tile per pocket. An open "any printing" pocket shows, in order: a printing you
  // own that isn't drawn elsewhere in the results, then real art of one you don't own,
  // then the "any" card when nothing was looked up.
  const species =
    match.kind === 'pokemon' && match.pokemonNumber
      ? printings.get(match.pokemonNumber)
      : undefined;
  const free = species?.cards.filter((card) => !taken.has(card.id)) ?? [];
  const ownedCopy = free.find(owned);
  if (ownedCopy) {
    taken.add(ownedCopy.id);
    return [cardTile(base, match, ownedCopy, 'owned', 'Owned · not in this binder')];
  }
  // Owned printings come first, so a fetched list that reaches an unowned one holds every
  // owned printing; owned copies all being drawn elsewhere is then known, not guessed.
  const otherArt = free.find((card) => !owned(card));
  if (species && otherArt) {
    taken.add(otherArt.id);
    const ownsSome = species.cards.some(owned);
    return [
      cardTile(
        base,
        match,
        otherArt,
        'missing',
        ownsSome ? 'Owned copies shown elsewhere' : 'Not owned',
      ),
    ];
  }
  if (match.kind === 'pokemon' && match.pokemonNumber)
    return [
      {
        key: base,
        match,
        frame: { card: anyFrameCard(match.pokemonNumber), variant: 'any', tier: 'missing' },
        title: match.label,
        // Not looked up, not loaded, or every fetched printing already drawn: nothing
        // certain to say about ownership.
        note: species && species.total === 0 ? 'Not owned' : 'Any printing',
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
  const speciesQueries = useSpeciesPrintings(openSpecies, PRINTINGS);

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
              <li
                key={tile.key}
                className="binder-result"
                data-tier={tile.frame ? tile.frame.tier : undefined}
              >
                <button
                  type="button"
                  className="binder-result-button"
                  aria-label={
                    tile.frame
                      ? `Go to ${where}: ${tile.title}. ${tile.note}`
                      : `Go to ${where}: ${tile.note}`
                  }
                  onClick={() => onJump(tile.match)}
                >
                  {tile.frame ? (
                    <CardFrame
                      card={tile.frame.card}
                      variant={tile.frame.variant}
                      state={tile.frame.tier === 'missing' ? 'unowned' : 'owned'}
                      palette={palette}
                    />
                  ) : (
                    <span className="binder-result-empty">{tile.note}</span>
                  )}
                  <span className="binder-result-caption">
                    <span className="binder-result-where">{where}</span>
                    {tile.frame ? <span className="binder-result-note">{tile.note}</span> : null}
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
