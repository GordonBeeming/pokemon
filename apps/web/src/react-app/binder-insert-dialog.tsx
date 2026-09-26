import { useEffect, useRef, useState, type ReactElement } from 'react';
import {
  NATIONAL_POKEDEX,
  type BinderEntry,
  type BinderSlotLocation,
  type BinderInsertDestinations,
} from '@pokedex/shared';
import { api, type CatalogueCardView } from './api';
import { PocketPanel } from './binder-pocket-tools';
import { userMessage, type Notice } from './ui';
import { CardArt } from './card-art';

export function BinderInsertDialog({
  versionId,
  revision,
  error,
  at,
  onClose,
  onInsert,
  onNotice,
}: {
  versionId: string;
  revision: number;
  error: string | null;
  at: BinderSlotLocation | null;
  onClose: () => void;
  onInsert: (at: BinderSlotLocation, entries: BinderEntry[], revision: number) => Promise<boolean>;
  onNotice: (notice: Notice) => void;
}): ReactElement {
  const [kind, setKind] = useState<'pokemon' | 'exact-card'>('pokemon');
  const [query, setQuery] = useState('');
  const [cards, setCards] = useState<CatalogueCardView[]>([]);
  const [total, setTotal] = useState(0);
  const [resultOffset, setResultOffset] = useState(0);
  const [selected, setSelected] = useState<Map<string, BinderEntry>>(new Map());
  const [destinations, setDestinations] = useState<BinderInsertDestinations | null>(null);
  const [destinationError, setDestinationError] = useState(false);
  const [pending, setPending] = useState(false);
  const [searched, setSearched] = useState(false);
  const [message, setMessage] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setDestinations(null);
    setDestinationError(false);
    void api
      .binderDestinations(versionId, undefined, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setDestinations(result);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setDestinationError(true);
          setMessage(userMessage(error));
          onNotice({ kind: 'error', message: userMessage(error) });
        }
      });
    return () => controller.abort();
  }, [versionId, revision, onNotice]);
  useEffect(() => () => request.current?.abort(), []);
  const numberQuery = query.trim().match(/^#?0*(\d+)$/u);
  const pokemon = NATIONAL_POKEDEX.filter((item) =>
    numberQuery
      ? item.number === Number(numberQuery[1])
      : `${item.number} ${item.name} ${item.discoveryCategory}`
          .toLocaleLowerCase('en-AU')
          .includes(query.trim().toLocaleLowerCase('en-AU')),
  );
  const destination = at ?? destinations?.appendAt;
  function toggle(key: string, entry: BinderEntry): void {
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(key)) next.delete(key);
      else if (next.size < 1025) next.set(key, entry);
      return next;
    });
  }
  async function search(all = false, offset = 0): Promise<void> {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setMessage('');
    try {
      const first = await api.search(
        new URLSearchParams({ q: query, limit: all ? '100' : '24', offset: String(offset) }),
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setResultOffset(offset);
      setTotal(first.total);
      setSearched(true);
      setCards(all ? first.cards.slice(0, 24) : first.cards);
      if (all) {
        if (first.total > 1025) {
          setMessage('Narrow the search to 1,025 cards or fewer before selecting all results.');
          return;
        }
        const found = [...first.cards];
        let cursor = first.cursor;
        while (cursor) {
          const next = await api.search(
            new URLSearchParams({ q: query, limit: '100', cursor }),
            controller.signal,
          );
          if (
            !next.cards.length ||
            next.cursor === cursor ||
            found.length + next.cards.length > 1025
          ) {
            if (!controller.signal.aborted) setMessage('Catalogue search changed. Search again.');
            return;
          }
          found.push(...next.cards);
          cursor = next.cursor;
        }
        if (!controller.signal.aborted)
          setSelected(
            new Map(
              found.map((card) => [
                card.id,
                { kind: 'exact-card', cardId: card.id, startsNewPage: false },
              ]),
            ),
          );
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setMessage(userMessage(error));
        onNotice({ kind: 'error', message: userMessage(error) });
      }
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  }
  const footer = (
    <>
      {error ? <p role="alert">{error}</p> : null}
      <p role="status">{pending ? 'Working…' : message || `${selected.size} targets selected.`}</p>
      <button
        className="quiet-button tone-accent"
        type="button"
        disabled={pending || selected.size === 0 || !destination || !destinations}
        onClick={() => {
          if (!destination || !destinations) return;
          setPending(true);
          void onInsert(destination, [...selected.values()], destinations.revision)
            .then((success) => {
              if (success) onClose();
            })
            .catch((reason: unknown) => onNotice({ kind: 'error', message: userMessage(reason) }))
            .finally(() => setPending(false));
        }}
      >
        Insert {selected.size || ''} selected {selected.size === 1 ? 'target' : 'targets'}
      </button>
    </>
  );
  return (
    <PocketPanel anchor={at} title="Insert targets" wide footer={footer} onClose={onClose}>
      <p>
        {at
          ? `Insert at page ${at.page + 1}, pocket ${at.row + 1}:${at.column + 1}, shifting later targets.`
          : destinations?.appendAt
            ? `Append at page ${destinations.appendAt.page + 1}, pocket ${destinations.appendAt.row + 1}:${destinations.appendAt.column + 1}.`
            : destinations
              ? destinations.requiredCapacity > destinations.maxCapacity
                ? `This binder has reached its ${destinations.maxCapacity}-pocket limit. Choose an existing empty sleeve or another binder.`
                : `No room at the end. Grow the binder to at least ${destinations.requiredCapacity} pockets in Manage binder.`
              : destinationError
                ? 'Could not load the insertion position. Close and reopen this tool to retry.'
                : 'Finding space at the end of the binder…'}
      </p>
      <div className="binder-header-actions" aria-label="Target type">
        {(['pokemon', 'exact-card'] as const).map((value) => (
          <button
            key={value}
            className="quiet-button"
            type="button"
            aria-pressed={kind === value}
            disabled={pending}
            onClick={() => {
              request.current?.abort();
              setKind(value);
              setQuery('');
              setResultOffset(0);
              setCards([]);
              setSelected(new Map());
              setSearched(false);
              setMessage('');
            }}
          >
            {value === 'pokemon' ? 'Pokémon targets' : 'Exact cards'}
          </button>
        ))}
      </div>
      <form
        className="card-picker"
        onSubmit={(event) => {
          event.preventDefault();
          if (kind === 'exact-card') void search();
        }}
      >
        <label>
          Search targets
          <input
            value={query}
            disabled={pending}
            placeholder={
              kind === 'pokemon' ? 'Name, Pokédex number, or region' : 'Card name, set, or number'
            }
            onChange={(event) => {
              setQuery(event.target.value);
              setResultOffset(0);
              setCards([]);
              setSearched(false);
              setTotal(0);
              setMessage('');
            }}
          />
        </label>
        {kind === 'exact-card' ? (
          <button className="quiet-button" type="submit" disabled={pending}>
            Search cards
          </button>
        ) : null}
      </form>
      <div className="binder-header-actions">
        <button
          className="quiet-button"
          type="button"
          disabled={
            pending ||
            (kind === 'pokemon' ? pokemon.length === 0 : !searched || total === 0 || total > 1025)
          }
          onClick={() => {
            if (kind === 'pokemon')
              setSelected(
                new Map(
                  pokemon.map((item) => [
                    String(item.number),
                    { kind: 'pokemon', pokemonNumber: item.number, startsNewPage: false },
                  ]),
                ),
              );
            else void search(true);
          }}
        >
          Select all {kind === 'pokemon' ? pokemon.length : total} matches
        </button>
        <button
          className="text-button"
          type="button"
          disabled={pending || selected.size === 0}
          onClick={() => setSelected(new Map())}
        >
          Clear selection
        </button>
      </div>
      <div className="binder-insert-results" aria-label="Matching targets">
        {kind === 'pokemon'
          ? pokemon.slice(resultOffset, resultOffset + 40).map((item) => (
              <button
                key={item.number}
                type="button"
                className="quiet-button"
                aria-pressed={selected.has(String(item.number))}
                disabled={pending}
                onClick={() =>
                  toggle(String(item.number), {
                    kind: 'pokemon',
                    pokemonNumber: item.number,
                    startsNewPage: false,
                  })
                }
              >
                #{String(item.number).padStart(4, '0')} {item.name}
                <small>{item.discoveryCategory}</small>
              </button>
            ))
          : cards.map((card) => (
              <button
                key={card.id}
                type="button"
                className="quiet-button"
                aria-pressed={selected.has(card.id)}
                disabled={pending}
                onClick={() =>
                  toggle(card.id, { kind: 'exact-card', cardId: card.id, startsNewPage: false })
                }
              >
                <CardArt src={card.imageLowUrl} highSrc={card.imageHighUrl} alt="" />
                {card.name}
                <small>
                  {card.setName} · {card.number} · {card.language.toUpperCase()}
                </small>
              </button>
            ))}
      </div>
      <nav className="binder-header-actions" aria-label="Search result pages">
        <button
          className="quiet-button"
          type="button"
          disabled={pending || resultOffset === 0}
          onClick={() =>
            kind === 'pokemon'
              ? setResultOffset(Math.max(0, resultOffset - 40))
              : void search(false, Math.max(0, resultOffset - 24))
          }
        >
          Previous results
        </button>
        <span>{kind === 'pokemon' ? pokemon.length : total} matches</span>
        <button
          className="quiet-button"
          type="button"
          disabled={
            pending ||
            resultOffset + (kind === 'pokemon' ? 40 : 24) >=
              (kind === 'pokemon' ? pokemon.length : total)
          }
          onClick={() =>
            kind === 'pokemon'
              ? setResultOffset(resultOffset + 40)
              : void search(false, resultOffset + 24)
          }
        >
          Next results
        </button>
      </nav>
      {kind === 'exact-card' && searched && !cards.length ? <p>No matching cards.</p> : null}
    </PocketPanel>
  );
}
