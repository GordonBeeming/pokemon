import {
  binderLayoutSchema,
  cardCategorySchema,
  languageSchema,
  mutationRequestSchema,
} from '@pokedex/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { getArtResponse, createArtUploadToken, listArtManifest, uploadArt } from '../../lib/art';
import {
  createBackup,
  createPairCode,
  listDesktopTokens,
  redeemPairCode,
  requireDesktopToken,
  revokeDesktopToken,
  restoreBackup,
} from '../../lib/backup';
import {
  activeBinderShortages,
  addBinderPage,
  arrangeBinderVersion,
  activateBinderVersion,
  cloneBinderVersion,
  createBinder,
  deleteBinderPage,
  getBinderVersion,
  listBinders,
  reorderBinderPages,
  setBinderSlot,
} from '../../lib/binders';
import {
  createCustomCard,
  getCardDetail,
  importCatalogueLanguage,
  listSetFacets,
  listSpeciesFacets,
  searchCards,
} from '../../lib/catalogue';
import { collectionSummary, setCollectionState } from '../../lib/collection';
import { asPositiveInt } from '../../lib/db';
import { requireSession } from '../../lib/guards';
import { logAudit } from '../../lib/auth';
import { describeError, logWarn } from '../../lib/log';
import { priceCoverage } from '../../lib/pricing';
import type { AuthVars } from '../../lib/types';

const api = new Hono<{ Bindings: CloudflareEnv; Variables: AuthVars }>();

const collectionBody = mutationRequestSchema
  .extend({
    quantity: z.number().int().min(0).max(9999),
    notes: z.string().max(2000).nullable(),
  })
  .strict();
const createBinderBody = z
  .object({ name: z.string().trim().min(1).max(120), layout: binderLayoutSchema })
  .strict();
const slotBody = z
  .object({
    page: z.number().int().nonnegative(),
    row: z.number().int().nonnegative(),
    column: z.number().int().nonnegative(),
    cardId: z.string().trim().min(1).max(128).nullable(),
  })
  .strict();
const pageOrderBody = z
  .object({ pageIds: z.array(z.string().trim().min(1).max(128)).min(1) })
  .strict();
const arrangementBody = z
  .object({ mode: z.enum(['set-number', 'release-date', 'pokedex-number', 'language']) })
  .strict();
const pairBody = z
  .object({
    scopes: z
      .array(
        z.enum(['art:read', 'art:write', 'catalogue:read', 'collection:write', 'binders:write']),
      )
      .min(1),
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

function sessionOwner(c: { get: (key: 'session') => AuthVars['session'] }): string {
  const session = c.get('session');
  if (!session) throw new Error('unauthorized');
  return session.sub;
}

async function parsedJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch (error) {
    throw new Error(`invalid_json: ${describeError(error)}`);
  }
}

function apiFailure(
  c: {
    json: (body: { ok: false; error: string }, status: 400 | 401 | 404 | 409 | 500) => Response;
  },
  error: unknown,
): Response {
  const message = describeError(error);
  const known = new Set([
    'unauthorized',
    'card_not_found',
    'binder_version_not_found',
    'binder_page_not_found',
    'binder_version_not_draft',
    'binder_slot_out_of_bounds',
    'pair_code_invalid',
    'pair_code_already_consumed',
    'desktop_token_invalid',
    'desktop_token_scope_missing',
    'art_upload_token_invalid',
    'art_upload_size_invalid',
    'art_upload_not_webp',
    'art_upload_checksum_mismatch',
    'backup_not_found',
    'backup_invalid',
  ]);
  const code = message.split(':', 1).at(0) ?? 'internal_error';
  const status =
    code === 'unauthorized' ||
    code === 'desktop_token_invalid' ||
    code === 'desktop_token_scope_missing'
      ? 401
      : code.endsWith('_not_found') || code === 'card_not_found'
        ? 404
        : code.includes('not_draft') || code.includes('already_consumed')
          ? 409
          : known.has(code)
            ? 400
            : 500;
  if (status === 500) logWarn({ evt: 'api.request_failed', err: message });
  return c.json({ ok: false, error: status === 500 ? 'internal_error' : code }, status);
}

api.post('/desktop/pair/redeem', async (c) => {
  try {
    const parsed = redeemBody.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const token = await redeemPairCode(c.env.DB, parsed.data.code, parsed.data.label);
    return c.json({ ok: true, ...token });
  } catch (error) {
    return apiFailure(c, error);
  }
});

api.post('/desktop/art/upload-tokens', async (c) => {
  try {
    const bearer = c.req.header('authorization')?.replace(/^Bearer\s+/iu, '') ?? '';
    const ownerId = await requireDesktopToken(c.env.DB, bearer, 'art:write');
    const parsed = uploadRequestBody.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const token = await createArtUploadToken(
      c.env.DB,
      ownerId,
      parsed.data.cardId,
      parsed.data.variant,
      parsed.data.sha256,
      parsed.data.maxBytes,
    );
    return c.json({ ok: true, token, uploadPath: `/api/desktop/art/uploads/${token}` }, 201);
  } catch (error) {
    return apiFailure(c, error);
  }
});

api.put('/desktop/art/uploads/:token', async (c) => {
  try {
    return c.json({
      ok: true,
      ...(await uploadArt(c.env.DB, c.env.ART, c.req.param('token'), c.req.raw)),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});

api.use('*', requireSession);

api.get('/dashboard', async (c) => {
  try {
    const ownerId = sessionOwner(c);
    const [collection, pricing, binders, activeShortages] = await Promise.all([
      collectionSummary(c.env.DB, ownerId),
      priceCoverage(c.env.DB, ownerId),
      listBinders(c.env.DB, ownerId),
      activeBinderShortages(c.env.DB, ownerId),
    ]);
    return c.json({ ok: true, collection, pricing, binderCount: binders.length, activeShortages });
  } catch (error) {
    return apiFailure(c, error);
  }
});

api.get('/catalogue/search', async (c) => {
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
    const result = await searchCards(c.env.DB, sessionOwner(c), {
      query: query.q,
      language: language?.success ? language.data : undefined,
      category: category?.success ? category.data : undefined,
      setId: query.setId,
      species: query.species,
      owned,
      limit: asPositiveInt(query.limit, 50, 100),
      offset: Math.max(0, Number.parseInt(query.offset ?? '0', 10) || 0),
    });
    return c.json({ ok: true, ...result });
  } catch (error) {
    return apiFailure(c, error);
  }
});

api.get('/catalogue/:id', async (c) => {
  try {
    const card = await getCardDetail(c.env.DB, sessionOwner(c), c.req.param('id'));
    return card ? c.json({ ok: true, card }) : c.json({ ok: false, error: 'card_not_found' }, 404);
  } catch (error) {
    return apiFailure(c, error);
  }
});

api.get('/catalogue/facets/sets', async (c) => {
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
api.get('/catalogue/facets/species', async (c) => {
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

api.post('/catalogue/sync', async (c) => {
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
api.post('/catalogue/custom', async (c) => {
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

api.put('/collection/:cardId', async (c) => {
  try {
    const parsed = collectionBody.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const ownerId = sessionOwner(c);
    const result = await setCollectionState(c.env.DB, ownerId, {
      ...parsed.data,
      cardId: c.req.param('cardId'),
    });
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

api.get('/binders', async (c) => {
  try {
    return c.json({ ok: true, binders: await listBinders(c.env.DB, sessionOwner(c)) });
  } catch (error) {
    return apiFailure(c, error);
  }
});
api.post('/binders', async (c) => {
  try {
    const parsed = createBinderBody.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    return c.json(
      {
        ok: true,
        binder: await createBinder(c.env.DB, sessionOwner(c), parsed.data.name, parsed.data.layout),
      },
      201,
    );
  } catch (error) {
    return apiFailure(c, error);
  }
});
api.get('/binders/versions/:id', async (c) => {
  try {
    return c.json({
      ok: true,
      binder: await getBinderVersion(c.env.DB, sessionOwner(c), c.req.param('id')),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});
api.post('/binders/versions/:id/clone', async (c) => {
  try {
    return c.json(
      { ok: true, binder: await cloneBinderVersion(c.env.DB, sessionOwner(c), c.req.param('id')) },
      201,
    );
  } catch (error) {
    return apiFailure(c, error);
  }
});
api.post('/binders/versions/:id/activate', async (c) => {
  try {
    return c.json({
      ok: true,
      binder: await activateBinderVersion(c.env.DB, sessionOwner(c), c.req.param('id')),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});
api.put('/binders/versions/:id/slot', async (c) => {
  try {
    const parsed = slotBody.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    return c.json({
      ok: true,
      binder: await setBinderSlot(
        c.env.DB,
        sessionOwner(c),
        c.req.param('id'),
        parsed.data.page,
        parsed.data.row,
        parsed.data.column,
        parsed.data.cardId,
      ),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});
api.post('/binders/versions/:id/arrange', async (c) => {
  try {
    const parsed = arrangementBody.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    return c.json({
      ok: true,
      binder: await arrangeBinderVersion(
        c.env.DB,
        sessionOwner(c),
        c.req.param('id'),
        parsed.data.mode,
      ),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});
api.post('/binders/versions/:id/pages', async (c) => {
  try {
    return c.json(
      { ok: true, binder: await addBinderPage(c.env.DB, sessionOwner(c), c.req.param('id')) },
      201,
    );
  } catch (error) {
    return apiFailure(c, error);
  }
});
api.delete('/binders/versions/:id/pages/:pageId', async (c) => {
  try {
    return c.json({
      ok: true,
      binder: await deleteBinderPage(
        c.env.DB,
        sessionOwner(c),
        c.req.param('id'),
        c.req.param('pageId'),
      ),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});
api.put('/binders/versions/:id/pages/order', async (c) => {
  try {
    const parsed = pageOrderBody.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    return c.json({
      ok: true,
      binder: await reorderBinderPages(
        c.env.DB,
        sessionOwner(c),
        c.req.param('id'),
        parsed.data.pageIds,
      ),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});

api.post('/backups', async (c) => {
  try {
    return c.json({ ok: true, ...(await createBackup(c.env.DB, c.env.ART, sessionOwner(c))) }, 201);
  } catch (error) {
    return apiFailure(c, error);
  }
});
api.post('/backups/:id/restore', async (c) => {
  try {
    await restoreBackup(c.env.DB, c.env.ART, sessionOwner(c), c.req.param('id'));
    return c.json({ ok: true });
  } catch (error) {
    return apiFailure(c, error);
  }
});
api.post('/desktop/pair', async (c) => {
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
api.get('/desktop/tokens', async (c) => {
  try {
    return c.json({ ok: true, tokens: await listDesktopTokens(c.env.DB, sessionOwner(c)) });
  } catch (error) {
    return apiFailure(c, error);
  }
});
api.delete('/desktop/tokens/:id', async (c) => {
  try {
    const revoked = await revokeDesktopToken(c.env.DB, sessionOwner(c), c.req.param('id'));
    return revoked
      ? c.json({ ok: true })
      : c.json({ ok: false, error: 'desktop_token_not_found' }, 404);
  } catch (error) {
    return apiFailure(c, error);
  }
});
api.get('/art/manifest', async (c) => {
  try {
    return c.json({
      ok: true,
      ...(await listArtManifest(
        c.env.DB,
        c.req.query('cursor') ?? null,
        asPositiveInt(c.req.query('limit'), 100, 500),
      )),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});
api.get('/art/:cardId/:variant', async (c) => {
  try {
    const variant = c.req.param('variant');
    if (variant !== 'high' && variant !== 'low')
      return c.json({ ok: false, error: 'invalid_variant' }, 400);
    const response = await getArtResponse(
      c.env.DB,
      c.env.ART,
      c.req.param('cardId'),
      variant,
      c.req.raw,
    );
    return response ?? c.json({ ok: false, error: 'art_not_found' }, 404);
  } catch (error) {
    return apiFailure(c, error);
  }
});
export { api as apiRoutes };
