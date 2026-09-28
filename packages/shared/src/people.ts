import { z } from 'zod';

export const userRoleSchema = z.enum(['admin', 'member']);
export type UserRole = z.infer<typeof userRoleSchema>;

export const meResponseSchema = z
  .object({
    sub: z.string().min(1),
    label: z.string().min(1),
    role: userRoleSchema,
  })
  .strict();
export type MeResponse = z.infer<typeof meResponseSchema>;

export const personSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    role: userRoleSchema,
    disabledAt: z.string().nullable(),
    createdAt: z.string(),
    passkeyCount: z.number().int().nonnegative(),
    lastUsedAt: z.string().nullable(),
  })
  .strict();
export type Person = z.infer<typeof personSchema>;

export const peopleListResponseSchema = z.object({ people: z.array(personSchema) }).strict();
export type PeopleListResponse = z.infer<typeof peopleListResponseSchema>;

export const patchPersonRequestSchema = z
  .object({
    role: userRoleSchema.optional(),
    disabled: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.role !== undefined || value.disabled !== undefined, {
    message: 'patch_person_empty',
  });
export type PatchPersonRequest = z.infer<typeof patchPersonRequestSchema>;

export const createInviteRequestSchema = z
  .object({
    label: z.string().trim().min(1).max(120).optional(),
    role: userRoleSchema,
  })
  .strict();
export type CreateInviteRequest = z.infer<typeof createInviteRequestSchema>;

export const createInviteResponseSchema = z
  .object({ id: z.string().min(1), inviteUrl: z.string().min(1), expiresAt: z.string() })
  .strict();
export type CreateInviteResponse = z.infer<typeof createInviteResponseSchema>;

export const inviteSummarySchema = z
  .object({
    id: z.string().min(1),
    role: userRoleSchema,
    label: z.string().nullable(),
    createdAt: z.string(),
    expiresAt: z.string(),
    redeemedAt: z.string().nullable(),
    redeemedBy: z.string().nullable(),
    cancelledAt: z.string().nullable(),
  })
  .strict();
export type InviteSummary = z.infer<typeof inviteSummarySchema>;

export const inviteListResponseSchema = z
  .object({ invites: z.array(inviteSummarySchema) })
  .strict();
export type InviteListResponse = z.infer<typeof inviteListResponseSchema>;

// The public invite-landing lookup deliberately never reveals which of
// "expired" or "used" applies once `valid` is false beyond these two flags —
// both are terminal states the SPA renders as "ask for a new link".
export const invitePublicStatusSchema = z
  .object({
    valid: z.boolean(),
    expired: z.boolean(),
    used: z.boolean(),
    label: z.string().nullable(),
    // Only populated when valid is true — an expired/used/unknown link has
    // nothing left worth showing beyond "get a new one".
    role: userRoleSchema.nullable(),
    expiresAt: z.string().nullable(),
    invitedBy: z.string().nullable(),
  })
  .strict();
export type InvitePublicStatus = z.infer<typeof invitePublicStatusSchema>;

// Matches the 64 lowercase-hex shape of a desktop pairing token, so the
// same "long random string" affordance covers both.
export const inviteTokenSchema = z
  .string()
  .trim()
  .regex(/^[a-f0-9]{64}$/u);

export const PEOPLE_ERROR_CODES = [
  'user_disabled',
  'last_admin',
  'invite_expired',
  'invite_used',
] as const;
export type PeopleErrorCode = (typeof PEOPLE_ERROR_CODES)[number];
