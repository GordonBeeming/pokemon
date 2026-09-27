// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest';
import { cardIdSchema } from '@pokedex/shared';
import {
  collectCardsForClipboard,
  copyCards,
  clearCardClipboard,
  readCardClipboard,
} from './card-clipboard';
const search = vi.hoisted(() => vi.fn());
vi.mock('./api', () => ({ api: { search } }));
const card = (id: string) => ({ id: cardIdSchema.parse(id), name: id, setName: 'Set', number: id });
beforeEach(() => {
  localStorage.clear();
  search.mockReset();
});
it('persists a minimal ordered list locally and never copies owned quantities', () => {
  copyCards([card('b'), card('a')]);
  expect(readCardClipboard()?.cards.map((item) => item.id)).toEqual(['b', 'a']);
  expect(JSON.parse(localStorage.getItem('pokedex.binder-card-clipboard.v1') ?? 'null')).toEqual({
    version: 1,
    cards: [card('b'), card('a')],
  });
  clearCardClipboard();
  expect(readCardClipboard()).toBeNull();
});
it('ignores malformed or oversized clipboard values', () => {
  localStorage.setItem('pokedex.binder-card-clipboard.v1', 'bad json');
  expect(readCardClipboard()).toBeNull();
  localStorage.setItem(
    'pokedex.binder-card-clipboard.v1',
    JSON.stringify({ version: 1, cards: [{ id: 'x' }] }),
  );
  expect(readCardClipboard()).toBeNull();
  expect(() => copyCards(Array.from({ length: 2001 }, () => card('a')))).toThrow();
});
it('copies every result page with the applied filters and exact response order', async () => {
  search
    .mockResolvedValueOnce({ cards: [card('b')], total: 2, cursor: 'next' })
    .mockResolvedValueOnce({ cards: [card('a')], total: 2, cursor: null });
  const filters = new URLSearchParams({
    q: 'Squirtle',
    owned: 'false',
    setId: 'set',
    pokedexNumber: '7',
    offset: '50',
    cursor: 'old',
  });
  expect(
    (await collectCardsForClipboard(filters, new AbortController().signal)).map((item) => item.id),
  ).toEqual(['b', 'a']);
  const call = search.mock.calls[0]?.[0] as URLSearchParams;
  expect(call.get('owned')).toBe('false');
  expect(call.get('q')).toBe('Squirtle');
  expect(call.get('offset')).toBeNull();
  expect(filters.get('cursor')).toBe('old');
});
it('refuses changed or looping search pages instead of silently truncating the clipboard', async () => {
  search
    .mockResolvedValueOnce({ cards: [card('a')], total: 2, cursor: 'next' })
    .mockResolvedValueOnce({ cards: [card('a')], total: 2, cursor: null });
  await expect(
    collectCardsForClipboard(new URLSearchParams(), new AbortController().signal),
  ).rejects.toThrow('changed');
  search.mockResolvedValueOnce({ cards: [], total: 2001, cursor: null });
  await expect(
    collectCardsForClipboard(new URLSearchParams(), new AbortController().signal),
  ).rejects.toThrow('2,000');
});
it('requests release-date order for every page without changing the displayed filters', async () => {
  const received: string[] = [];
  search.mockImplementation((params: URLSearchParams) => {
    received.push(params.toString());
    return Promise.resolve(
      params.has('cursor')
        ? { cards: [card('new-owned')], total: 2, cursor: null }
        : { cards: [card('old')], total: 2, cursor: 'next' },
    );
  });
  const filters = new URLSearchParams({ pokedexNumber: '7', language: 'en', owned: 'true' });
  expect(
    (await collectCardsForClipboard(filters, new AbortController().signal, 'release')).map(
      (card) => card.id,
    ),
  ).toEqual(['old', 'new-owned']);
  expect(received).toHaveLength(2);
  for (const text of received) {
    const query = new URLSearchParams(text);
    expect(query.get('sort')).toBe('release');
    expect(query.get('owned')).toBe('true');
    expect(query.get('pokedexNumber')).toBe('7');
  }
  expect(filters.has('sort')).toBe(false);
});
