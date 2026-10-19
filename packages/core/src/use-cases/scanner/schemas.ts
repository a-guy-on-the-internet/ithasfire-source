import { z } from "zod";

// ── Roles eligible to enter the scanner shell ─────────────────────────────────
// Keep this in lockstep with `ORG_SCAN_ROLES` minus EDITOR — scanner-foundation
// FR-002 explicitly admits only {SCANNER, ADMIN, OWNER}. EDITOR is allowed to
// scan tickets via the admin web fallback but is not a scanner-shell operator.
import type { OrgRole } from "@th/ports/repos/authz";
export const SCANNER_OPERATOR_ROLES: readonly OrgRole[] = [
  "OWNER",
  "ADMIN",
  "SCANNER",
] as const;

export const listScannerAccessibleEventsInputSchema = z
  .object({
    actorHumanId: z.uuid(),
  })
  .strict();
export type ListScannerAccessibleEventsInput = z.infer<
  typeof listScannerAccessibleEventsInputSchema
>;

export const getScannerSessionContextInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    eventId: z.uuid().optional(),
  })
  .strict();
export type GetScannerSessionContextInput = z.infer<
  typeof getScannerSessionContextInputSchema
>;

/**
 * Send the operator-onboarding email — recipient is identified by either
 * humanId (existing platform user) or raw email (admin-typed). Carries no
 * token; the email contains app-download links and instructions to sign in
 * with the recipient's email via the standard scanner magic-link flow.
 */
// Base (unrefined) object — exported so transport variants that need to
// `.omit()` fields (e.g. actorHumanId injected from ctx) can do so and then
// re-apply the refinement themselves. zod v4 disallows `.omit()` directly on
// refined schemas.
export const sendScannerOnboardingEmailInputObject = z
  .object({
    actorHumanId: z.uuid(),
    orgId: z.uuid(),
    targetHumanId: z.uuid().optional(),
    targetEmail: z.string().email().toLowerCase().optional(),
  })
  .strict();
export const sendScannerOnboardingEmailRecipientRefinement = (v: {
  targetHumanId?: string | undefined;
  targetEmail?: string | undefined;
}): boolean => Boolean(v.targetHumanId) !== Boolean(v.targetEmail);
export const sendScannerOnboardingEmailRecipientRefinementMessage =
  "Provide exactly one of targetHumanId or targetEmail";

export const sendScannerOnboardingEmailInputSchema =
  sendScannerOnboardingEmailInputObject.refine(
    sendScannerOnboardingEmailRecipientRefinement,
    { message: sendScannerOnboardingEmailRecipientRefinementMessage },
  );
export type SendScannerOnboardingEmailInput = z.infer<
  typeof sendScannerOnboardingEmailInputSchema
>;

export const getScannerEventManifestInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    eventId: z.uuid(),
  })
  .strict();
export type GetScannerEventManifestInput = z.infer<
  typeof getScannerEventManifestInputSchema
>;

export const recordScannerOperatorBootstrapInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    appVersion: z.string().min(1).max(64),
    channel: z.enum(["pilot", "preview", "production"]),
    eventId: z.uuid().optional(),
    outcome: z.enum(["success", "failure"]),
    failureReason: z.string().min(1).max(512).optional(),
  })
  .strict();
export type RecordScannerOperatorBootstrapInput = z.infer<
  typeof recordScannerOperatorBootstrapInputSchema
>;
