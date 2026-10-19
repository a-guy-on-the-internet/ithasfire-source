import { z } from "zod";

import { API_KEY_ACCESS_LEVELS, API_KEY_SUBJECTS } from "@th/types";

import {
  sanitizePlainText,
  sanitizePlainTextMultiline,
} from "../../lib/sanitize-plain-text";

export const createApiKeyInputSchema = z.object({
  actorHumanId: z.string(),
  label: z.string().max(100).optional(),
});

export const createApiKeyOutputSchema = z.object({
  id: z.string(),
  key: z.string(),
  label: z.union([z.string(), z.null()]),
  createdAt: z.date(),
});

export type CreateApiKeyInput = z.infer<typeof createApiKeyInputSchema>;
export type CreateApiKeyOutput = z.infer<typeof createApiKeyOutputSchema>;

export const listApiKeysInputSchema = z.object({
  actorHumanId: z.string(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
});

export const listApiKeysOutputSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      label: z.union([z.string(), z.null()]),
      createdAt: z.date(),
      lastUsedAt: z.union([z.date(), z.null()]),
      revokedAt: z.union([z.date(), z.null()]),
    }),
  ),
  pageInfo: z.object({
    total: z.number(),
    count: z.number(),
    limit: z.number(),
    offset: z.number(),
    hasNextPage: z.boolean(),
    nextOffset: z.union([z.number(), z.null()]),
  }),
});

export type ListApiKeysInput = z.infer<typeof listApiKeysInputSchema>;
export type ListApiKeysOutput = z.infer<typeof listApiKeysOutputSchema>;

export const revokeApiKeyInputSchema = z.object({
  actorHumanId: z.string(),
  apiKeyId: z.string().uuid(),
});

export type RevokeApiKeyInput = z.infer<typeof revokeApiKeyInputSchema>;

// ════════════════════════════════════════════════════════════════════════════
// Scoped API keys (docs/specs/2026-10-08/scoped-api-keys.spec.yaml)
// ════════════════════════════════════════════════════════════════════════════
//
// The legacy schemas above serve the router until plan step 5 replaces it
// (FR-001 removes `apiKeys.create`). Every input below is `.strict()`; free
// text is sanitized BEFORE its length bound. No output carries a key hash; a
// plaintext key appears only in the collect and renew-self outputs.

const id = z.uuid();
const actor = {
  actorHumanId: id,
  /**
   * The API key the caller authenticated with (NFR-001: recorded on every
   * audit row), or null for a session caller. REQUIRED, so every caller says
   * which: the transport sets it from context, never from client input.
   */
  actingApiKeyId: id.nullable(),
};

/** Bounds raw size before sanitizing, then bounds the cleaned text. */
const cleanLine = (min: number, max: number) =>
  z
    .string()
    .max(max * 4)
    .transform(sanitizePlainText)
    .pipe(z.string().min(min).max(max));
const cleanProse = (min: number, max: number) =>
  z
    .string()
    .max(max * 4)
    .transform(sanitizePlainTextMultiline)
    .pipe(z.string().min(min).max(max));

export const apiKeySubjectSchema = z.enum(API_KEY_SUBJECTS);
export const apiKeyAccessSchema = z.enum(API_KEY_ACCESS_LEVELS);

export const API_KEY_LABEL_MAX = 100;
export const API_KEY_PURPOSE_MIN = 10;
export const API_KEY_PURPOSE_MAX = 500;
export const API_KEY_DENIAL_REASON_MIN = 10;
export const API_KEY_DENIAL_REASON_MAX = 500;
export const API_KEY_REVOKE_REASON_MAX = 500;

// ── Statuses (derived, never stored) ────────────────────────────────────────

export const apiKeyRequestStatusSchema = z.enum([
  "pending",
  "lapsed",
  "withdrawn",
  /** R31: a password reset or a ban closed it; shown as such, never "you withdrew". */
  "closed_for_account_security",
  "denied",
  "ready_to_collect",
  "collect_lapsed",
  "collected",
]);
export type ApiKeyRequestStatus = z.infer<typeof apiKeyRequestStatusSchema>;

export const apiKeyStatusSchema = z.enum(["live", "expired", "revoked"]);
export type ApiKeyStatus = z.infer<typeof apiKeyStatusSchema>;

const nullableDate = z.union([z.date(), z.null()]);
const nullableString = z.union([z.string(), z.null()]);

export const apiKeyViewSchema = z.object({
  id: z.string(),
  requestId: nullableString,
  holderHumanId: z.string(),
  holderName: nullableString,
  /** NULL on legacy keys (minted by the old `apiKeys.create`). */
  subject: z.union([apiKeySubjectSchema, z.null()]),
  orgId: nullableString,
  access: z.union([apiKeyAccessSchema, z.null()]),
  label: nullableString,
  purpose: nullableString,
  /** "thk_…ab12" (R25). */
  keyLast4: nullableString,
  legacy: z.boolean(),
  status: apiKeyStatusSchema,
  /** Live and expiring within 7 days. */
  expiringSoon: z.boolean(),
  createdAt: z.date(),
  lastUsedAt: nullableDate,
  expiresAt: nullableDate,
  /** Effective: the key's switch AND its request's switch. */
  autoRenew: z.boolean(),
  holderAutoRenew: z.boolean(),
  /**
   * Auto-renew cannot be switched on for this key: its request's switch is
   * off, whether it was never on (a request without auto-renew) or was
   * switched off later. Says nothing about who.
   */
  renewalLockedOff: z.boolean(),
  renewedFromKeyId: nullableString,
  revokedAt: nullableDate,
  revokedByHumanId: nullableString,
  revokedByName: nullableString,
  revokeReason: nullableString,
  decidedByHumanId: nullableString,
  decidedByName: nullableString,
  /** FR-003: shown on every screen that lists the key. */
  selfApproved: z.boolean(),
  canRevoke: z.boolean(),
});
export type ApiKeyView = z.infer<typeof apiKeyViewSchema>;

export const apiKeyRequestViewSchema = z.object({
  id: z.string(),
  requesterHumanId: z.string(),
  requesterName: nullableString,
  subject: apiKeySubjectSchema,
  orgId: nullableString,
  access: apiKeyAccessSchema,
  label: z.string(),
  purpose: z.string(),
  expiryDays: z.union([z.number().int(), z.null()]),
  autoRenew: z.boolean(),
  status: apiKeyRequestStatusSchema,
  createdAt: z.date(),
  /** When a pending request lapses, or a ready one stops being collectable. */
  lapsesAt: nullableDate,
  decidedAt: nullableDate,
  decision: z.union([z.enum(["APPROVED", "DENIED"]), z.null()]),
  decidedByHumanId: nullableString,
  decidedByName: nullableString,
  denialReason: nullableString,
  selfApproved: z.boolean(),
  withdrawnAt: nullableDate,
  collectedAt: nullableDate,
  /** The viewer may approve or deny it now. */
  canDecide: z.boolean(),
  /** The viewer is the platform owner and may approve it with a step-up. */
  canSelfApprove: z.boolean(),
});
export type ApiKeyRequestView = z.infer<typeof apiKeyRequestViewSchema>;

// ── request-api-key ─────────────────────────────────────────────────────────

export const requestApiKeyInputSchema = z
  .object({
    ...actor,
    subject: apiKeySubjectSchema,
    /** Required exactly when subject = ORG. */
    orgId: id.nullable().optional(),
    access: apiKeyAccessSchema,
    label: cleanLine(1, API_KEY_LABEL_MAX),
    purpose: cleanProse(API_KEY_PURPOSE_MIN, API_KEY_PURPOSE_MAX),
    /** NULL = never expires (ORG and PERSONAL only, R6). */
    expiryDays: z.number().int().min(1).max(90).nullable(),
    autoRenew: z.boolean(),
  })
  .strict();
export type RequestApiKeyInput = z.input<typeof requestApiKeyInputSchema>;

export const requestApiKeyOutputSchema = z.object({
  requestId: z.string(),
  status: apiKeyRequestStatusSchema,
  /** Who will decide it: the org's other admins, or platform staff. */
  approvers: z.enum(["org_admins", "platform_staff", "staff_admins"]),
});
export type RequestApiKeyOutput = z.infer<typeof requestApiKeyOutputSchema>;

// ── decide-api-key-request ──────────────────────────────────────────────────

export const decideApiKeyRequestInputSchema = z
  .object({
    ...actor,
    requestId: id,
    decision: z.enum(["APPROVED", "DENIED"]),
    /** Required on DENIED (10–500 chars, FR-004); refused on APPROVED. */
    reason: cleanProse(API_KEY_DENIAL_REASON_MIN, API_KEY_DENIAL_REASON_MAX)
      .nullable()
      .optional(),
    /**
     * Only for the platform owner approving their own STAFF request
     * (FR-003): proof of a password or passkey check in the last 5 minutes,
     * checked by the StepUpPort.
     */
    stepUpProof: z.string().min(1).max(4096).nullable().optional(),
  })
  .strict();
export type DecideApiKeyRequestInput = z.input<
  typeof decideApiKeyRequestInputSchema
>;

export const decideApiKeyRequestOutputSchema = z.object({
  requestId: z.string(),
  status: apiKeyRequestStatusSchema,
  selfApproved: z.boolean(),
});
export type DecideApiKeyRequestOutput = z.infer<
  typeof decideApiKeyRequestOutputSchema
>;

// ── withdraw-api-key-request ────────────────────────────────────────────────

export const withdrawApiKeyRequestInputSchema = z
  .object({ ...actor, requestId: id })
  .strict();
export type WithdrawApiKeyRequestInput = z.input<
  typeof withdrawApiKeyRequestInputSchema
>;

export const withdrawApiKeyRequestOutputSchema = z.object({
  requestId: z.string(),
  status: apiKeyRequestStatusSchema,
});
export type WithdrawApiKeyRequestOutput = z.infer<
  typeof withdrawApiKeyRequestOutputSchema
>;

// ── collect-api-key ─────────────────────────────────────────────────────────

export const collectApiKeyInputSchema = z
  .object({ ...actor, requestId: id })
  .strict();
export type CollectApiKeyInput = z.input<typeof collectApiKeyInputSchema>;

export const collectApiKeyOutputSchema = z.object({
  keyId: z.string(),
  /** The plaintext key: returned ONCE, never stored, logged or audited. */
  key: z.string(),
  keyLast4: z.string(),
  expiresAt: nullableDate,
});
export type CollectApiKeyOutput = z.infer<typeof collectApiKeyOutputSchema>;

// ── renew-api-key-self ──────────────────────────────────────────────────────

export const renewApiKeySelfInputSchema = z
  .object({
    actorHumanId: id,
    /** The key making the call IS the key being renewed (FR-009). */
    actingApiKeyId: id,
  })
  .strict();
export type RenewApiKeySelfInput = z.input<typeof renewApiKeySelfInputSchema>;

export const renewApiKeySelfOutputSchema = z.object({
  keyId: z.string(),
  /** The new plaintext key: returned ONCE. */
  key: z.string(),
  keyLast4: z.string(),
  expiresAt: nullableDate,
  renewedFromKeyId: z.string(),
  /** The old key keeps working until this instant (now + 24h, or sooner). */
  previousKeyExpiresAt: nullableDate,
});
export type RenewApiKeySelfOutput = z.infer<typeof renewApiKeySelfOutputSchema>;

// ── revoke-scoped-api-key ───────────────────────────────────────────────────

export const revokeScopedApiKeyInputSchema = z
  .object({
    ...actor,
    keyId: id,
    /** Optional, shown to the holder (FR-010). */
    reason: cleanProse(0, API_KEY_REVOKE_REASON_MAX).nullable().optional(),
  })
  .strict();
export type RevokeScopedApiKeyInput = z.input<
  typeof revokeScopedApiKeyInputSchema
>;

export const revokeScopedApiKeyOutputSchema = z.object({
  keyId: z.string(),
  status: z.enum(["revoked", "already_revoked"]),
  /** Keys that were live and are now cut off (both keys of a renewal overlap). */
  revokedKeyIds: z.array(z.string()),
  /** Keys on the same approval that had already expired, closed with it. */
  alsoClosedExpiredKeyIds: z.array(z.string()),
});
export type RevokeScopedApiKeyOutput = z.infer<
  typeof revokeScopedApiKeyOutputSchema
>;

// ── set-api-key-auto-renew ──────────────────────────────────────────────────

export const setApiKeyAutoRenewInputSchema = z
  .object({ ...actor, keyId: id, autoRenew: z.boolean() })
  .strict();
export type SetApiKeyAutoRenewInput = z.input<
  typeof setApiKeyAutoRenewInputSchema
>;

export const setApiKeyAutoRenewOutputSchema = z.object({
  keyId: z.string(),
  /** "key" = the holder's switch; "request" = the approver's final switch-off. */
  switchedOn: z.enum(["key", "request"]),
  changed: z.boolean(),
  /** Effective auto-renew after the change (key AND request). */
  autoRenew: z.boolean(),
});
export type SetApiKeyAutoRenewOutput = z.infer<
  typeof setApiKeyAutoRenewOutputSchema
>;

// ── list-my-api-keys / list-org-api-keys / list-platform-api-keys ──────────

export const listMyApiKeysInputSchema = z.object({ ...actor }).strict();
export type ListMyApiKeysInput = z.input<typeof listMyApiKeysInputSchema>;
export const listMyApiKeysOutputSchema = z.object({
  keys: z.array(apiKeyViewSchema),
  requests: z.array(apiKeyRequestViewSchema),
});
export type ListMyApiKeysOutput = z.infer<typeof listMyApiKeysOutputSchema>;

export const listOrgApiKeysInputSchema = z
  .object({ ...actor, orgId: id })
  .strict();
export type ListOrgApiKeysInput = z.input<typeof listOrgApiKeysInputSchema>;
export const listOrgApiKeysOutputSchema = z.object({
  keys: z.array(apiKeyViewSchema),
  /** Waiting ORG requests (R23d cards; R24 nav count = its length). */
  queue: z.array(apiKeyRequestViewSchema),
});
export type ListOrgApiKeysOutput = z.infer<typeof listOrgApiKeysOutputSchema>;

export const listPlatformApiKeysInputSchema = z
  .object({
    ...actor,
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).max(100_000).optional(),
    subject: apiKeySubjectSchema.optional(),
  })
  .strict();
export type ListPlatformApiKeysInput = z.input<
  typeof listPlatformApiKeysInputSchema
>;
export const listPlatformApiKeysOutputSchema = z.object({
  /** PERSONAL, STAFF and PLATFORM_WIDE requests, plus ORG fallbacks. */
  queue: z.array(apiKeyRequestViewSchema),
  keys: z.object({
    items: z.array(apiKeyViewSchema),
    total: z.number().int(),
    limit: z.number().int(),
    offset: z.number().int(),
    hasNextPage: z.boolean(),
  }),
});
export type ListPlatformApiKeysOutput = z.infer<
  typeof listPlatformApiKeysOutputSchema
>;

// ── sweep-api-key-lifecycle ─────────────────────────────────────────────────

export const sweepApiKeyLifecycleInputSchema = z
  .object({
    /** Rows read per batch. */
    batchSize: z.number().int().min(1).max(500).optional(),
    /** Upper bound on batches per kind, so one run always ends. */
    maxBatches: z.number().int().min(1).max(100).optional(),
  })
  .strict();
export type SweepApiKeyLifecycleInput = z.input<
  typeof sweepApiKeyLifecycleInputSchema
>;
export const sweepApiKeyLifecycleOutputSchema = z.object({
  pendingLapseNoticesSent: z.number().int(),
  collectLapseNoticesSent: z.number().int(),
  expiryNoticesSent: z.number().int(),
  /** Marked as sent, but the send failed (reported); the notice is not retried. */
  noticesFailed: z.number().int(),
  /**
   * The mark's CAS refused the row: another sweep marked it first, or (for a
   * lapse notice) it was withdrawn or closed for account security since it
   * was listed. No notice is sent for it.
   */
  skippedMarkRefused: z.number().int(),
});
export type SweepApiKeyLifecycleOutput = z.infer<
  typeof sweepApiKeyLifecycleOutputSchema
>;
