import {
  binderLayoutSchema,
  binderRevisionRequestSchema,
  binderSlotSetRequestSchema,
  binderSlotSwapRequestSchema,
  cardCategorySchema,
  collectionIncrementRequestSchema,
  collectionNotesPatchRequestSchema,
  collectionSetRequestSchema,
  languageSchema,
  mutationRequestSchema,
  desktopScopeSchema,
  type DesktopScope,
} from '@pokedex/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { createArtUploadToken, createArtUploadTokens, uploadArt } from '../../lib/art';
import { restoreBackup } from '../../lib/backup';
import {
  createPairCode,
  listDesktopTokens,
  redeemPairCode,
  requireDesktopToken,
  revokeDesktopToken,
} from '../../lib/desktop-auth';
import { activeBinderShortages } from '../../lib/binders';
import {
  createCustomCard,
  beginStagedCatalogueRun,
  stageCatalogueCards,
  applyStagedCatalogueRun,
  importCatalogueLanguage,
  listSetFacets,
  listSpeciesFacets,
  listCatalogueSources,
} from '../../lib/catalogue';
import { collectionSummary } from '../../lib/collection';
import { asPositiveInt } from '../../lib/db';
import { clientIp, enforceRateLimit, requireSession } from '../../lib/guards';
import { logAudit } from '../../lib/auth';
import { ApplicationError } from '../../lib/log';
import { priceCoverage } from '../../lib/pricing';
import type { AuthVars } from '../../lib/types';
import { apiFailure, parsedJson } from './errors';
import { ownerOperations } from './operations';

const api = new Hono<{ Bindings: CloudflareEnv; Variables: AuthVars }>();
const desktopPublic = new Hono<{ Bindings: CloudflareEnv; Variables: AuthVars }>();
const desktop = new Hono<{ Bindings: CloudflareEnv; Variables: AuthVars }>();
const browser = new Hono<{ Bindings: CloudflareEnv; Variables: AuthVars }>();

const collectionBody = mutationRequestSchema
  .extend({
    quantity: z.number().int().min(0).max(9999),
    notes: z.string().max(2000).nullable(),
  })
  .strict();
const collectionSetBody = collectionSetRequestSchema;
const compatibleCollectionSetBody = z.union([collectionSetBody, collectionBody]);
const collectionIncrementBody = collectionIncrementRequestSchema;
const collectionNotesBody = collectionNotesPatchRequestSchema;
const createBinderBody = z
  .object({ name: z.string().trim().min(1).max(120), layout: binderLayoutSchema })
  .strict();
export const pageOrderBody = binderRevisionRequestSchema
  .extend({ pageIds: z.array(z.string().trim().min(1).max(128)).min(1) })
  .strict();
export const arrangementBody = binderRevisionRequestSchema
  .extend({
    mode: z.enum(['set-number', 'release-date', 'pokedex-number', 'language']),
  })
  .strict();
const pairBody = z
  .object({
    scopes: z.array(desktopScopeSchema).min(1),
  })
  .strict();
const redeemBody = z
  .object({ code: z.string().trim().min(8).max(64), label: z.string().trim().min(1).max(80) })
  .strict();
const uploadRequestBody = z
  .object({
    cardId: z.string().trim().min(1).max(128),
    variant: z.enum(['high', 'low']),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    maxBytes: z
      .number()
      .int()
      .min(1)
      .max(15 * 1024 * 1024),
  })
  .strict();
const bulkUploadRequestBody = z
  .object({ uploads: z.array(uploadRequestBody).min(1).max(100) })
  .strict();
const syncBody = z
  .object({
    provider: z.literal('tcgdex'),
    language: languageSchema,
    allowDestructiveDrop: z.boolean().optional(),
    complete: z.boolean().optional(),
    cards: z
      .array(
        z
          .object({
            sourceId: z.string().trim().min(1).max(256),
            checksum: z.string().regex(/^[a-f0-9]{64}$/u),
            sourceUpdatedAt: z.number().int().nonnegative(),
            name: z.string().trim().min(1).max(200),
            language: languageSchema,
            category: cardCategorySchema,
            setId: z.string().trim().min(1).max(128),
            setName: z.string().trim().min(1).max(200),
            number: z.string().trim().min(1).max(32),
            numberSort: z.number().int().nonnegative().nullable().optional(),
            releaseDate: z.string().date().nullable().optional(),
            pokedexNumber: z.number().int().positive().nullable().optional(),
            supertype: z.string().trim().max(80).nullable().optional(),
            subtype: z.string().trim().max(120).nullable().optional(),
            species: z.string().trim().max(120).nullable().optional(),
            rarity: z.string().trim().max(120).nullable().optional(),
            artist: z.string().trim().max(200).nullable().optional(),
          })
          .strict(),
      )
      .max(1000),
  })
  .strict();
const customCardBody = syncBody.shape.cards.element
  .omit({ sourceId: true, checksum: true, sourceUpdatedAt: true })
  .strict();
const syncPageBody = z.object({ cards: syncBody.shape.cards }).strict();
const syncRunBody = z.object({ language: languageSchema }).strict();
const syncFinalizeBody = z.object({ allowDestructiveDrop: z.boolean().optional() }).strict();
const BACKUP_CREATE_WINDOW_SECONDS = 15 * 60;

function sessionOwner(c: { get: (key: 'session') => AuthVars['session'] }): string {
  const session = c.get('session');
  if (!session) throw new ApplicationError('unauthorized', 401);
  return session.sub;
}

export function parseDesktopBearer(header: string | undefined): string | null {
  const matched = header?.match(/^Bearer ([a-f0-9]{64})$/iu);
  return matched?.[1] ?? null;
}

function uploadBearer(header: string | undefined): string | null {
  const matched = header?.match(/^Bearer ([a-f0-9]{64})$/iu);
  return matched?.[1] ?? null;
}

async function desktopOwner(
  c: { env: CloudflareEnv; get: (key: 'desktopBearer') => string | undefined },
  scope: DesktopScope,
): Promise<string> {
  const bearer = c.get('desktopBearer');
  if (!bearer) throw new ApplicationError('desktop_token_invalid', 401);
  return requireDesktopToken(c.env.DB, bearer, scope);
}

desktopPublic.post('/desktop/pair/redeem', async (c) => {
  try {
    const rate = await enforceRateLimit(c.env, `pair:${clientIp(c.req.raw)}`, 6, 15 * 60);
    if (!rate.allowed) {
      c.header('retry-after', String(rate.retryAfter));
      return c.json({ ok: false, error: 'rate_limited', requestId: c.get('requestId') }, 429);
    }
    const parsed = redeemBody.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const token = await redeemPairCode(c.env.DB, parsed.data.code, parsed.data.label);
    return c.json({ ok: true, ...token });
  } catch (error) {
    return apiFailure(c, error);
  }
});

const requireDesktopBearer = async (
  c: import('hono').Context<{ Bindings: CloudflareEnv; Variables: AuthVars }>,
  next: import('hono').Next,
) => {
  const bearer = parseDesktopBearer(c.req.header('authorization'));
  if (!bearer) return c.json({ ok: false, error: 'desktop_token_invalid' }, 401);
  c.set('desktopBearer', bearer);
  await next();
};
desktop.use('/desktop/art/*', requireDesktopBearer);
desktop.use('/desktop/catalogue/*', requireDesktopBearer);
desktop.use('/desktop/collection/*', requireDesktopBearer);
desktop.use('/desktop/binders*', requireDesktopBearer);

desktop.post('/desktop/art/upload-tokens', async (c) => {
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
desktop.post('/desktop/art/upload-tokens/bulk', async (c) => {
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

desktopPublic.put('/desktop/art/uploads/:token', async (c) => {
  try {
    const pathTicket = c.req.param('token');
    const token =
      uploadBearer(c.req.header('authorization')) ??
      (/^[a-f0-9]{64}$/iu.test(pathTicket) ? pathTicket : null);
    if (!token)
      return c.json(
        { ok: false, error: 'art_upload_token_invalid', requestId: c.get('requestId') },
        401,
      );
    return c.json({
      ok: true,
      ...(await uploadArt(c.env.DB, c.env.ART, token, pathTicket, c.req.raw)),
    });
  } catch (error) {
    if (error instanceof ApplicationError && error.code === 'art_upload_in_progress')
      c.header('retry-after', '2');
    return apiFailure(c, error);
  }
});

desktop.get('/desktop/catalogue/search', async (c) => {
  try {
    const ownerId = await desktopOwner(c, 'catalogue:read');
    const query = c.req.query();
    const language = query.language ? languageSchema.safeParse(query.language) : undefined;
    const category = query.category ? cardCategorySchema.safeParse(query.category) : undefined;
    if ((language && !language.success) || (category && !category.success))
      return c.json({ ok: false, error: 'invalid_filter' }, 400);
    return c.json({
      ok: true,
      ...(await ownerOperations(c.env, ownerId).searchCatalogue({
        query: query.q,
        language: language?.success ? language.data : undefined,
        category: category?.success ? category.data : undefined,
        setId: query.setId,
        species: query.species,
        limit: asPositiveInt(query.limit, 50, 100),
        offset: Math.max(0, Number.parseInt(query.offset ?? '0', 10) || 0),
        cursor: query.cursor ?? null,
      })),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});
desktop.get('/desktop/catalogue/sources', async (c) => {
  try {
    await desktopOwner(c, 'catalogue:read');
    const result = await listCatalogueSources(
      c.env.DB,
      c.req.query('cursor') ?? null,
      asPositiveInt(c.req.query('limit'), 500, 500),
    );
    return c.json({ ok: true, ...result });
  } catch (error) {
    return apiFailure(c, error);
  }
});
desktop.get('/desktop/catalogue/:id', async (c) => {
  try {
    const operations = ownerOperations(c.env, await desktopOwner(c, 'catalogue:read'));
    return c.json({ ok: true, card: await operations.cardDetail(c.req.param('id')) });
  } catch (error) {
    return apiFailure(c, error);
  }
});
desktop.get('/desktop/art/manifest', async (c) => {
  try {
    const operations = ownerOperations(c.env, await desktopOwner(c, 'art:read'));
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
desktop.get('/desktop/art/:cardId/:variant', async (c) => {
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
desktop.put('/desktop/collection/:cardId', async (c) => {
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
desktop.post('/desktop/collection/:cardId/increment', async (c) => {
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
desktop.patch('/desktop/collection/:cardId/notes', async (c) => {
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
desktop.get('/desktop/binders', async (c) => {
  try {
    return c.json({
      ok: true,
      binders: await ownerOperations(c.env, await desktopOwner(c, 'binders:write')).listBinders(),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});
desktop.get('/desktop/binders/versions/:id', async (c) => {
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
desktop.get('/desktop/binders/versions/:id/shortages', async (c) => {
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
desktop.post('/desktop/binders', async (c) => {
  try {
    const parsed = createBinderBody.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    return c.json(
      {
        ok: true,
        binder: await ownerOperations(c.env, await desktopOwner(c, 'binders:write')).createBinder(
          parsed.data.name,
          parsed.data.layout,
        ),
      },
      201,
    );
  } catch (error) {
    return apiFailure(c, error);
  }
});
desktop.put('/desktop/binders/versions/:id/slot', async (c) => {
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
desktop.post('/desktop/binders/versions/:id/swap', async (c) => {
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
desktop.get('/desktop/binders/versions/:id/suggest', async (c) => {
  try {
    const operations = ownerOperations(c.env, await desktopOwner(c, 'binders:write'));
    const [binder, shortagePage] = await Promise.all([
      operations.binderVersion(c.req.param('id')),
      operations.binderShortages(c.req.param('id')),
    ]);
    return c.json({
      ok: true,
      shortages: shortagePage.shortages,
      nextOffset: shortagePage.nextOffset,
      emptySlots: binder.pages.flatMap((page) => page.slots.filter((slot) => slot.cardId === null)),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});

browser.use('/dashboard*', requireSession);
browser.use('/catalogue*', requireSession);
browser.use('/collection*', requireSession);
browser.use('/binders*', requireSession);
browser.use('/backups*', requireSession);
browser.use('/desktop/pair', requireSession);
browser.use('/desktop/tokens*', requireSession);
browser.use('/art*', requireSession);

browser.get('/dashboard', async (c) => {
  try {
    const ownerId = sessionOwner(c);
    const [collection, pricing, binders, activeShortages] = await Promise.all([
      collectionSummary(c.env.DB, ownerId),
      priceCoverage(c.env.DB, ownerId),
      ownerOperations(c.env, ownerId).listBinders(),
      activeBinderShortages(c.env.DB, ownerId),
    ]);
    return c.json({ ok: true, collection, pricing, binderCount: binders.length, activeShortages });
  } catch (error) {
    return apiFailure(c, error);
  }
});

browser.get('/catalogue/search', async (c) => {
  try {
    const query = c.req.query();
    const language = query.language ? languageSchema.safeParse(query.language) : undefined;
    const category = query.category ? cardCategorySchema.safeParse(query.category) : undefined;
    if ((language && !language.success) || (category && !category.success))
      return c.json({ ok: false, error: 'invalid_filter' }, 400);
    const owned =
      query.owned === undefined
        ? undefined
        : query.owned === 'true'
          ? true
          : query.owned === 'false'
            ? false
            : undefined;
    if (query.owned !== undefined && owned === undefined)
      return c.json({ ok: false, error: 'invalid_filter' }, 400);
    const result = await ownerOperations(c.env, sessionOwner(c)).searchCatalogue({
      query: query.q,
      language: language?.success ? language.data : undefined,
      category: category?.success ? category.data : undefined,
      setId: query.setId,
      species: query.species,
      owned,
      limit: asPositiveInt(query.limit, 50, 100),
      offset: Math.max(0, Number.parseInt(query.offset ?? '0', 10) || 0),
      cursor: query.cursor ?? null,
    });
    return c.json({ ok: true, ...result });
  } catch (error) {
    return apiFailure(c, error);
  }
});

browser.get('/catalogue/:id', async (c) => {
  try {
    const operations = ownerOperations(c.env, sessionOwner(c));
    return c.json({ ok: true, card: await operations.cardDetail(c.req.param('id')) });
  } catch (error) {
    return apiFailure(c, error);
  }
});

browser.get('/catalogue/facets/sets', async (c) => {
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
browser.get('/catalogue/facets/species', async (c) => {
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

browser.post('/catalogue/sync', async (c) => {
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
browser.post('/catalogue/sync/runs', async (c) => {
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
browser.post('/catalogue/sync/runs/:id/cards', async (c) => {
  try {
    const parsed = syncPageBody.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    await stageCatalogueCards(c.env.DB, c.req.param('id'), parsed.data.cards);
    return c.json({ ok: true, accepted: parsed.data.cards.length });
  } catch (error) {
    return apiFailure(c, error);
  }
});
browser.post('/catalogue/sync/runs/:id/finalize', async (c) => {
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
browser.post('/catalogue/custom', async (c) => {
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

browser.put('/collection/:cardId', async (c) => {
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
browser.post('/collection/:cardId/increment', async (c) => {
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
browser.patch('/collection/:cardId/notes', async (c) => {
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

browser.get('/binders', async (c) => {
  try {
    return c.json({
      ok: true,
      binders: await ownerOperations(c.env, sessionOwner(c)).listBinders(),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});
browser.post('/binders', async (c) => {
  try {
    const parsed = createBinderBody.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    return c.json(
      {
        ok: true,
        binder: await ownerOperations(c.env, sessionOwner(c)).createBinder(
          parsed.data.name,
          parsed.data.layout,
        ),
      },
      201,
    );
  } catch (error) {
    return apiFailure(c, error);
  }
});
browser.get('/binders/versions/:id', async (c) => {
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
browser.get('/binders/versions/:id/shortages', async (c) => {
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
browser.post('/binders/versions/:id/clone', async (c) => {
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
browser.post('/binders/versions/:id/activate', async (c) => {
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
browser.put('/binders/versions/:id/slot', async (c) => {
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
browser.post('/binders/versions/:id/swap', async (c) => {
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
browser.post('/binders/versions/:id/arrange', async (c) => {
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
browser.post('/binders/versions/:id/pages', async (c) => {
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
browser.delete('/binders/versions/:id/pages/:pageId', async (c) => {
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
browser.put('/binders/versions/:id/pages/order', async (c) => {
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

browser.post('/backups', async (c) => {
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
      params: { ownerId },
    });
    return c.json({ ok: true, workflowId: workflow.id }, 202);
  } catch (error) {
    return apiFailure(c, error);
  }
});
browser.get('/backups/workflows/:id', async (c) => {
  try {
    const workflow = await c.env.BACKUP.get(c.req.param('id'));
    const status = await workflow.status();
    if (status.status === 'complete') {
      const output = z
        .object({ id: z.string().min(1), checksum: z.string().regex(/^[a-f0-9]{64}$/u) })
        .strict()
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
browser.post('/backups/:id/restore', async (c) => {
  try {
    await restoreBackup(c.env.DB, c.env.ART, sessionOwner(c), c.req.param('id'));
    return c.json({ ok: true });
  } catch (error) {
    return apiFailure(c, error);
  }
});
browser.post('/desktop/pair', async (c) => {
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
browser.get('/desktop/tokens', async (c) => {
  try {
    return c.json({ ok: true, tokens: await listDesktopTokens(c.env.DB, sessionOwner(c)) });
  } catch (error) {
    return apiFailure(c, error);
  }
});
browser.delete('/desktop/tokens/:id', async (c) => {
  try {
    const revoked = await revokeDesktopToken(c.env.DB, sessionOwner(c), c.req.param('id'));
    return revoked
      ? c.json({ ok: true })
      : c.json({ ok: false, error: 'desktop_token_not_found' }, 404);
  } catch (error) {
    return apiFailure(c, error);
  }
});
browser.get('/art/manifest', async (c) => {
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
browser.get('/art/:cardId/:variant', async (c) => {
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

api.route('/', desktopPublic);
api.route('/', desktop);
api.route('/', browser);
export { api as apiRoutes };
