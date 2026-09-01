import {
  DESKTOP_SCOPES,
  apiErrorSchema,
  artUrlSchema,
  binderLayoutSchema,
  binderAssignmentCandidatesSchema,
  binderFullPokedexPreviewSchema,
  binderFullPokedexRequestSchema,
  binderPokemonShortageSchema,
  binderMutationResultSchema,
  binderPageSchema,
  binderPlannerSummarySchema,
  binderReadyToPlaceSchema,
  binderShortageSchema,
  binderSlotSchema,
  binderVersionPagesSchema,
  binderVersionSummarySchema,
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
  BinderEntry,
  BinderAssignmentCandidate,
  BinderMutationResult,
  BinderSlotLocation,
  ApiErrorDetails,
  BinderFullPokedexPreview,
  BinderPlannerSummary,
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
  activePokemonShortages: z.array(binderPokemonShortageSchema).optional().default([]),
  cards: z.array(catalogueCardViewSchema),
});
const searchSchema = successSchema.extend({
  total: z.number().int().nonnegative(),
  cards: z.array(catalogueCardViewSchema),
  cursor: z.string().nullable(),
});
const detailSchema = successSchema.extend({ card: catalogueDetailViewSchema });
const collectionSchema = successSchema.merge(collectionMutationResultSchema);
// Browser tabs can remain open across a Worker deployment. Ignore additive
// response fields so a newer server does not break an older loaded client.
const binderViewResponseSchema = binderViewSchema.passthrough();
const binderSlotResponseSchema = binderSlotSchema.passthrough();
const binderPageResponseSchema = binderPageSchema
  .extend({ slots: z.array(binderSlotResponseSchema).max(400) })
  .passthrough();
const binderVersionSummaryResponseSchema = binderVersionSummarySchema.passthrough();
const binderVersionPagesResponseSchema = binderVersionPagesSchema
  .extend({
    version: binderVersionSummaryResponseSchema,
    pages: z.array(binderPageResponseSchema).max(4),
  })
  .passthrough();
const binderMutationResultResponseSchema = binderMutationResultSchema
  .extend({
    version: binderVersionSummaryResponseSchema,
    pages: z.array(binderPageResponseSchema).max(2),
  })
  .passthrough();
const bindersSchema = successSchema.extend({ binders: z.array(binderViewResponseSchema) });
const binderPagesEnvelopeSchema = successSchema.extend({
  binder: binderVersionPagesResponseSchema,
});
const binderMutationEnvelopeSchema = successSchema.extend({
  binder: binderMutationResultResponseSchema,
});
const binderAssignmentCandidatesEnvelopeSchema = successSchema.extend({
  candidates: binderAssignmentCandidatesSchema.shape.candidates,
});
const binderPlannerSummaryEnvelopeSchema = successSchema.extend({
  summary: binderPlannerSummarySchema,
});
const binderFullPokedexPreviewEnvelopeSchema = successSchema.extend({
  preview: binderFullPokedexPreviewSchema,
});
const binderCardsEnvelopeSchema = binderMutationEnvelopeSchema.extend({
  added: z.number().int().positive(),
});
const workflowStartedSchema = successSchema.extend({ workflowId: z.string().min(1) });
const catalogueSyncStatusSchema = successSchema.extend({ status: z.string().min(1) });
const nationalRepresentativesSchema = successSchema.extend({
  representatives: z.array(
    z.object({ number: z.number().int().min(1).max(1025), cardId: z.string().min(1) }).strict(),
  ),
});
const shortagePageSchema = successSchema.extend({
  shortages: z.array(binderShortageSchema),
  pokemonShortages: z.array(binderPokemonShortageSchema),
  readyToPlace: binderReadyToPlaceSchema,
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
const nationalPokedexSchema = successSchema.extend({
  entries: z.array(
    z
      .object({
        number: z.number().int().min(1).max(1025),
        totalCards: z.number().int().nonnegative(),
        ownedCards: z.number().int().nonnegative(),
        types: z.array(z.string()),
        representative: z
          .object({
            cardId: z.string(),
            cardName: z.string(),
            setName: z.string(),
            number: z.string(),
            imageLowUrl: artUrlSchema,
            imageHighUrl: artUrlSchema,
            explicit: z.boolean(),
          })
          .strict(),
      })
      .strict(),
  ),
});
const nationalPokedexPreviewsSchema = successSchema.extend({
  previews: z.array(
    z
      .object({
        name: z.string(),
        sourceId: z.string().min(1),
        imageLowUrl: z.string().regex(/^\/api\/art\/preview\/low\?source=/u),
        imageHighUrl: z.string().regex(/^\/api\/art\/preview\/high\?source=/u),
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
export type NationalPokedexCoverage = z.infer<typeof nationalPokedexSchema>['entries'][number];
export type NationalPokedexPreview = z.infer<
  typeof nationalPokedexPreviewsSchema
>['previews'][number];

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly requestId: string | null,
    public readonly retryAfterSeconds: number | null,
    public readonly details: ApiErrorDetails | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const AUTH_LOST_EVENT = 'pokedex:authentication-lost';

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
    if (response.status === 401) {
      await purgePrivateCaches();
      if (typeof globalThis.dispatchEvent === 'function')
        globalThis.dispatchEvent(new Event(AUTH_LOST_EVENT));
    }
    throw new ApiError(
      code,
      failure.success ? (failure.data.message ?? code) : 'The server returned an invalid response.',
      response.status,
      requestId,
      Number.isFinite(retryAfter) ? retryAfter : null,
      failure.success ? (failure.data.details ?? null) : null,
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
  resolveCards: (cardIds: string[], signal?: AbortSignal): Promise<CatalogueCardView[]> =>
    request(
      '/api/catalogue/cards/resolve',
      successSchema.extend({ cards: z.array(catalogueCardViewSchema) }),
      {
        method: 'POST',
        body: json({ cardIds }),
        signal,
      },
    ).then((body) => body.cards),
  sets: (signal?: AbortSignal): Promise<SetFacet[]> =>
    request('/api/catalogue/facets/sets', setsSchema, { signal }).then((body) => body.sets),
  species: (signal?: AbortSignal): Promise<SpeciesFacet[]> =>
    request('/api/catalogue/facets/species', speciesSchema, { signal }).then(
      (body) => body.species,
    ),
  nationalPokedex: (signal?: AbortSignal): Promise<NationalPokedexCoverage[]> =>
    request('/api/catalogue/national', nationalPokedexSchema, { signal }).then(
      (body) => body.entries,
    ),
  nationalPokedexPreviews: (
    names: string[],
    signal?: AbortSignal,
  ): Promise<NationalPokedexPreview[]> =>
    request('/api/catalogue/national/previews', nationalPokedexPreviewsSchema, {
      method: 'POST',
      body: json({ names }),
      signal,
    }).then((body) => body.previews),
  discoverSpecies: (number: number, name: string): Promise<number> =>
    request('/api/catalogue/national/discover', successSchema.extend({ imported: z.number() }), {
      method: 'POST',
      body: json({ number, name }),
    }).then((body) => body.imported),
  setNationalRepresentative: (number: number, cardId: string): Promise<void> =>
    request(`/api/catalogue/national/${number}/representative`, successSchema, {
      method: 'PUT',
      body: json({ cardId }),
    }).then(() => undefined),
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
  plannerSummary: (id: string, signal?: AbortSignal): Promise<BinderPlannerSummary> =>
    request(
      `/api/binders/versions/${encoded(id)}/planner-summary`,
      binderPlannerSummaryEnvelopeSchema,
      { signal },
    ).then((body) => body.summary),
  createBinder: (
    name: string,
    layout: BinderLayout,
    capacity: number,
  ): Promise<BinderMutationResult> =>
    request('/api/binders', binderMutationEnvelopeSchema, {
      method: 'POST',
      body: json({ name, layout: binderLayoutSchema.parse(layout), capacity }),
    }).then((body) => body.binder),
  addCardsToBinder: (
    id: string,
    cardIds: string[],
    expectedRevision: number,
  ): Promise<{ binder: BinderMutationResult; added: number }> =>
    request(`/api/binders/versions/${encoded(id)}/cards`, binderCardsEnvelopeSchema, {
      method: 'POST',
      body: json({ cardIds, expectedRevision }),
    }).then((body) => ({ binder: body.binder, added: body.added })),
  setBinderCards: (
    id: string,
    assignments: Array<BinderSlotLocation & { cardId: string }>,
    expectedRevision: number,
  ): Promise<BinderMutationResult> =>
    request(`/api/binders/versions/${encoded(id)}/cards`, binderMutationEnvelopeSchema, {
      method: 'PUT',
      body: json({ assignments, expectedRevision }),
    }).then((body) => body.binder),
  assignmentCandidates: (
    id: string,
    at: BinderSlotLocation,
    signal?: AbortSignal,
  ): Promise<BinderAssignmentCandidate[]> =>
    request(
      `/api/binders/versions/${encoded(id)}/assignment-candidates?${new URLSearchParams({
        page: String(at.page),
        row: String(at.row),
        column: String(at.column),
      })}`,
      binderAssignmentCandidatesEnvelopeSchema,
      { signal },
    ).then((body) => body.candidates),
  insertEntries: (
    id: string,
    at: BinderSlotLocation,
    entries: BinderEntry[],
    expectedRevision: number,
  ): Promise<BinderMutationResult> =>
    request(`/api/binders/versions/${encoded(id)}/entries/insert`, binderMutationEnvelopeSchema, {
      method: 'POST',
      body: json({ at, entries, expectedRevision }),
    }).then((body) => body.binder),
  removeEntry: (
    id: string,
    at: BinderSlotLocation,
    expectedRevision: number,
  ): Promise<BinderMutationResult> =>
    request(`/api/binders/versions/${encoded(id)}/entries/remove`, binderMutationEnvelopeSchema, {
      method: 'POST',
      body: json({ at, expectedRevision }),
    }).then((body) => body.binder),
  moveEntry: (
    id: string,
    from: BinderSlotLocation,
    offset: number,
    expectedRevision: number,
  ): Promise<BinderMutationResult> =>
    request(`/api/binders/versions/${encoded(id)}/entries/move`, binderMutationEnvelopeSchema, {
      method: 'POST',
      body: json({ from, offset, expectedRevision }),
    }).then((body) => body.binder),
  assignEntry: (
    id: string,
    at: BinderSlotLocation,
    cardId: string | null,
    expectedRevision: number,
  ): Promise<BinderMutationResult> =>
    request(`/api/binders/versions/${encoded(id)}/assignment`, binderMutationEnvelopeSchema, {
      method: 'PUT',
      body: json({ at, cardId, expectedRevision }),
    }).then((body) => body.binder),
  setPageBreak: (
    id: string,
    at: BinderSlotLocation,
    startsNewPage: boolean,
    expectedRevision: number,
  ): Promise<BinderMutationResult> =>
    request(`/api/binders/versions/${encoded(id)}/page-break`, binderMutationEnvelopeSchema, {
      method: 'PUT',
      body: json({ at, startsNewPage, expectedRevision }),
    }).then((body) => body.binder),
  reservePage: (
    id: string,
    page: number,
    reserved: boolean,
    label: string | null | undefined,
    expectedRevision: number,
  ): Promise<BinderMutationResult> =>
    request(`/api/binders/versions/${encoded(id)}/reserved-page`, binderMutationEnvelopeSchema, {
      method: 'PUT',
      body: json({ page, reserved, label, expectedRevision }),
    }).then((body) => body.binder),
  resizeBinder: (
    id: string,
    capacity: number,
    expectedRevision: number,
  ): Promise<BinderMutationResult> =>
    request(`/api/binders/versions/${encoded(id)}/capacity`, binderMutationEnvelopeSchema, {
      method: 'PUT',
      body: json({ capacity, expectedRevision }),
    }).then((body) => body.binder),
  insertFullPokedex: (
    id: string,
    at: BinderSlotLocation,
    regionPageBreaks: boolean,
    expectedRevision: number,
  ): Promise<BinderMutationResult> =>
    request(`/api/binders/versions/${encoded(id)}/full-pokedex`, binderMutationEnvelopeSchema, {
      method: 'POST',
      body: json({ at, regionPageBreaks, expectedRevision }),
    }).then((body) => body.binder),
  previewFullPokedex: (
    id: string,
    at: BinderSlotLocation,
    regionPageBreaks: boolean,
    expectedRevision: number,
    signal?: AbortSignal,
  ): Promise<BinderFullPokedexPreview> =>
    request(
      `/api/binders/versions/${encoded(id)}/full-pokedex/preview`,
      binderFullPokedexPreviewEnvelopeSchema,
      {
        method: 'POST',
        signal,
        body: json(
          binderFullPokedexRequestSchema.parse({ at, regionPageBreaks, expectedRevision }),
        ),
      },
    ).then((body) => body.preview),
  startCatalogueSync: (signal?: AbortSignal): Promise<string> =>
    request('/api/catalogue/full-sync', workflowStartedSchema, { method: 'POST', signal }).then(
      (body) => body.workflowId,
    ),
  catalogueSyncStatus: (id: string, signal?: AbortSignal): Promise<string> =>
    request(`/api/catalogue/full-sync/${encoded(id)}`, catalogueSyncStatusSchema, { signal }).then(
      (body) => body.status,
    ),
  resolveNationalRepresentatives: (
    choices: Array<{ number: number; name: string; sourceId: string }>,
  ): Promise<Array<{ number: number; cardId: string }>> =>
    request('/api/catalogue/national/representatives', nationalRepresentativesSchema, {
      method: 'POST',
      body: json({ choices }),
    }).then((body) => body.representatives),
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
        scopes: [...DESKTOP_SCOPES],
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
  BinderEntry,
  BinderAssignmentCandidate,
  BinderFullPokedexPreview,
  BinderMutationResult,
  BinderPlannerSummary,
  BinderVersionPages,
  BinderView,
  CatalogueCardView,
  CatalogueDetailView,
  CollectionState,
};
