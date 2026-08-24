import { describe, expect, it } from 'vitest';
import { binderLayoutSchema, cardIdSchema, collectionStateSchema, languageSchema } from './index';

describe('shared wire schemas', () => {
  it('accepts stable card ids and rejects empty ids', () => {
    expect(cardIdSchema.parse('sv1-001')).toBe('sv1-001');
    expect(() => cardIdSchema.parse('')).toThrow();
  });

  it('limits languages to physical catalogue languages', () => {
    expect(languageSchema.parse('en')).toBe('en');
    expect(() => languageSchema.parse('tcgp')).toThrow();
  });

  it('keeps collection quantities non-negative', () => {
    expect(
      collectionStateSchema.parse({
        cardId: 'a',
        quantity: 2,
        notes: null,
        updatedAt: '2026-08-24T00:00:00.000Z',
      }).quantity,
    ).toBe(2);
    expect(() =>
      collectionStateSchema.parse({
        cardId: 'a',
        quantity: -1,
        notes: null,
        updatedAt: '2026-08-24T00:00:00.000Z',
      }),
    ).toThrow();
  });

  it('supports standard and custom binder layouts', () => {
    expect(binderLayoutSchema.parse({ kind: '3x3', rows: 3, columns: 3 }).columns).toBe(3);
    expect(binderLayoutSchema.parse({ kind: 'custom', rows: 5, columns: 4 }).kind).toBe('custom');
  });
});
