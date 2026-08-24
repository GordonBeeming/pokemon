import {
  apiErrorSchema,
  binderLayoutSchema,
  binderSlotSchema,
  catalogueCardViewSchema,
  catalogueDetailViewSchema,
  collectionStateSchema,
  mutationRequestSchema,
} from '@pokedex/shared';
import type {
  BinderLayout,
  BinderSlot,
  CatalogueCardView,
  CatalogueDetailView,
  CollectionState,
} from '@pokedex/shared';
import { z } from 'zod';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser';

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
  activeShortages: z.array(
    z
      .object({ cardId: z.string(), required: z.number(), owned: z.number(), missing: z.number() })
      .strict(),
  ),
});
const searchSchema = successSchema.extend({
  total: z.number().int().nonnegative(),
  cards: z.array(catalogueCardViewSchema),
});
const detailSchema = successSchema.extend({ card: catalogueDetailViewSchema });
const collectionSchema = successSchema.extend({ state: collectionStateSchema });
const binderSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    activeVersionId: z.string().nullable(),
    latestVersionId: z.string().nullable(),
    updatedAt: z.string(),
  })
  .strict();
const binderVersionSchema = z
  .object({
    id: z.string(),
    binderId: z.string(),
    versionNumber: z.number(),
    status: z.enum(['draft', 'active', 'archived']),
    layout: binderLayoutSchema,
    slots: z.array(binderSlotSchema),
    shortages: z.array(
      z
        .object({
          cardId: z.string(),
          required: z.number(),
          owned: z.number(),
          missing: z.number(),
        })
        .strict(),
    ),
  })
  .strict();
const bindersSchema = successSchema.extend({ binders: z.array(binderSchema) });
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
const versionSchema = successSchema.extend({ binder: binderVersionSchema });
const tokenSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    createdAt: z.string().optional(),
    lastUsedAt: z.string().nullable().optional(),
  })
  .passthrough();
const tokensSchema = successSchema.extend({ tokens: z.array(tokenSchema) });

export type Dashboard = z.infer<typeof dashboardSchema>;
export type Binder = z.infer<typeof binderSchema>;
export type BinderVersion = z.infer<typeof binderVersionSchema>;
export type DesktopToken = z.infer<typeof tokenSchema>;

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<TOutput, TDef extends z.ZodTypeDef, TInput>(
  path: string,
  schema: z.ZodType<TOutput, TDef, TInput>,
  init?: RequestInit,
): Promise<TOutput> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  const body: unknown = await response.json().catch(() => null);
  const failure = apiErrorSchema.safeParse(body);
  if (!response.ok || failure.success)
    throw new ApiError(
      failure.success ? failure.data.error : 'invalid_response',
      failure.success
        ? (failure.data.message ?? failure.data.error)
        : 'The server returned an invalid response.',
    );
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new ApiError('invalid_response', 'The server returned an unexpected response.');
  return schema.parse(body);
}

export const api = {
  me: (): Promise<z.infer<typeof sessionSchema>> => request('/api/auth/me', sessionSchema),
  devLogin: (): Promise<void> =>
    request('/api/auth/dev-login', successSchema, { method: 'POST' }).then(() => undefined),
  authenticationOptions: (): Promise<PublicKeyCredentialRequestOptionsJSON> =>
    request('/api/auth/passkey/auth/options', z.custom<PublicKeyCredentialRequestOptionsJSON>(), {
      method: 'POST',
    }),
  verifyAuthentication: (response: AuthenticationResponseJSON): Promise<void> =>
    request('/api/auth/passkey/auth/verify', successSchema, {
      method: 'POST',
      body: JSON.stringify({ response }),
    }).then(() => undefined),
  registrationOptions: (enrolSecret: string): Promise<PublicKeyCredentialCreationOptionsJSON> =>
    request(
      '/api/auth/passkey/register/options',
      z.custom<PublicKeyCredentialCreationOptionsJSON>(),
      { method: 'POST', headers: { 'x-enrol-secret': enrolSecret } },
    ),
  verifyRegistration: (
    response: RegistrationResponseJSON,
    enrolSecret: string,
    name: string,
  ): Promise<void> =>
    request('/api/auth/passkey/register/verify', successSchema, {
      method: 'POST',
      body: JSON.stringify({ response, enrolSecret, name }),
    }).then(() => undefined),
  dashboard: (): Promise<Dashboard> => request('/api/dashboard', dashboardSchema),
  search: (params: URLSearchParams): Promise<z.infer<typeof searchSchema>> =>
    request(`/api/catalogue/search?${params}`, searchSchema),
  sets: () => request('/api/catalogue/facets/sets', setsSchema).then((body) => body.sets),
  species: () =>
    request('/api/catalogue/facets/species', speciesSchema).then((body) => body.species),
  card: (id: string): Promise<CatalogueDetailView> =>
    request(`/api/catalogue/${encodeURIComponent(id)}`, detailSchema).then((body) => body.card),
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
      body: JSON.stringify(input),
    }).then((body) => body.id),
  setCollection: (
    cardId: string,
    quantity: number,
    notes: string | null,
    mutationId: string,
  ): Promise<CollectionState> =>
    request(`/api/collection/${encodeURIComponent(cardId)}`, collectionSchema, {
      method: 'PUT',
      body: JSON.stringify(
        mutationRequestSchema
          .extend({ quantity: z.number().int().min(0), notes: z.string().nullable() })
          .parse({ mutationId, quantity, notes }),
      ),
    }).then((body) => body.state),
  binders: (): Promise<Binder[]> =>
    request('/api/binders', bindersSchema).then((body) => body.binders),
  binder: (id: string): Promise<BinderVersion> =>
    request(`/api/binders/versions/${encodeURIComponent(id)}`, versionSchema).then(
      (body) => body.binder,
    ),
  createBinder: (name: string, layout: BinderLayout): Promise<BinderVersion> =>
    request('/api/binders', versionSchema, {
      method: 'POST',
      body: JSON.stringify({ name, layout }),
    }).then((body) => body.binder),
  cloneBinder: (id: string): Promise<BinderVersion> =>
    request(`/api/binders/versions/${encodeURIComponent(id)}/clone`, versionSchema, {
      method: 'POST',
    }).then((body) => body.binder),
  activateBinder: (id: string): Promise<BinderVersion> =>
    request(`/api/binders/versions/${encodeURIComponent(id)}/activate`, versionSchema, {
      method: 'POST',
    }).then((body) => body.binder),
  setSlot: (
    id: string,
    page: number,
    row: number,
    column: number,
    cardId: string | null,
  ): Promise<BinderVersion> =>
    request(`/api/binders/versions/${encodeURIComponent(id)}/slot`, versionSchema, {
      method: 'PUT',
      body: JSON.stringify({ page, row, column, cardId }),
    }).then((body) => body.binder),
  addPage: (id: string): Promise<BinderVersion> =>
    request(`/api/binders/versions/${encodeURIComponent(id)}/pages`, versionSchema, {
      method: 'POST',
    }).then((body) => body.binder),
  reorderPages: (id: string, pageIds: string[]): Promise<BinderVersion> =>
    request(`/api/binders/versions/${encodeURIComponent(id)}/pages/order`, versionSchema, {
      method: 'PUT',
      body: JSON.stringify({ pageIds }),
    }).then((body) => body.binder),
  deletePage: (id: string, pageId: string): Promise<BinderVersion> =>
    request(
      `/api/binders/versions/${encodeURIComponent(id)}/pages/${encodeURIComponent(pageId)}`,
      versionSchema,
      { method: 'DELETE' },
    ).then((body) => body.binder),
  arrangeBinder: (
    id: string,
    mode: 'set-number' | 'release-date' | 'pokedex-number' | 'language',
  ): Promise<BinderVersion> =>
    request(`/api/binders/versions/${encodeURIComponent(id)}/arrange`, versionSchema, {
      method: 'POST',
      body: JSON.stringify({ mode }),
    }).then((body) => body.binder),
  pair: (): Promise<string> =>
    request('/api/desktop/pair', successSchema.extend({ code: z.string() }), {
      method: 'POST',
      body: JSON.stringify({
        scopes: ['art:read', 'art:write', 'catalogue:read', 'collection:write', 'binders:write'],
      }),
    }).then((body) => body.code),
  tokens: (): Promise<DesktopToken[]> =>
    request('/api/desktop/tokens', tokensSchema).then((body) => body.tokens),
  revokeToken: (id: string): Promise<void> =>
    request(`/api/desktop/tokens/${encodeURIComponent(id)}`, successSchema, {
      method: 'DELETE',
    }).then(() => undefined),
};

export type { BinderLayout, BinderSlot, CatalogueCardView, CatalogueDetailView };
