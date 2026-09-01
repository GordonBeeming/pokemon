import { describe, expect, it } from 'vitest';
import {
  DESKTOP_SCOPES,
  artUrlSchema,
  apiErrorSchema,
  binderEntrySchema,
  binderFullPokedexPreviewSchema,
  binderPlannerSummarySchema,
  desktopScopeSchema,
  binderLayoutSchema,
  binderMutationResultSchema,
  binderAssignmentCandidatesSchema,
  cardIdSchema,
  collectionIncrementRequestSchema,
  collectionNotesPatchRequestSchema,
  collectionSetRequestSchema,
  collectionStateSchema,
  binderReservePageRequestSchema,
  languageSchema,
  NATIONAL_POKEDEX,
  pokemonDiscoveryCategory,
} from './index';

describe('shared wire schemas', () => {
  it('accepts stable card ids and rejects empty ids', () => {
    expect(cardIdSchema.parse('sv1-001')).toBe('sv1-001');
    expect(() => cardIdSchema.parse('')).toThrow();
  });

  it('limits languages to physical catalogue languages', () => {
    expect(languageSchema.parse('en')).toBe('en');
    expect(() => languageSchema.parse('tcgp')).toThrow();
  });

  it('keeps desktop authorization scopes in one shared contract', () => {
    expect(DESKTOP_SCOPES).toEqual([
      'art:read',
      'art:write',
      'catalogue:read',
      'collection:write',
      'binders:write',
    ]);
    expect(desktopScopeSchema.parse('catalogue:read')).toBe('catalogue:read');
    expect(desktopScopeSchema.safeParse('admin').success).toBe(false);
  });

  it('keeps collection quantities non-negative', () => {
    expect(
      collectionStateSchema.parse({
        cardId: 'a',
        quantity: 2,
        notes: null,
        revision: 1,
        updatedAt: '2026-08-24T00:00:00.000Z',
      }).quantity,
    ).toBe(2);
    expect(() =>
      collectionStateSchema.parse({
        cardId: 'a',
        quantity: -1,
        notes: null,
        revision: 1,
        updatedAt: '2026-08-24T00:00:00.000Z',
      }),
    ).toThrow();
  });

  it('supports standard and custom binder layouts', () => {
    expect(binderLayoutSchema.parse({ kind: '3x3', rows: 3, columns: 3 }).columns).toBe(3);
    expect(binderLayoutSchema.parse({ kind: 'custom', rows: 5, columns: 4 }).kind).toBe('custom');
  });

  it.each([
    [{ kind: '2x2', rows: 2, columns: 2 }, true],
    [{ kind: '3x3', rows: 3, columns: 3 }, true],
    [{ kind: '4x3', rows: 3, columns: 4 }, true],
    [{ kind: 'top-loader', rows: 2, columns: 2 }, true],
    [{ kind: '2x2', rows: 3, columns: 3 }, false],
    [{ kind: '3x3', rows: 2, columns: 2 }, false],
    [{ kind: '4x3', rows: 4, columns: 3 }, false],
    [{ kind: 'top-loader', rows: 1, columns: 1 }, false],
    [{ kind: 'custom', rows: 20, columns: 20 }, true],
    [{ kind: 'custom', rows: 21, columns: 1 }, false],
  ] as const)('enforces binder layout dimensions for %j', (layout, accepted) => {
    expect(binderLayoutSchema.safeParse(layout).success).toBe(accepted);
  });

  it('accepts canonical same-origin and absolute art URLs only', () => {
    expect(artUrlSchema.parse('/api/art/card_123/low')).toBe('/api/art/card_123/low');
    expect(artUrlSchema.parse('/api/art/card%2F123/high')).toBe('/api/art/card%2F123/high');
    expect(artUrlSchema.parse('https://assets.example.test/card.webp')).toBe(
      'https://assets.example.test/card.webp',
    );
    expect(artUrlSchema.safeParse('/api/private/card/high').success).toBe(false);
    expect(artUrlSchema.safeParse('//attacker.example/card/high').success).toBe(false);
    expect(artUrlSchema.safeParse('javascript:alert(1)').success).toBe(false);
  });

  it('requires revision-aware collection mutation contracts', () => {
    const mutationId = 'b45a42d1-7332-4982-9eb3-b45f54fb8a5e';
    expect(
      collectionSetRequestSchema.parse({
        mutationId,
        expectedRevision: 3,
        quantity: 2,
        notes: null,
      }).expectedRevision,
    ).toBe(3);
    expect(collectionIncrementRequestSchema.parse({ mutationId, delta: 1 }).delta).toBe(1);
    expect(
      collectionNotesPatchRequestSchema.parse({ mutationId, expectedRevision: 3, notes: 'Page 1' })
        .notes,
    ).toBe('Page 1');
    expect(
      collectionSetRequestSchema.safeParse({ mutationId, quantity: 2, notes: null }).success,
    ).toBe(false);
  });

  it('bounds binder mutation responses to affected pages', () => {
    const page = {
      id: 'page-1',
      position: 0,
      slots: [{ pageId: 'page-1', row: 0, column: 0, cardId: null }],
    };
    const result = {
      version: {
        id: 'version-1',
        binderId: 'binder-1',
        versionNumber: 1,
        status: 'draft',
        layout: { kind: '2x2', rows: 2, columns: 2 },
        revision: 2,
        pageCount: 1,
      },
      pages: [page],
    };
    expect(binderMutationResultSchema.parse(result).pages).toHaveLength(1);
    expect(
      binderMutationResultSchema.safeParse({ ...result, pages: [page, page, page] }).success,
    ).toBe(false);
  });

  it('strictly validates assignment candidate availability', () => {
    const candidate = {
      cardId: 'sv1-001',
      name: 'Bulbasaur',
      setName: 'Base',
      number: '1',
      language: 'en',
      owned: 2,
      assigned: 1,
      available: 1,
    };
    expect(binderAssignmentCandidatesSchema.parse({ candidates: [candidate] }).candidates).toEqual([
      candidate,
    ]);
    expect(
      binderAssignmentCandidatesSchema.safeParse({ candidates: [{ ...candidate, ignored: true }] })
        .success,
    ).toBe(false);
  });

  it('keeps optional reserved labels and structured error details on the wire', () => {
    expect(binderEntrySchema.parse({ kind: 'reserved' })).toEqual({ kind: 'reserved' });
    expect(binderEntrySchema.parse({ kind: 'reserved', label: null })).toEqual({
      kind: 'reserved',
      label: null,
    });
    expect(binderEntrySchema.safeParse({ kind: 'reserved', label: '   ' }).success).toBe(false);
    expect(
      binderReservePageRequestSchema.parse({
        expectedRevision: 1,
        page: 0,
        reserved: true,
      }).label,
    ).toBeUndefined();
    expect(
      apiErrorSchema.parse({
        ok: false,
        error: 'binder_capacity_exceeded',
        details: {
          currentCapacity: 9,
          requiredCapacity: 18,
          additionalPockets: 9,
          pageIncrement: 9,
        },
      }).details,
    ).toMatchObject({ requiredCapacity: 18 });
    expect(
      apiErrorSchema.safeParse({
        ok: false,
        error: 'collection_quantity_below_active_assignments',
        details: {
          activeAssignments: [
            { binderId: 'binder-1', versionId: 'version-1', page: 0, row: 0, column: 0 },
          ],
        },
      }).success,
    ).toBe(true);
  });

  it('strictly validates planner summary and full-Pokedex preview responses', () => {
    expect(
      binderPlannerSummarySchema.parse({
        pageIds: ['page-1'],
        revision: 3,
        targets: 4,
        placed: 2,
        reservedSleeves: 1,
        reservedPages: 1,
        generatedPadding: 0,
        available: 12,
        capacity: 18,
        pageSize: 9,
      }).pageIds,
    ).toEqual(['page-1']);
    expect(
      binderPlannerSummarySchema.safeParse({
        pageIds: ['page-1'],
        revision: 3,
        targets: 4,
        placed: 2,
        reservedSleeves: 1,
        reservedPages: 1,
        generatedPadding: 0,
        available: -1,
        capacity: 18,
        pageSize: 9,
      }).success,
    ).toBe(false);
    expect(
      binderFullPokedexPreviewSchema.parse({
        currentCapacity: 18,
        requiredCapacity: 36,
        additionalPockets: 18,
        pageIncrement: 9,
        generatedPadding: 3,
      }).requiredCapacity,
    ).toBe(36);
    expect(
      binderFullPokedexPreviewSchema.safeParse({
        currentCapacity: 18,
        requiredCapacity: 36,
        additionalPockets: 18,
        pageIncrement: 9,
        generatedPadding: 3,
        ignored: true,
      }).success,
    ).toBe(false);
  });
});

describe('National Pokedex registry', () => {
  it('contains every named species exactly once in National order', () => {
    expect(NATIONAL_POKEDEX).toHaveLength(1025);
    expect(NATIONAL_POKEDEX.map((entry) => entry.number)).toEqual(
      Array.from({ length: 1025 }, (_unused, index) => index + 1),
    );
    expect(new Set(NATIONAL_POKEDEX.map((entry) => entry.name)).size).toBe(1025);
  });

  it('uses discovery categories, including Hisui and the Alolan Meltan family', () => {
    expect(pokemonDiscoveryCategory(151)).toBe('Kanto');
    expect(pokemonDiscoveryCategory(899)).toBe('Hisui');
    expect(pokemonDiscoveryCategory(905)).toBe('Hisui');
    expect(pokemonDiscoveryCategory(906)).toBe('Paldea');
    expect(NATIONAL_POKEDEX[807]?.name).toBe('Meltan');
    expect(NATIONAL_POKEDEX[807]?.discoveryCategory).toBe('Alola');
    expect(NATIONAL_POKEDEX[808]?.name).toBe('Melmetal');
    expect(NATIONAL_POKEDEX[808]?.discoveryCategory).toBe('Alola');
  });
});
