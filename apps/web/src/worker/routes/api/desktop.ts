import { Hono } from 'hono';
import type { BinderShortage, BinderVersionPages } from '@pokedex/shared';
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
  ) => Promise<{ shortages: BinderShortage[]; nextOffset: number | null }>,
): Promise<BinderShortage[]> {
  const shortages: BinderShortage[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = await load(offset, 100);
    shortages.push(...page.shortages);
    if (page.nextOffset !== null && page.nextOffset <= offset)
      throw new Error('binder shortage cursor did not advance');
    offset = page.nextOffset;
  }
  return shortages;
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
    const [pages, shortages] = await Promise.all([
      loadAllBinderPages((offset, limit) => operations.binderVersion(versionId, offset, limit)),
      loadAllBinderShortages((offset, limit) =>
        operations.binderShortages(versionId, offset, limit),
      ),
    ]);
    return c.json({
      ok: true,
      shortages,
      nextOffset: null,
      emptySlots: pages.flatMap((page) =>
        page.slots
          .filter((slot) => slot.cardId === null)
          .map((slot) => ({ ...slot, page: page.position })),
      ),
    });
  } catch (error) {
    return apiFailure(c, error);
  }
});
