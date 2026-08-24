import {
  apiErrorSchema,
  binderLayoutSchema,
  binderMutationResultSchema,
  binderShortageSchema,
  binderVersionPagesSchema,
  binderViewSchema,
  catalogueCardViewSchema,
  catalogueDetailViewSchema,
  collectionIncrementRequestSchema,
  collectionMutationResultSchema,
  collectionNotesPatchRequestSchema,
  collectionSetRequestSchema,
} from '@pokedex/shared';
import type {
  BinderLayout,
  BinderMutationResult,
  BinderSlotLocation,
  BinderVersionPages,
  BinderView,
  CatalogueCardView,
  CatalogueDetailView,
  CollectionIncrementRequest,
  CollectionNotesPatchRequest,
  CollectionSetRequest,
  CollectionState,
} from '@pokedex/shared';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser';
import { z } from 'zod';

const successSchema = z.object({ ok: z.literal(true) }).passthrough();
const sessionSchema = z
  .object({ ok: z.literal(true), sub: z.string(), label: z.string() })
  .strict();
const dashboardSchema = successSchema.extend({
  collection: z
    .object({ uniqueOwned: z.number(), totalQuantity: z.number(), noted: z.number() })
    .strict(),
  pricing: z.object({ priced: z.number(), missing: z.number(), estimateAud: z.number() }).strict(),
  binderCount: z.number(),
  activeShortages: z.array(binderShortageSchema),
});
const searchSchema = successSchema.extend({
  total: z.number().int().nonnegative(),
  cards: z.array(catalogueCardViewSchema),
});
const detailSchema = successSchema.extend({ card: catalogueDetailViewSchema });
const collectionSchema = successSchema.merge(collectionMutationResultSchema);
const bindersSchema = successSchema.extend({ binders: z.array(binderViewSchema) });
const binderPagesEnvelopeSchema = successSchema.extend({ binder: binderVersionPagesSchema });
const binderMutationEnvelopeSchema = successSchema.extend({ binder: binderMutationResultSchema });
const shortagePageSchema = successSchema.extend({
  shortages: z.array(binderShortageSchema),
  nextOffset: z.number().int().nonnegative().nullable(),
});
const setsSchema = successSchema.extend({
  sets: z.array(
    z
      .object({
        setId: z.string(),
        setName: z.string(),
        language: z.string(),
        total: z.number(),
        owned: z.number(),
      })
      .strict(),
  ),
});
const speciesSchema = successSchema.extend({
  species: z.array(
    z
      .object({
        species: z.string(),
        total: z.number(),
        owned: z.number(),
        languages: z.array(z.string()),
      })
      .strict(),
  ),
});
const tokenSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    scopes: z.array(z.string()).optional(),
    createdAt: z.string().optional(),
    expiresAt: z.string().nullable().optional(),
    revokedAt: z.string().nullable().optional(),
    lastUsedAt: z.string().nullable().optional(),
  })
  .passthrough();
const tokensSchema = successSchema.extend({ tokens: z.array(tokenSchema) });
const pairCodeSchema = successSchema.extend({
  code: z.string().min(8).max(64),
  expiresAt: z.string().datetime().optional(),
});

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? { ...value } : null;
}

const authenticationOptionsSchema = z.custom<PublicKeyCredentialRequestOptionsJSON>((value) => {
  const candidate = record(value);
  return (
    candidate !== null &&
    typeof candidate.challenge === 'string' &&
    (candidate.rpId === undefined || typeof candidate.rpId === 'string') &&
    (candidate.allowCredentials === undefined || Array.isArray(candidate.allowCredentials))
  );
});

const registrationOptionsSchema = z.custom<PublicKeyCredentialCreationOptionsJSON>((value) => {
  const candidate = record(value);
  return (
    candidate !== null &&
    typeof candidate.challenge === 'string' &&
    record(candidate.rp) !== null &&
    record(candidate.user) !== null
  );
});

export type Dashboard = z.infer<typeof dashboardSchema>;
export type DesktopToken = z.infer<typeof tokenSchema>;
export type PairingCode = z.infer<typeof pairCodeSchema>;
export type SetFacet = z.infer<typeof setsSchema>['sets'][number];
export type SpeciesFacet = z.infer<typeof speciesSchema>['species'][number];

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly requestId: string | null,
    public readonly retryAfterSeconds: number | null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function purgePrivateCaches(): Promise<void> {
  navigator.serviceWorker?.controller?.postMessage({ type: 'PURGE_PRIVATE_CACHES' });
  if (!('caches' in globalThis)) return;
  const names = await caches.keys();
  await Promise.all(
    names.filter((name) => name.startsWith('pokedex-')).map(async (name) => caches.delete(name)),
  );
}

async function request<Output, Definition extends z.ZodTypeDef, Input>(
  path: string,
  schema: z.ZodType<Output, Definition, Input>,
  init: RequestInit = {},
): Promise<Output> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('content-type'))
    headers.set('content-type', 'application/json');
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers,
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new ApiError(
      'invalid_response',
      cause instanceof Error ? cause.message : 'The server response was not valid JSON.',
      response.status,
      response.headers.get('x-request-id'),
      null,
    );
  }
  const failure = apiErrorSchema.safeParse(body);
  if (!response.ok || failure.success) {
    const code = failure.success ? failure.data.error : 'invalid_response';
    const requestId = failure.success
      ? (failure.data.requestId ?? response.headers.get('x-request-id'))
      : response.headers.get('x-request-id');
    const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
    if (response.status === 401) await purgePrivateCaches();
    throw new ApiError(
      code,
      failure.success ? (failure.data.message ?? code) : 'The server returned an invalid response.',
      response.status,
      requestId,
      Number.isFinite(retryAfter) ? retryAfter : null,
    );
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new ApiError(
      'invalid_response',
      'The server returned an unexpected response.',
      response.status,
      response.headers.get('x-request-id'),
      null,
    );
  return schema.parse(body);
}

const json = (body: unknown): string => JSON.stringify(body);
const encoded = (value: string): string => encodeURIComponent(value);

export const api = {
  me: (signal?: AbortSignal): Promise<z.infer<typeof sessionSchema>> =>
    request('/api/auth/me', sessionSchema, { signal }),
  devLogin: (): Promise<void> =>
    request('/api/auth/dev-login', successSchema, { method: 'POST' }).then(() => undefined),
  authenticationOptions: (): Promise<PublicKeyCredentialRequestOptionsJSON> =>
    request('/api/auth/passkey/auth/options', authenticationOptionsSchema, { method: 'POST' }),
  verifyAuthentication: (response: AuthenticationResponseJSON): Promise<void> =>
    request('/api/auth/passkey/auth/verify', successSchema, {
      method: 'POST',
      body: json({ response }),
    }).then(() => undefined),
  registrationOptions: (enrolSecret: string): Promise<PublicKeyCredentialCreationOptionsJSON> =>
    request('/api/auth/passkey/register/options', registrationOptionsSchema, {
      method: 'POST',
      headers: { 'x-enrol-secret': enrolSecret },
    }),
  verifyRegistration: (
    response: RegistrationResponseJSON,
    enrolSecret: string,
    name: string,
  ): Promise<void> =>
    request('/api/auth/passkey/register/verify', successSchema, {
      method: 'POST',
      body: json({ response, enrolSecret, name }),
    }).then(() => undefined),
  dashboard: (signal?: AbortSignal): Promise<Dashboard> =>
    request('/api/dashboard', dashboardSchema, { signal }),
  search: (params: URLSearchParams, signal?: AbortSignal): Promise<z.infer<typeof searchSchema>> =>
    request(`/api/catalogue/search?${params}`, searchSchema, { signal }),
  sets: (signal?: AbortSignal): Promise<SetFacet[]> =>
    request('/api/catalogue/facets/sets', setsSchema, { signal }).then((body) => body.sets),
  species: (signal?: AbortSignal): Promise<SpeciesFacet[]> =>
    request('/api/catalogue/facets/species', speciesSchema, { signal }).then(
      (body) => body.species,
    ),
  card: (id: string, signal?: AbortSignal): Promise<CatalogueDetailView> =>
    request(`/api/catalogue/${encoded(id)}`, detailSchema, { signal }).then((body) => body.card),
  createCustomCard: (input: {
    name: string;
    language: string;
    category: string;
    setId: string;
    setName: string;
    number: string;
  }): Promise<string> =>
    request('/api/catalogue/custom', successSchema.extend({ id: z.string() }), {
      method: 'POST',
      body: json(input),
    }).then((body) => body.id),
  setCollection: (cardId: string, input: CollectionSetRequest): Promise<CollectionState> =>
    request(`/api/collection/${encoded(cardId)}`, collectionSchema, {
      method: 'PUT',
      body: json(collectionSetRequestSchema.parse(input)),
    }).then((body) => body.state),
  incrementCollection: (
    cardId: string,
    input: CollectionIncrementRequest,
  ): Promise<CollectionState> =>
    request(`/api/collection/${encoded(cardId)}/increment`, collectionSchema, {
      method: 'POST',
      body: json(collectionIncrementRequestSchema.parse(input)),
    }).then((body) => body.state),
  patchCollectionNotes: (
    cardId: string,
    input: CollectionNotesPatchRequest,
  ): Promise<CollectionState> =>
    request(`/api/collection/${encoded(cardId)}/notes`, collectionSchema, {
      method: 'PATCH',
      body: json(collectionNotesPatchRequestSchema.parse(input)),
    }).then((body) => body.state),
  binders: (signal?: AbortSignal): Promise<BinderView[]> =>
    request('/api/binders', bindersSchema, { signal }).then((body) => body.binders),
  binder: (id: string, page = 0, limit = 1, signal?: AbortSignal): Promise<BinderVersionPages> =>
    request(
      `/api/binders/versions/${encoded(id)}?page=${page}&limit=${limit}`,
      binderPagesEnvelopeSchema,
      { signal },
    ).then((body) => body.binder),
  binderShortages: (
    id: string,
    offset = 0,
    limit = 100,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof shortagePageSchema>> =>
    request(
      `/api/binders/versions/${encoded(id)}/shortages?offset=${offset}&limit=${limit}`,
      shortagePageSchema,
      { signal },
    ),
  createBinder: (name: string, layout: BinderLayout): Promise<BinderMutationResult> =>
    request('/api/binders', binderMutationEnvelopeSchema, {
      method: 'POST',
      body: json({ name, layout: binderLayoutSchema.parse(layout) }),
    }).then((body) => body.binder),
  cloneBinder: (id: string, expectedRevision: number): Promise<BinderMutationResult> =>
    request(`/api/binders/versions/${encoded(id)}/clone`, binderMutationEnvelopeSchema, {
      method: 'POST',
      body: json({ expectedRevision }),
    }).then((body) => body.binder),
  activateBinder: (id: string, expectedRevision: number): Promise<BinderMutationResult> =>
    request(`/api/binders/versions/${encoded(id)}/activate`, binderMutationEnvelopeSchema, {
      method: 'POST',
      body: json({ expectedRevision }),
    }).then((body) => body.binder),
  setSlot: (
    id: string,
    input: {
      expectedRevision: number;
      page: number;
      row: number;
      column: number;
      cardId: string | null;
    },
  ): Promise<BinderMutationResult> =>
    request(`/api/binders/versions/${encoded(id)}/slot`, binderMutationEnvelopeSchema, {
      method: 'PUT',
      body: json(input),
    }).then((body) => body.binder),
  swapSlots: (
    id: string,
    input: {
      expectedRevision: number;
      source: BinderSlotLocation;
      target: BinderSlotLocation;
    },
  ): Promise<BinderMutationResult> =>
    request(`/api/binders/versions/${encoded(id)}/swap`, binderMutationEnvelopeSchema, {
      method: 'POST',
      body: json(input),
    }).then((body) => body.binder),
  addPage: (id: string, expectedRevision: number): Promise<BinderMutationResult> =>
    request(`/api/binders/versions/${encoded(id)}/pages`, binderMutationEnvelopeSchema, {
      method: 'POST',
      body: json({ expectedRevision }),
    }).then((body) => body.binder),
  reorderPages: (
    id: string,
    pageIds: string[],
    expectedRevision: number,
  ): Promise<BinderMutationResult> =>
    request(`/api/binders/versions/${encoded(id)}/pages/order`, binderMutationEnvelopeSchema, {
      method: 'PUT',
      body: json({ pageIds, expectedRevision }),
    }).then((body) => body.binder),
  deletePage: (
    id: string,
    pageId: string,
    expectedRevision: number,
  ): Promise<BinderMutationResult> =>
    request(
      `/api/binders/versions/${encoded(id)}/pages/${encoded(pageId)}`,
      binderMutationEnvelopeSchema,
      {
        method: 'DELETE',
        body: json({ expectedRevision }),
      },
    ).then((body) => body.binder),
  arrangeBinder: (
    id: string,
    mode: 'set-number' | 'release-date' | 'pokedex-number' | 'language',
    expectedRevision: number,
  ): Promise<BinderMutationResult> =>
    request(`/api/binders/versions/${encoded(id)}/arrange`, binderMutationEnvelopeSchema, {
      method: 'POST',
      body: json({ mode, expectedRevision }),
    }).then((body) => body.binder),
  pair: (): Promise<PairingCode> =>
    request('/api/desktop/pair', pairCodeSchema, {
      method: 'POST',
      body: json({
        scopes: ['art:read', 'art:write', 'catalogue:read', 'collection:write', 'binders:write'],
      }),
    }),
  tokens: (signal?: AbortSignal): Promise<DesktopToken[]> =>
    request('/api/desktop/tokens', tokensSchema, { signal }).then((body) => body.tokens),
  revokeToken: (id: string): Promise<void> =>
    request(`/api/desktop/tokens/${encoded(id)}`, successSchema, {
      method: 'DELETE',
    }).then(() => undefined),
};

export type {
  BinderLayout,
  BinderMutationResult,
  BinderVersionPages,
  BinderView,
  CatalogueCardView,
  CatalogueDetailView,
  CollectionState,
};
