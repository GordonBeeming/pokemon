import { Hono } from 'hono';
import { z } from 'zod';
import { languageSchema } from '@pokedex/shared';
import { activeBinderShortages } from '../../lib/binders';
import { getTcgdexPreviewArtResponse } from '../../lib/art';
import {
  applyStagedCatalogueRun,
  beginStagedCatalogueRun,
  createCustomCard,
  listNationalPokedexCoverage,
  resolveCatalogueCards,
  listSetFacets,
  listSpeciesFacets,
  setNationalPokedexRepresentative,
  setNationalRepresentativesFromSources,
  stageCatalogueCards,
  importCatalogueLanguage,
} from '../../lib/catalogue';
import { cachedTcgdexSpeciesPreviews, discoverTcgdexSpecies } from '../../lib/tcgdex-discovery';
import { collectionSummary } from '../../lib/collection';
import { asPositiveInt } from '../../lib/db';
import { requireSession } from '../../lib/guards';
import { logAudit } from '../../lib/auth';
import { ApplicationError } from '../../lib/log';
import { priceCoverage } from '../../lib/pricing';
import { createPairCode, listDesktopTokens, revokeDesktopToken } from '../../lib/desktop-auth';
import type { AuthVars } from '../../lib/types';
import { apiFailure, parsedJson } from './errors';
import { catalogueFilters, ownerOperations } from './operations';
import {
  arrangementBody,
  BACKUP_CREATE_WINDOW_SECONDS,
  binderRevisionRequestSchema,
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
  customCardBody,
  pageOrderBody,
  pairBody,
  sessionOwner,
  syncBody,
  syncFinalizeBody,
  syncPageBody,
  syncRunBody,
} from './contracts';

export const browserApiRoutes = new Hono<{ Bindings: CloudflareEnv; Variables: AuthVars }>();

const nationalDiscoveryBody = z
  .object({ number: z.number().int().min(1).max(1025), name: z.string().trim().min(1).max(120) })
  .strict();
const nationalRepresentativeBody = z.object({ cardId: z.string().trim().min(1).max(128) }).strict();
const nationalRepresentativeSourcesBody = z
  .object({
    choices: z
      .array(
        z
          .object({
            number: z.number().int().min(1).max(1025),
            name: z.string().trim().min(1).max(120),
            sourceId: z.string().trim().min(1).max(256),
          })
          .strict(),
      )
      .min(1)
      .max(1025),
  })
  .strict();
const nationalPreviewsBody = z
  .object({ names: z.array(z.string().trim().min(1).max(120)).min(1).max(1025) })
  .strict();
const resolveCardsBody = z
  .object({ cardIds: z.array(z.string().trim().min(1).max(128)).max(200) })
  .strict();
const binderCardsBody = z
  .object({
    cardIds: z.array(z.string().trim().min(1).max(128)).min(1).max(2000),
    expectedRevision: z.number().int().positive(),
  })
  .strict();
const binderCardAssignmentsBody = z
  .object({
    assignments: z
      .array(
        z
          .object({
            page: z.number().int().nonnegative(),
            row: z.number().int().nonnegative(),
            column: z.number().int().nonnegative(),
            cardId: z.string().trim().min(1).max(128),
          })
          .strict(),
      )
      .min(1)
      .max(2000),
    expectedRevision: z.number().int().positive(),
  })
  .strict();

browserApiRoutes.use('/dashboard*', requireSession);
browserApiRoutes.use('/catalogue*', requireSession);
browserApiRoutes.use('/collection*', requireSession);
browserApiRoutes.use('/binders*', requireSession);
browserApiRoutes.use('/backups*', requireSession);
browserApiRoutes.use('/desktop/pair', requireSession);
browserApiRoutes.use('/desktop/tokens*', requireSession);
browserApiRoutes.use('/art*', requireSession);

browserApiRoutes.get('/dashboard', async (c) => {
  try {
    const ownerId = sessionOwner(c);
    const [collection, pricing, binders, activeBinderTargets, ownedCards] = await Promise.all([
      collectionSummary(c.env.DB, ownerId),
      priceCoverage(c.env.DB, ownerId),
      ownerOperations(c.env, ownerId).listBinders(),
      activeBinderShortages(c.env.DB, ownerId),
      ownerOperations(c.env, ownerId).searchCatalogue({
        owned: true,
        limit: 8,
        offset: 0,
        cursor: null,
      }),
    ]);
    return c.json({
      ok: true,
      collection,
      pricing,
      binderCount: binders.length,
      activeShortages: activeBinderTargets.shortages,
      activePokemonShortages: activeBinderTargets.pokemonShortages,
      cards: ownedCards.cards,
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});

browserApiRoutes.get('/catalogue/search', async (c) => {
  try {
    const result = await ownerOperations(c.env, sessionOwner(c)).searchCatalogue(
      catalogueFilters(c.req.query(), true),
    );
    return c.json({ ok: true, ...result });
  } catch (error) {
    return apiFailure(c, error);
  }
});

browserApiRoutes.post('/catalogue/cards/resolve', async (c) => {
  try {
    const parsed = resolveCardsBody.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    return c.json({
      ok: true,
      cards: await resolveCatalogueCards(c.env.DB, sessionOwner(c), parsed.data.cardIds),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});

browserApiRoutes.get('/catalogue/national', async (c) => {
  try {
    return c.json({
      ok: true,
      entries: await listNationalPokedexCoverage(c.env.DB, sessionOwner(c)),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});

browserApiRoutes.post('/catalogue/national/previews', async (c) => {
  try {
    const rate = await c.env.AUTH_COORDINATOR.getByName(`catalogue:${sessionOwner(c)}`).rateLimit(
      'national-previews',
      30,
      60,
      Math.floor(Date.now() / 1000),
    );
    if (!rate.allowed) {
      c.header('retry-after', String(rate.retryAfter));
      return c.json({ ok: false, error: 'rate_limited' }, 429);
    }
    const parsed = nationalPreviewsBody.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success || new Set(parsed.data.names).size !== parsed.data.names.length)
      return c.json({ ok: false, error: 'invalid_body' }, 400);
    const previews = await cachedTcgdexSpeciesPreviews(c.env.ART, parsed.data.names);
    return c.json({
      ok: true,
      previews: previews.map((preview) => ({
        name: preview.name,
        sourceId: preview.sourceId,
        imageLowUrl: `/api/art/preview/low?${new URLSearchParams({ source: preview.imageBase })}`,
        imageHighUrl: `/api/art/preview/high?${new URLSearchParams({ source: preview.imageBase })}`,
      })),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});

browserApiRoutes.post('/catalogue/national/discover', async (c) => {
  try {
    const rate = await c.env.AUTH_COORDINATOR.getByName(`catalogue:${sessionOwner(c)}`).rateLimit(
      'species-discovery',
      60,
      60 * 60,
      Math.floor(Date.now() / 1000),
    );
    if (!rate.allowed) {
      c.header('retry-after', String(rate.retryAfter));
      return c.json({ ok: false, error: 'rate_limited' }, 429);
    }
    const parsed = nationalDiscoveryBody.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const result = await discoverTcgdexSpecies(c.env.DB, parsed.data.name, parsed.data.number);
    await logAudit(c.env.DB, {
      actor: sessionOwner(c),
      action: 'catalogue.species_discover',
      target: String(parsed.data.number),
      meta: { name: parsed.data.name, imported: result.imported },
    });
    return c.json({ ok: true, ...result });
  } catch (error) {
    return apiFailure(c, error);
  }
});
browserApiRoutes.post('/catalogue/full-sync', async (c) => {
  try {
    const running = await c.env.DB.prepare(
      `SELECT id FROM sync_runs
       WHERE provider = 'tcgdex' AND language = 'en' AND complete_source = 1
         AND status = 'running'
       ORDER BY started_at DESC LIMIT 1`,
    ).first<{ id: string }>();
    if (running) return c.json({ ok: true, workflowId: running.id.replace(/^sync_/u, '') }, 202);
    const ownerId = sessionOwner(c);
    const rate = await c.env.AUTH_COORDINATOR.getByName(`catalogue:${ownerId}`).rateLimit(
      'full-sync',
      2,
      24 * 60 * 60,
      Math.floor(Date.now() / 1000),
    );
    if (!rate.allowed) {
      c.header('retry-after', String(rate.retryAfter));
      return c.json({ ok: false, error: 'rate_limited' }, 429);
    }
    const workflow = await c.env.CATALOGUE_SYNC.create({
      id: `catalogue-${crypto.randomUUID()}`,
      params: { language: 'en', actorId: ownerId, requestId: c.get('requestId') },
    });
    await logAudit(c.env.DB, {
      actor: ownerId,
      action: 'catalogue.full_sync_started',
      target: workflow.id,
      meta: { language: 'en', requestId: c.get('requestId') },
    });
    return c.json({ ok: true, workflowId: workflow.id }, 202);
  } catch (error) {
    return apiFailure(c, error);
  }
});
browserApiRoutes.get('/catalogue/full-sync/:id', async (c) => {
  try {
    const workflow = await c.env.CATALOGUE_SYNC.get(c.req.param('id'));
    const status = await workflow.status();
    if (status.status === 'errored' || status.status === 'terminated')
      return c.json({ ok: false, error: 'catalogue_sync_failed' }, 503);
    return c.json({ ok: true, status: status.status }, status.status === 'complete' ? 200 : 202);
  } catch (error) {
    return apiFailure(c, error);
  }
});
browserApiRoutes.post('/catalogue/national/representatives', async (c) => {
  try {
    const parsed = nationalRepresentativeSourcesBody.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const representatives = await setNationalRepresentativesFromSources(
      c.env.DB,
      sessionOwner(c),
      parsed.data.choices,
    );
    await logAudit(c.env.DB, {
      actor: sessionOwner(c),
      action: 'catalogue.representatives_set',
      target: 'national-pokedex',
      meta: { count: representatives.length },
    });
    return c.json({
      ok: true,
      representatives,
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});

browserApiRoutes.put('/catalogue/national/:number/representative', async (c) => {
  try {
    const number = Number.parseInt(c.req.param('number'), 10);
    const parsed = nationalRepresentativeBody.safeParse(await parsedJson(c.req.raw));
    if (!Number.isInteger(number) || number < 1 || number > 1025 || !parsed.success)
      return c.json({ ok: false, error: 'invalid_body' }, 400);
    await setNationalPokedexRepresentative(c.env.DB, sessionOwner(c), number, parsed.data.cardId);
    return c.json({ ok: true });
  } catch (error) {
    return apiFailure(c, error);
  }
});

browserApiRoutes.get('/catalogue/:id', async (c) => {
  try {
    const operations = ownerOperations(c.env, sessionOwner(c));
    return c.json({ ok: true, card: await operations.cardDetail(c.req.param('id')) });
  } catch (error) {
    return apiFailure(c, error);
  }
});

browserApiRoutes.get('/catalogue/facets/sets', async (c) => {
  const parsed = c.req.query('language')
    ? languageSchema.safeParse(c.req.query('language'))
    : undefined;
  if (parsed && !parsed.success) return c.json({ ok: false, error: 'invalid_filter' }, 400);
  try {
    return c.json({
      ok: true,
      sets: await listSetFacets(
        c.env.DB,
        sessionOwner(c),
        parsed?.success ? parsed.data : undefined,
      ),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});
browserApiRoutes.get('/catalogue/facets/species', async (c) => {
  const parsed = c.req.query('language')
    ? languageSchema.safeParse(c.req.query('language'))
    : undefined;
  if (parsed && !parsed.success) return c.json({ ok: false, error: 'invalid_filter' }, 400);
  try {
    return c.json({
      ok: true,
      species: await listSpeciesFacets(
        c.env.DB,
        sessionOwner(c),
        parsed?.success ? parsed.data : undefined,
      ),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});

browserApiRoutes.post('/catalogue/sync', async (c) => {
  try {
    const parsed = syncBody.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    if (parsed.data.cards.some((card) => card.language !== parsed.data.language))
      return c.json({ ok: false, error: 'language_mismatch' }, 400);
    const result = await importCatalogueLanguage(c.env.DB, parsed.data);
    await logAudit(c.env.DB, {
      actor: sessionOwner(c),
      action: 'catalogue.sync',
      target: result.runId,
      meta: {
        language: parsed.data.language,
        imported: result.imported,
        inactive: result.inactive,
      },
    });
    return c.json({ ok: true, ...result }, 201);
  } catch (error) {
    return apiFailure(c, error);
  }
});
browserApiRoutes.post('/catalogue/sync/runs', async (c) => {
  try {
    const parsed = syncRunBody.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    return c.json(
      { ok: true, runId: await beginStagedCatalogueRun(c.env.DB, parsed.data.language) },
      201,
    );
  } catch (error) {
    return apiFailure(c, error);
  }
});
browserApiRoutes.post('/catalogue/sync/runs/:id/cards', async (c) => {
  try {
    const parsed = syncPageBody.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    await stageCatalogueCards(c.env.DB, c.req.param('id'), parsed.data.cards);
    return c.json({ ok: true, accepted: parsed.data.cards.length });
  } catch (error) {
    return apiFailure(c, error);
  }
});
browserApiRoutes.post('/catalogue/sync/runs/:id/finalize', async (c) => {
  try {
    const parsed = syncFinalizeBody.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    return c.json({
      ok: true,
      ...(await applyStagedCatalogueRun(
        c.env.DB,
        c.req.param('id'),
        parsed.data.allowDestructiveDrop ?? false,
      )),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});
browserApiRoutes.post('/catalogue/custom', async (c) => {
  try {
    const parsed = customCardBody.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const id = await createCustomCard(c.env.DB, parsed.data);
    await logAudit(c.env.DB, {
      actor: sessionOwner(c),
      action: 'catalogue.custom.create',
      target: id,
    });
    return c.json({ ok: true, id }, 201);
  } catch (error) {
    return apiFailure(c, error);
  }
});

browserApiRoutes.put('/collection/:cardId', async (c) => {
  try {
    const parsed = compatibleCollectionSetBody.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const ownerId = sessionOwner(c);
    const result = await ownerOperations(c.env, ownerId).setCollection(
      c.req.param('cardId'),
      parsed.data,
    );
    await logAudit(c.env.DB, {
      actor: ownerId,
      action: 'collection.set',
      target: c.req.param('cardId'),
      meta: { quantity: result.state.quantity, replayed: result.replayed },
    });
    return c.json({ ok: true, ...result });
  } catch (error) {
    return apiFailure(c, error);
  }
});
browserApiRoutes.post('/collection/:cardId/increment', async (c) => {
  try {
    const parsed = collectionIncrementBody.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const result = await ownerOperations(c.env, sessionOwner(c)).incrementCollection(
      c.req.param('cardId'),
      parsed.data,
    );
    return c.json({ ok: true, ...result });
  } catch (error) {
    return apiFailure(c, error);
  }
});
browserApiRoutes.patch('/collection/:cardId/notes', async (c) => {
  try {
    const parsed = collectionNotesBody.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const result = await ownerOperations(c.env, sessionOwner(c)).patchCollectionNotes(
      c.req.param('cardId'),
      parsed.data,
    );
    return c.json({ ok: true, ...result });
  } catch (error) {
    return apiFailure(c, error);
  }
});

browserApiRoutes.get('/binders', async (c) => {
  try {
    return c.json({
      ok: true,
      binders: await ownerOperations(c.env, sessionOwner(c)).listBinders(),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});
browserApiRoutes.post('/binders', async (c) => {
  try {
    const parsed = createBinderBody.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    return c.json(
      {
        ok: true,
        binder: await ownerOperations(c.env, sessionOwner(c)).createBinder(
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
browserApiRoutes.post('/binders/versions/:id/cards', async (c) => {
  try {
    const parsed = binderCardsBody.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const result = await ownerOperations(c.env, sessionOwner(c)).addCardsToBinderVersion(
      c.req.param('id'),
      parsed.data.cardIds,
      parsed.data.expectedRevision,
    );
    return c.json({ ok: true, ...result });
  } catch (error) {
    return apiFailure(c, error);
  }
});
browserApiRoutes.put('/binders/versions/:id/cards', async (c) => {
  try {
    const parsed = binderCardAssignmentsBody.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    return c.json({
      ok: true,
      binder: await ownerOperations(c.env, sessionOwner(c)).setBinderSlots(
        c.req.param('id'),
        parsed.data.assignments,
        parsed.data.expectedRevision,
      ),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});
browserApiRoutes.get('/binders/versions/:id', async (c) => {
  try {
    const result = await ownerOperations(c.env, sessionOwner(c)).binderVersion(
      c.req.param('id'),
      Math.max(0, Number.parseInt(c.req.query('page') ?? '0', 10) || 0),
      asPositiveInt(c.req.query('limit'), 1, 4),
    );
    return c.json({
      ok: true,
      binder: result,
      ...result,
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});
browserApiRoutes.get('/binders/versions/:id/shortages', async (c) => {
  try {
    return c.json({
      ok: true,
      ...(await ownerOperations(c.env, sessionOwner(c)).binderShortages(
        c.req.param('id'),
        Math.max(0, Number.parseInt(c.req.query('offset') ?? '0', 10) || 0),
        asPositiveInt(c.req.query('limit'), 100, 100),
      )),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});
browserApiRoutes.get('/binders/versions/:id/planner-summary', async (c) => {
  try {
    return c.json({
      ok: true,
      summary: await ownerOperations(c.env, sessionOwner(c)).binderPlannerSummary(
        c.req.param('id'),
      ),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});
browserApiRoutes.get('/binders/versions/:id/assignment-candidates', async (c) => {
  try {
    const parsed = binderAssignmentCandidatesQuerySchema.safeParse({
      page: Number(c.req.query('page')),
      row: Number(c.req.query('row')),
      column: Number(c.req.query('column')),
    });
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_query' }, 400);
    return c.json({
      ok: true,
      ...(await ownerOperations(c.env, sessionOwner(c)).binderAssignmentCandidates(
        c.req.param('id'),
        parsed.data,
      )),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});
browserApiRoutes.post('/binders/versions/:id/clone', async (c) => {
  try {
    const parsed = binderRevisionRequestSchema.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    return c.json(
      {
        ok: true,
        binder: await ownerOperations(c.env, sessionOwner(c)).cloneBinderVersion(
          c.req.param('id'),
          parsed.data.expectedRevision,
        ),
      },
      201,
    );
  } catch (error) {
    return apiFailure(c, error);
  }
});
browserApiRoutes.post('/binders/versions/:id/activate', async (c) => {
  try {
    const parsed = binderRevisionRequestSchema.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    return c.json({
      ok: true,
      binder: await ownerOperations(c.env, sessionOwner(c)).activateBinderVersion(
        c.req.param('id'),
        parsed.data.expectedRevision,
      ),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});
browserApiRoutes.put('/binders/versions/:id/slot', async (c) => {
  try {
    const parsed = binderSlotSetRequestSchema.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    return c.json({
      ok: true,
      binder: await ownerOperations(c.env, sessionOwner(c)).setBinderSlot(
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
browserApiRoutes.post('/binders/versions/:id/swap', async (c) => {
  try {
    const parsed = binderSlotSwapRequestSchema.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    return c.json({
      ok: true,
      binder: await ownerOperations(c.env, sessionOwner(c)).swapBinderSlots(
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
browserApiRoutes.post('/binders/versions/:id/arrange', async (c) => {
  try {
    const parsed = arrangementBody.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    return c.json({
      ok: true,
      binder: await ownerOperations(c.env, sessionOwner(c)).arrangeBinderVersion(
        c.req.param('id'),
        parsed.data.mode,
        parsed.data.expectedRevision,
      ),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});
browserApiRoutes.post('/binders/versions/:id/pages', async (c) => {
  try {
    const parsed = binderRevisionRequestSchema.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    return c.json(
      {
        ok: true,
        binder: await ownerOperations(c.env, sessionOwner(c)).addBinderPage(
          c.req.param('id'),
          parsed.data.expectedRevision,
        ),
      },
      201,
    );
  } catch (error) {
    return apiFailure(c, error);
  }
});
browserApiRoutes.delete('/binders/versions/:id/pages/:pageId', async (c) => {
  try {
    const parsed = binderRevisionRequestSchema.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    return c.json({
      ok: true,
      binder: await ownerOperations(c.env, sessionOwner(c)).deleteBinderPage(
        c.req.param('id'),
        c.req.param('pageId'),
        parsed.data.expectedRevision,
      ),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});
browserApiRoutes.put('/binders/versions/:id/pages/order', async (c) => {
  try {
    const parsed = pageOrderBody.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    return c.json({
      ok: true,
      binder: await ownerOperations(c.env, sessionOwner(c)).reorderBinderPages(
        c.req.param('id'),
        parsed.data.pageIds,
        parsed.data.expectedRevision,
      ),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});

browserApiRoutes.post('/binders/versions/:id/entries/insert', async (c) => {
  try {
    const parsed = binderInsertRequestSchema.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    return c.json({
      ok: true,
      binder: await ownerOperations(c.env, sessionOwner(c)).insertBinderEntries(
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
browserApiRoutes.post('/binders/versions/:id/entries/remove', async (c) => {
  try {
    const parsed = binderCompactRemoveRequestSchema.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    return c.json({
      ok: true,
      binder: await ownerOperations(c.env, sessionOwner(c)).compactRemoveBinderEntry(
        c.req.param('id'),
        parsed.data.at,
        parsed.data.expectedRevision,
      ),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});
browserApiRoutes.post('/binders/versions/:id/entries/move', async (c) => {
  try {
    const parsed = binderOffsetMoveRequestSchema.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    return c.json({
      ok: true,
      binder: await ownerOperations(c.env, sessionOwner(c)).moveBinderEntryByOffset(
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
browserApiRoutes.put('/binders/versions/:id/assignment', async (c) => {
  try {
    const parsed = binderAssignRequestSchema.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    return c.json({
      ok: true,
      binder: await ownerOperations(c.env, sessionOwner(c)).setBinderEntryAssignment(
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
browserApiRoutes.put('/binders/versions/:id/page-break', async (c) => {
  try {
    const parsed = binderPageBreakRequestSchema.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    return c.json({
      ok: true,
      binder: await ownerOperations(c.env, sessionOwner(c)).setBinderEntryPageBreak(
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
browserApiRoutes.put('/binders/versions/:id/reserved-page', async (c) => {
  try {
    const parsed = binderReservePageRequestSchema.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    return c.json({
      ok: true,
      binder: await ownerOperations(c.env, sessionOwner(c)).reserveBinderPage(
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
browserApiRoutes.put('/binders/versions/:id/capacity', async (c) => {
  try {
    const parsed = binderCapacityRequestSchema.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    return c.json({
      ok: true,
      binder: await ownerOperations(c.env, sessionOwner(c)).resizeBinderCapacity(
        c.req.param('id'),
        parsed.data.capacity,
        parsed.data.expectedRevision,
      ),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});
browserApiRoutes.post('/binders/versions/:id/full-pokedex', async (c) => {
  try {
    const parsed = binderFullPokedexRequestSchema.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    return c.json({
      ok: true,
      binder: await ownerOperations(c.env, sessionOwner(c)).insertFullPokedex(
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
browserApiRoutes.post('/binders/versions/:id/full-pokedex/preview', async (c) => {
  try {
    const parsed = binderFullPokedexRequestSchema.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    return c.json({
      ok: true,
      preview: await ownerOperations(c.env, sessionOwner(c)).previewFullPokedex(
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

browserApiRoutes.post('/backups', async (c) => {
  try {
    const ownerId = sessionOwner(c);
    const rate = await c.env.AUTH_COORDINATOR.getByName(`backup:${ownerId}`).rateLimit(
      'create',
      1,
      BACKUP_CREATE_WINDOW_SECONDS,
      Math.floor(Date.now() / 1000),
    );
    if (!rate.allowed) {
      c.header('retry-after', String(rate.retryAfter));
      return c.json({ ok: false, error: 'rate_limited', requestId: c.get('requestId') }, 429);
    }
    const workflow = await c.env.BACKUP.create({
      id: `backup-${crypto.randomUUID()}`,
      params: { ownerId, operation: 'create' },
    });
    return c.json({ ok: true, workflowId: workflow.id }, 202);
  } catch (error) {
    return apiFailure(c, error);
  }
});
browserApiRoutes.get('/backups/workflows/:id', async (c) => {
  try {
    const workflow = await c.env.BACKUP.get(c.req.param('id'));
    const status = await workflow.status();
    if (status.status === 'complete') {
      const output = z
        .union([
          z
            .object({ id: z.string().min(1), checksum: z.string().regex(/^[a-f0-9]{64}$/u) })
            .strict(),
          z.object({ restored: z.literal(true), backupId: z.string().min(1) }).strict(),
        ])
        .safeParse(status.output);
      if (!output.success) throw new ApplicationError('backup_workflow_output_invalid', 500);
      return c.json({ ok: true, status: status.status, ...output.data });
    }
    if (status.status === 'errored' || status.status === 'terminated')
      return c.json({ ok: false, error: 'backup_failed', requestId: c.get('requestId') }, 503);
    return c.json({ ok: true, status: status.status }, 202);
  } catch (error) {
    return apiFailure(c, error);
  }
});
browserApiRoutes.post('/backups/:id/restore', async (c) => {
  try {
    const ownerId = sessionOwner(c);
    const backupId = c.req.param('id');
    const workflow = await c.env.BACKUP.create({
      id: `restore-${crypto.randomUUID()}`,
      params: { ownerId, operation: 'restore', backupId },
    });
    return c.json({ ok: true, workflowId: workflow.id }, 202);
  } catch (error) {
    return apiFailure(c, error);
  }
});
browserApiRoutes.post('/desktop/pair', async (c) => {
  try {
    const parsed = pairBody.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    return c.json(
      { ok: true, code: await createPairCode(c.env.DB, sessionOwner(c), parsed.data.scopes) },
      201,
    );
  } catch (error) {
    return apiFailure(c, error);
  }
});
browserApiRoutes.get('/desktop/tokens', async (c) => {
  try {
    return c.json({ ok: true, tokens: await listDesktopTokens(c.env.DB, sessionOwner(c)) });
  } catch (error) {
    return apiFailure(c, error);
  }
});
browserApiRoutes.delete('/desktop/tokens/:id', async (c) => {
  try {
    const revoked = await revokeDesktopToken(c.env.DB, sessionOwner(c), c.req.param('id'));
    return revoked
      ? c.json({ ok: true })
      : c.json({ ok: false, error: 'desktop_token_not_found' }, 404);
  } catch (error) {
    return apiFailure(c, error);
  }
});
browserApiRoutes.get('/art/manifest', async (c) => {
  try {
    const operations = ownerOperations(c.env, sessionOwner(c));
    return c.json({
      ok: true,
      ...(await operations.artManifest(
        c.req.query('cursor') ?? null,
        asPositiveInt(c.req.query('limit'), 100, 500),
      )),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});
browserApiRoutes.get('/art/preview/:variant', async (c) => {
  try {
    const variant = c.req.param('variant');
    if (variant !== 'high' && variant !== 'low')
      return c.json({ ok: false, error: 'invalid_variant' }, 400);
    const source = c.req.query('source');
    if (!source) return c.json({ ok: false, error: 'invalid_art_source' }, 400);
    const response = await getTcgdexPreviewArtResponse(c.env.ART, source, variant);
    return response ?? c.json({ ok: false, error: 'art_not_found' }, 404);
  } catch (error) {
    return apiFailure(c, error);
  }
});
browserApiRoutes.get('/art/:cardId/:variant', async (c) => {
  try {
    const operations = ownerOperations(c.env, sessionOwner(c));
    const variant = c.req.param('variant');
    if (variant !== 'high' && variant !== 'low')
      return c.json({ ok: false, error: 'invalid_variant' }, 400);
    const response = await operations.art(c.req.param('cardId'), variant, c.req.raw);
    return response ?? c.json({ ok: false, error: 'art_not_found' }, 404);
  } catch (error) {
    return apiFailure(c, error);
  }
});
