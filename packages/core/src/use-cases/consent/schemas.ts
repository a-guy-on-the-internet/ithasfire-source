import { z } from "zod";

// Allow-list of policy versions the server will accept. Add a new entry when
// you bump either policy. Never remove old entries — historical clients may
// still be running an older bundle when they click the banner.
export const KNOWN_PRIVACY_POLICY_VERSIONS = [
  "2026-05-01",
  "2026-07-30",
  "2026-10-07",
] as const;
export const KNOWN_COOKIE_POLICY_VERSIONS = [
  "2026-05-01",
  "2026-07-30",
] as const;

const privacyVersion = z.enum(KNOWN_PRIVACY_POLICY_VERSIONS);
const cookieVersion = z.enum(KNOWN_COOKIE_POLICY_VERSIONS);

// Client-trusted fields — what the browser is allowed to send. Splitting
// this from the full input means a malicious caller cannot forge an
// `actorHumanId` to attribute a consent record to another account, and
// can't pre-populate `ipHash`/`userAgent` to game the audit trail.
export const recordConsentClientInputSchema = z
  .object({
    anonymousId: z.uuid(),
    choice: z.enum(["ALL", "ESSENTIAL", "RESET"]),
    source: z.enum(["BANNER", "FOOTER_MANAGE"]),
    privacyPolicyVersion: privacyVersion,
    cookiePolicyVersion: cookieVersion,
  })
  .strict();

export type RecordConsentClientInput = z.infer<
  typeof recordConsentClientInputSchema
>;

// Full server-side shape used by the use case. The router parses the
// client schema, then merges request-derived values (actorHumanId from
// session, ipHash + userAgent from headers) before calling the use case.
export const recordConsentInputSchema = recordConsentClientInputSchema.extend({
  actorHumanId: z.string().uuid().nullable(),
  ipHash: z.string().min(1).max(128).nullable(),
  userAgent: z.string().max(1024).nullable(),
});

export type RecordConsentInput = z.infer<typeof recordConsentInputSchema>;

export const listConsentByHumanIdInputSchema = z
  .object({
    humanId: z.uuid(),
  })
  .strict();

export type ListConsentByHumanIdInput = z.infer<
  typeof listConsentByHumanIdInputSchema
>;

export const listConsentByAnonymousIdInputSchema = z
  .object({
    anonymousId: z.uuid(),
  })
  .strict();

export type ListConsentByAnonymousIdInput = z.infer<
  typeof listConsentByAnonymousIdInputSchema
>;
