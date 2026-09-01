import { Hono } from 'hono';
import type {
  BinderPokemonShortage,
  BinderReadyToPlace,
  BinderShortage,
  BinderVersionPages,
} from '@pokedex/shared';
import { createArtUploadToken, createArtUploadTokens } from '../../lib/art';
import { listCatalogueSources } from '../../lib/catalogue';
import { asPositiveInt } from '../../lib/db';
import type { AuthVars } from '../../lib/types';
import { apiFailure, parsedJson } from './errors';
import { catalogueFilters, ownerOperations } from './operations';
import {
  bulkUploadRequestBody,
  binderSlotSetRequestSchema,
  binderSlotSwapRequestSchema,
  binderInsertRequestSchema,
  binderCompactRemoveRequestSchema,
  binderOffsetMoveRequestSchema,
  binderAssignRequestSchema,
  binderAssignmentCandidatesQuerySchema,
  binderPageBreakRequestSchema,
  binderReservePageRequestSchema,
  binderCapacityRequestSchema,
  binderFullPokedexRequestSchema,
  collectionIncrementBody,
  collectionNotesBody,
  compatibleCollectionSetBody,
  createBinderBody,
  desktopOwner,
  parseDesktopBearer,
  uploadRequestBody,
} from './contracts';

export const desktopApiRoutes = new Hono<{ Bindings: CloudflareEnv; Variables: AuthVars }>();

export async function loadAllBinderPages(
  load: (offset: number, limit: number) => Promise<BinderVersionPages>,
): Promise<BinderVersionPages['pages']> {
  const firstPages = await load(0, 4);
  const pages = [...firstPages.pages];
  for (let offset = 4; offset < firstPages.version.pageCount; offset += 4) {
    const nextPages = await load(offset, 4);
    pages.push(...nextPages.pages);
  }
  return pages;
}

export async function loadAllBinderShortages(
  load: (
    offset: number,
    limit: number,
  ) => Promise<{
    shortages: BinderShortage[];
    pokemonShortages: BinderPokemonShortage[];
    readyToPlace: BinderReadyToPlace;
    nextOffset: number | null;
  }>,
): Promise<{
  shortages: BinderShortage[];
  pokemonShortages: BinderPokemonShortage[];
  readyToPlace: BinderReadyToPlace;
}> {
  const shortages: BinderShortage[] = [];
  const pokemonShortages: BinderPokemonShortage[] = [];
  let readyToPlace: BinderReadyToPlace = { exactTargets: 0, pokemonTargets: 0 };
  let offset: number | null = 0;
  while (offset !== null) {
    const page = await load(offset, 100);
    shortages.push(...page.shortages);
    pokemonShortages.push(...page.pokemonShortages);
    readyToPlace = page.readyToPlace;
    if (page.nextOffset !== null && page.nextOffset <= offset)
      throw new Error('binder shortage cursor did not advance');
    offset = page.nextOffset;
  }
  return { shortages, pokemonShortages, readyToPlace };
}

export function binderSuggestionEmptySlots(
  pages: BinderVersionPages['pages'],
): Array<BinderVersionPages['pages'][number]['slots'][number] & { page: number }> {
  return pages.flatMap((page) => {
    if (page.kind === 'reserved') return [];
    return page.slots
      .filter(
        (slot) => (slot.entryKind ?? (slot.cardId === null ? 'empty' : 'exact-card')) === 'empty',
      )
      .map((slot) => ({ ...slot, page: page.position }));
  });
}

const requireDesktopBearer = async (
  c: import('hono').Context<{ Bindings: CloudflareEnv; Variables: AuthVars }>,
  next: import('hono').Next,
) => {
  const bearer = parseDesktopBearer(c.req.header('authorization'));
  if (!bearer) return c.json({ ok: false, error: 'desktop_token_invalid' }, 401);
  c.set('desktopBearer', bearer);
  await next();
};
desktopApiRoutes.use('/desktop/art/*', requireDesktopBearer);
desktopApiRoutes.use('/desktop/catalogue/*', requireDesktopBearer);
desktopApiRoutes.use('/desktop/collection/*', requireDesktopBearer);
desktopApiRoutes.use('/desktop/binders*', requireDesktopBearer);

desktopApiRoutes.post('/desktop/art/upload-tokens', async (c) => {
  try {
    const ownerId = await desktopOwner(c, 'art:write');
    const parsed = uploadRequestBody.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const ticket = await createArtUploadToken(
      c.env.DB,
      ownerId,
      parsed.data.cardId,
      parsed.data.variant,
      parsed.data.sha256,
      parsed.data.maxBytes,
    );
    return c.json(
      {
        ok: true,
        token: ticket.token,
        uploadPath: `/api/desktop/art/uploads/${ticket.ticketId}`,
      },
      201,
    );
  } catch (error) {
    return apiFailure(c, error);
  }
});
desktopApiRoutes.post('/desktop/art/upload-tokens/bulk', async (c) => {
  try {
    const ownerId = await desktopOwner(c, 'art:write');
    const parsed = bulkUploadRequestBody.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const tickets = await createArtUploadTokens(c.env.DB, ownerId, parsed.data.uploads);
    const uploads = tickets.map((ticket) => ({
      cardId: ticket.cardId,
      variant: ticket.variant,
      token: ticket.token,
      uploadPath: `/api/desktop/art/uploads/${ticket.ticketId}`,
    }));
    return c.json({ ok: true, uploads }, 201);
  } catch (error) {
    return apiFailure(c, error);
  }
});

desktopApiRoutes.get('/desktop/catalogue/search', async (c) => {
  try {
    const ownerId = await desktopOwner(c, 'catalogue:read');
    return c.json({
      ok: true,
      ...(await ownerOperations(c.env, ownerId).searchCatalogue(
        catalogueFilters(c.req.query(), false),
      )),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});
desktopApiRoutes.get('/desktop/catalogue/sources', async (c) => {
  try {
    await desktopOwner(c, 'catalogue:read');
    const result = await listCatalogueSources(
      c.env.DB,
      c.req.query('cursor') ?? null,
      asPositiveInt(c.req.query('limit'), 5_000, 5_000),
    );
    return c.json({ ok: true, ...result });
  } catch (error) {
    return apiFailure(c, error);
  }
});
desktopApiRoutes.get('/desktop/catalogue/:id', async (c) => {
  try {
    const operations = ownerOperations(c.env, await desktopOwner(c, 'catalogue:read'));
    return c.json({ ok: true, card: await operations.cardDetail(c.req.param('id')) });
  } catch (error) {
    return apiFailure(c, error);
  }
});
desktopApiRoutes.get('/desktop/art/manifest', async (c) => {
  try {
    const operations = ownerOperations(c.env, await desktopOwner(c, 'art:read'));
    return c.json({
      ok: true,
      ...(await operations.artManifest(
        c.req.query('cursor') ?? null,
        asPositiveInt(c.req.query('limit'), 5_000, 5_000),
      )),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});
desktopApiRoutes.get('/desktop/art/:cardId/:variant', async (c) => {
  try {
    const operations = ownerOperations(c.env, await desktopOwner(c, 'art:read'));
    const variant = c.req.param('variant');
    if (variant !== 'high' && variant !== 'low')
      return c.json({ ok: false, error: 'invalid_variant' }, 400);
    const response = await operations.art(c.req.param('cardId'), variant, c.req.raw);
    return response ?? c.json({ ok: false, error: 'art_not_found' }, 404);
  } catch (error) {
    return apiFailure(c, error);
  }
});
desktopApiRoutes.put('/desktop/collection/:cardId', async (c) => {
  try {
    const parsed = compatibleCollectionSetBody.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const ownerId = await desktopOwner(c, 'collection:write');
    return c.json({
      ok: true,
      ...(await ownerOperations(c.env, ownerId).setCollection(c.req.param('cardId'), parsed.data)),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});
desktopApiRoutes.post('/desktop/collection/:cardId/increment', async (c) => {
  try {
    const parsed = collectionIncrementBody.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const result = await ownerOperations(
      c.env,
      await desktopOwner(c, 'collection:write'),
    ).incrementCollection(c.req.param('cardId'), parsed.data);
    return c.json({ ok: true, ...result });
  } catch (error) {
    return apiFailure(c, error);
  }
});
desktopApiRoutes.patch('/desktop/collection/:cardId/notes', async (c) => {
  try {
    const parsed = collectionNotesBody.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const result = await ownerOperations(
      c.env,
      await desktopOwner(c, 'collection:write'),
    ).patchCollectionNotes(c.req.param('cardId'), parsed.data);
    return c.json({ ok: true, ...result });
  } catch (error) {
    return apiFailure(c, error);
  }
});
desktopApiRoutes.get('/desktop/binders', async (c) => {
  try {
    return c.json({
      ok: true,
      binders: await ownerOperations(c.env, await desktopOwner(c, 'binders:write')).listBinders(),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});
desktopApiRoutes.get('/desktop/binders/versions/:id', async (c) => {
  try {
    const page = Math.max(0, Number.parseInt(c.req.query('page') ?? '0', 10) || 0);
    const limit = asPositiveInt(c.req.query('limit'), 1, 4);
    const binder = await ownerOperations(
      c.env,
      await desktopOwner(c, 'binders:write'),
    ).binderVersion(c.req.param('id'), page, limit);
    return c.json({
      ok: true,
      binder,
      ...binder,
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});
desktopApiRoutes.get('/desktop/binders/versions/:id/shortages', async (c) => {
  try {
    const offset = Math.max(0, Number.parseInt(c.req.query('offset') ?? '0', 10) || 0);
    const result = await ownerOperations(
      c.env,
      await desktopOwner(c, 'binders:write'),
    ).binderShortages(c.req.param('id'), offset, asPositiveInt(c.req.query('limit'), 100, 100));
    return c.json({ ok: true, ...result });
  } catch (error) {
    return apiFailure(c, error);
  }
});
desktopApiRoutes.get('/desktop/binders/versions/:id/planner-summary', async (c) => {
  try {
    const operations = ownerOperations(c.env, await desktopOwner(c, 'binders:write'));
    return c.json({ ok: true, summary: await operations.binderPlannerSummary(c.req.param('id')) });
  } catch (error) {
    return apiFailure(c, error);
  }
});
desktopApiRoutes.get('/desktop/binders/versions/:id/assignment-candidates', async (c) => {
  try {
    const parsed = binderAssignmentCandidatesQuerySchema.safeParse({
      page: Number(c.req.query('page')),
      row: Number(c.req.query('row')),
      column: Number(c.req.query('column')),
    });
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_query' }, 400);
    return c.json({
      ok: true,
      ...(await ownerOperations(
        c.env,
        await desktopOwner(c, 'binders:write'),
      ).binderAssignmentCandidates(c.req.param('id'), parsed.data)),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});
desktopApiRoutes.post('/desktop/binders', async (c) => {
  try {
    const parsed = createBinderBody.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    return c.json(
      {
        ok: true,
        binder: await ownerOperations(c.env, await desktopOwner(c, 'binders:write')).createBinder(
          parsed.data.name,
          parsed.data.layout,
          parsed.data.capacity,
        ),
      },
      201,
    );
  } catch (error) {
    return apiFailure(c, error);
  }
});
desktopApiRoutes.put('/desktop/binders/versions/:id/slot', async (c) => {
  try {
    const parsed = binderSlotSetRequestSchema.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    return c.json({
      ok: true,
      binder: await ownerOperations(c.env, await desktopOwner(c, 'binders:write')).setBinderSlot(
        c.req.param('id'),
        parsed.data,
        parsed.data.cardId,
        parsed.data.expectedRevision,
      ),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});
desktopApiRoutes.post('/desktop/binders/versions/:id/swap', async (c) => {
  try {
    const parsed = binderSlotSwapRequestSchema.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    return c.json({
      ok: true,
      binder: await ownerOperations(c.env, await desktopOwner(c, 'binders:write')).swapBinderSlots(
        c.req.param('id'),
        parsed.data.source,
        parsed.data.target,
        parsed.data.expectedRevision,
      ),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});
desktopApiRoutes.get('/desktop/binders/versions/:id/suggest', async (c) => {
  try {
    const operations = ownerOperations(c.env, await desktopOwner(c, 'binders:write'));
    const versionId = c.req.param('id');
    const [pages, planning] = await Promise.all([
      loadAllBinderPages((offset, limit) => operations.binderVersion(versionId, offset, limit)),
      loadAllBinderShortages((offset, limit) =>
        operations.binderShortages(versionId, offset, limit),
      ),
    ]);
    return c.json({
      ok: true,
      ...planning,
      nextOffset: null,
      emptySlots: binderSuggestionEmptySlots(pages),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});

desktopApiRoutes.post('/desktop/binders/versions/:id/entries/insert', async (c) => {
  try {
    const parsed = binderInsertRequestSchema.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const operations = ownerOperations(c.env, await desktopOwner(c, 'binders:write'));
    return c.json({
      ok: true,
      binder: await operations.insertBinderEntries(
        c.req.param('id'),
        parsed.data.at,
        parsed.data.entries,
        parsed.data.expectedRevision,
      ),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});
desktopApiRoutes.post('/desktop/binders/versions/:id/entries/remove', async (c) => {
  try {
    const parsed = binderCompactRemoveRequestSchema.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const operations = ownerOperations(c.env, await desktopOwner(c, 'binders:write'));
    return c.json({
      ok: true,
      binder: await operations.compactRemoveBinderEntry(
        c.req.param('id'),
        parsed.data.at,
        parsed.data.expectedRevision,
      ),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});
desktopApiRoutes.post('/desktop/binders/versions/:id/entries/move', async (c) => {
  try {
    const parsed = binderOffsetMoveRequestSchema.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const operations = ownerOperations(c.env, await desktopOwner(c, 'binders:write'));
    return c.json({
      ok: true,
      binder: await operations.moveBinderEntryByOffset(
        c.req.param('id'),
        parsed.data.from,
        parsed.data.offset,
        parsed.data.expectedRevision,
      ),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});
desktopApiRoutes.put('/desktop/binders/versions/:id/assignment', async (c) => {
  try {
    const parsed = binderAssignRequestSchema.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const operations = ownerOperations(c.env, await desktopOwner(c, 'binders:write'));
    return c.json({
      ok: true,
      binder: await operations.setBinderEntryAssignment(
        c.req.param('id'),
        parsed.data.at,
        parsed.data.cardId,
        parsed.data.expectedRevision,
      ),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});
desktopApiRoutes.put('/desktop/binders/versions/:id/page-break', async (c) => {
  try {
    const parsed = binderPageBreakRequestSchema.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const operations = ownerOperations(c.env, await desktopOwner(c, 'binders:write'));
    return c.json({
      ok: true,
      binder: await operations.setBinderEntryPageBreak(
        c.req.param('id'),
        parsed.data.at,
        parsed.data.startsNewPage,
        parsed.data.expectedRevision,
      ),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});
desktopApiRoutes.put('/desktop/binders/versions/:id/reserved-page', async (c) => {
  try {
    const parsed = binderReservePageRequestSchema.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const operations = ownerOperations(c.env, await desktopOwner(c, 'binders:write'));
    return c.json({
      ok: true,
      binder: await operations.reserveBinderPage(
        c.req.param('id'),
        parsed.data.page,
        parsed.data.reserved,
        parsed.data.label ?? null,
        parsed.data.expectedRevision,
      ),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});
desktopApiRoutes.put('/desktop/binders/versions/:id/capacity', async (c) => {
  try {
    const parsed = binderCapacityRequestSchema.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const operations = ownerOperations(c.env, await desktopOwner(c, 'binders:write'));
    return c.json({
      ok: true,
      binder: await operations.resizeBinderCapacity(
        c.req.param('id'),
        parsed.data.capacity,
        parsed.data.expectedRevision,
      ),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});
desktopApiRoutes.post('/desktop/binders/versions/:id/full-pokedex', async (c) => {
  try {
    const parsed = binderFullPokedexRequestSchema.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const operations = ownerOperations(c.env, await desktopOwner(c, 'binders:write'));
    return c.json({
      ok: true,
      binder: await operations.insertFullPokedex(
        c.req.param('id'),
        parsed.data.at,
        parsed.data.regionPageBreaks,
        parsed.data.expectedRevision,
      ),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});
desktopApiRoutes.post('/desktop/binders/versions/:id/full-pokedex/preview', async (c) => {
  try {
    const parsed = binderFullPokedexRequestSchema.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const operations = ownerOperations(c.env, await desktopOwner(c, 'binders:write'));
    return c.json({
      ok: true,
      preview: await operations.previewFullPokedex(
        c.req.param('id'),
        parsed.data.at,
        parsed.data.regionPageBreaks,
        parsed.data.expectedRevision,
      ),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});
