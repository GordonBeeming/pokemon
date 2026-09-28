import type { APIRequestContext, APIResponse } from '@playwright/test';
import {
  cardBinderMatchesResponseSchema,
  binderViewSchema,
  catalogueCardViewSchema,
  catalogueDetailViewSchema,
  collectionMutationResultSchema,
  invitePublicStatusSchema,
  personSchema,
  type BinderCardMatches,
} from '@pokedex/shared';
import { z } from 'zod';

const searchResponseSchema = z
  .object({
    ok: z.literal(true),
    total: z.number().int().nonnegative(),
    cards: z.array(catalogueCardViewSchema.passthrough()),
    cursor: z.string().nullable(),
  })
  .passthrough();

const binderMatchesResponseSchema = z
  .object({ ok: z.literal(true) })
  .merge(cardBinderMatchesResponseSchema)
  .passthrough();

const bindersResponseSchema = z
  .object({ ok: z.literal(true), binders: z.array(binderViewSchema.passthrough()) })
  .passthrough();

const binderSlotResponseSchema = z
  .object({
    row: z.number().int(),
    column: z.number().int(),
    entryKind: z.string(),
    cardId: z.string().nullable().optional(),
    pokemonNumber: z.number().nullable().optional(),
    assignedCardId: z.string().nullable().optional(),
  })
  .passthrough();
const binderPageWindowResponseSchema = z
  .object({
    ok: z.literal(true),
    binder: z
      .object({
        version: z
          .object({ id: z.string(), revision: z.number().int(), pageCount: z.number() })
          .passthrough(),
        pages: z.array(
          z.object({ id: z.string(), slots: z.array(binderSlotResponseSchema) }).passthrough(),
        ),
      })
      .passthrough(),
  })
  .passthrough();

const meResponseSchema = z
  .object({ ok: z.literal(true), sub: z.string(), label: z.string(), role: z.string().optional() })
  .passthrough();

const catalogueDetailResponseSchema = z
  .object({ ok: z.literal(true), card: catalogueDetailViewSchema.passthrough() })
  .passthrough();

const collectionMutationResponseSchema = z
  .object({ ok: z.literal(true) })
  .merge(collectionMutationResultSchema)
  .passthrough();

const peopleResponseSchema = z
  .object({ ok: z.literal(true), people: z.array(personSchema.passthrough()) })
  .passthrough();

const personResponseSchema = z
  .object({ ok: z.literal(true), person: personSchema.passthrough() })
  .passthrough();

const createInviteResponseSchema = z
  .object({ ok: z.literal(true), id: z.string(), inviteUrl: z.string(), expiresAt: z.string() })
  .passthrough();

const invitePublicResponseSchema = z
  .object({ ok: z.literal(true) })
  .merge(invitePublicStatusSchema)
  .passthrough();

const okResponseSchema = z.object({ ok: z.literal(true) }).passthrough();

async function parse<T>(response: APIResponse, schema: z.ZodType<T>, context: string): Promise<T> {
  const status = response.status();
  const raw: unknown = await response.json().catch(() => null);
  if (!response.ok())
    throw new Error(`${context} failed (${status}): ${JSON.stringify(raw).slice(0, 500)}`);
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new Error(`${context} returned an unexpected shape: ${parsed.error.message}`);
  return parsed.data;
}

/** Every helper below carries an ApiError's `error` code up as the failure message
 * (rather than a generic non-2xx), since that's what a test asserting on a specific
 * refusal (e.g. `user_disabled`) needs to see. */
async function errorCode(response: APIResponse): Promise<string | null> {
  const raw: unknown = await response.json().catch(() => null);
  if (raw && typeof raw === 'object' && 'error' in raw && typeof raw.error === 'string')
    return raw.error;
  return null;
}

export async function devLoginAs(request: APIRequestContext, userId?: string): Promise<void> {
  const response = await request.post('/api/auth/dev-login', {
    data: userId ? { userId } : {},
  });
  if (!response.ok())
    throw new Error(
      `dev-login failed (${response.status()}): ${(await errorCode(response)) ?? 'unknown'}`,
    );
}

/** A typed GET for the few assertions that read a response shape no helper below covers. */
export function getJson<T>(
  request: APIRequestContext,
  path: string,
  schema: z.ZodType<T>,
): Promise<T> {
  return request.get(path).then((r) => parse(r, schema, `GET ${path}`));
}

const dashboardResponseSchema = z
  .object({
    ok: z.literal(true),
    collection: z.object({ uniqueOwned: z.number() }).passthrough(),
    pricing: z.unknown(),
    binderCount: z.number(),
  })
  .passthrough();

export function dashboard(request: APIRequestContext) {
  return getJson(request, '/api/dashboard', dashboardResponseSchema);
}

export function me(request: APIRequestContext) {
  return request.get('/api/auth/me').then((r) => parse(r, meResponseSchema, 'GET /api/auth/me'));
}

const CATALOGUE_PAGE_SIZE = 50;

export interface SearchOptions {
  q?: string;
  owned?: 'all' | 'owned' | 'missing';
  type?: string[];
  /** 1-based, matching the app's own `CatalogueSearch.page` — converted to the
   * worker's actual `limit`/`offset` wire shape below (see operations.ts's
   * `catalogueFilters`, which knows nothing about "page"). */
  page?: number;
}

export function searchCatalogue(request: APIRequestContext, options: SearchOptions = {}) {
  const params = new URLSearchParams();
  if (options.q) params.set('q', options.q);
  // The worker's `owned` filter is a literal "true"/"false" string, not the app's
  // own all/owned/missing vocabulary — see operations.ts's `catalogueFilters`.
  if (options.owned === 'owned') params.set('owned', 'true');
  if (options.owned === 'missing') params.set('owned', 'false');
  for (const type of options.type ?? []) params.append('type', type);
  const page = options.page ?? 1;
  params.set('limit', String(CATALOGUE_PAGE_SIZE));
  params.set('offset', String((page - 1) * CATALOGUE_PAGE_SIZE));
  params.set('includePokemonNumber', 'true');
  return request
    .get(`/api/catalogue/search?${params}`)
    .then((r) => parse(r, searchResponseSchema, 'GET /api/catalogue/search'));
}

export function cardDetail(request: APIRequestContext, cardId: string) {
  return request
    .get(`/api/catalogue/${encodeURIComponent(cardId)}`)
    .then((r) => parse(r, catalogueDetailResponseSchema, 'GET /api/catalogue/:id'))
    .then((body) => body.card);
}

export function binderMatches(
  request: APIRequestContext,
  cardId: string,
): Promise<BinderCardMatches[]> {
  return request
    .get(`/api/cards/${encodeURIComponent(cardId)}/binder-matches`)
    .then((r) => parse(r, binderMatchesResponseSchema, 'GET /api/cards/:id/binder-matches'))
    .then((body) => body.binders);
}

export function placeCard(
  request: APIRequestContext,
  cardId: string,
  body: { binderId: string; slotId: string; addCopy: boolean; expectedRevision: number },
) {
  return request.post(`/api/cards/${encodeURIComponent(cardId)}/place`, { data: body });
}

export function incrementCollection(request: APIRequestContext, cardId: string, delta = 1) {
  return request
    .post(`/api/collection/${encodeURIComponent(cardId)}/increment`, {
      data: { delta, mutationId: cryptoRandomId() },
    })
    .then((r) => parse(r, collectionMutationResponseSchema, 'POST /api/collection/:id/increment'))
    .then((body) => body.state);
}

export function removeCollectionCopy(
  request: APIRequestContext,
  cardId: string,
  body:
    | { source: 'pocket'; slotId: string }
    | { source: 'loose' }
    | { source: 'miscount'; slotId?: string },
) {
  return request.post(`/api/collection/${encodeURIComponent(cardId)}/remove`, { data: body });
}

export function listBinders(request: APIRequestContext) {
  return request
    .get('/api/binders')
    .then((r) => parse(r, bindersResponseSchema, 'GET /api/binders'))
    .then((body) => body.binders);
}

export function binderPage(request: APIRequestContext, versionId: string, pageIndex: number) {
  return request
    .get(`/api/binders/versions/${encodeURIComponent(versionId)}?page=${pageIndex}&limit=1`)
    .then((r) => parse(r, binderPageWindowResponseSchema, 'GET /api/binders/versions/:id'))
    .then((body) => body.binder);
}

export function listPeople(request: APIRequestContext) {
  return request
    .get('/api/people')
    .then((r) => parse(r, peopleResponseSchema, 'GET /api/people'))
    .then((body) => body.people);
}

export function patchPerson(
  request: APIRequestContext,
  id: string,
  patch: { role?: 'admin' | 'member'; disabled?: boolean },
) {
  return request
    .patch(`/api/people/${encodeURIComponent(id)}`, { data: patch })
    .then((r) => parse(r, personResponseSchema, 'PATCH /api/people/:id'))
    .then((body) => body.person);
}

export function createInvite(
  request: APIRequestContext,
  body: { role: 'admin' | 'member'; label?: string },
) {
  return request
    .post('/api/people/invites', { data: body })
    .then((r) => parse(r, createInviteResponseSchema, 'POST /api/people/invites'));
}

export function inviteStatus(request: APIRequestContext, token: string) {
  return request
    .get(`/api/auth/invites/${encodeURIComponent(token)}`)
    .then((r) => parse(r, invitePublicResponseSchema, 'GET /api/auth/invites/:token'));
}

export function logout(request: APIRequestContext) {
  return request
    .post('/api/auth/logout')
    .then((r) => parse(r, okResponseSchema, 'POST /api/auth/logout'));
}

function cryptoRandomId(): string {
  // Node's global crypto (available in the Playwright test runner) — a real UUID,
  // not a counter, so concurrent mutations from different tests never collide.
  return crypto.randomUUID();
}
