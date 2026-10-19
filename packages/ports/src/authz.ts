import { z } from "zod";

export const humanRoleSchema = z.enum([
  "USER",
  "REVIEWER",
  "ADMIN",
  "DEVELOPER",
  "SUPPORT",
  "COMMUNITY_MODERATOR",
]);

export type HumanRole = z.infer<typeof humanRoleSchema>;

/**
 * The `HumanRole`s that are staff authority, so they count only with a second
 * factor enrolled (`AuthZPort.hasStaffRole`), and an account holding one with
 * a passkey but no TOTP signs in only with that passkey
 * (`apps/api/src/auth/second-factor-bypass.ts`). USER is in the enum but
 * grants nothing.
 */
export const SECOND_FACTOR_STAFF_ROLES: readonly HumanRole[] =
  humanRoleSchema.options.filter((role) => role !== "USER");

export const isSecondFactorStaffRole = (role: string): boolean =>
  (SECOND_FACTOR_STAFF_ROLES as readonly string[]).includes(role);

export const authZRoleSchema = z.enum([
  "OWNER",
  "ADMIN",
  "EDITOR",
  "VIEWER",
  "FINANCE",
  "SCANNER",
]);

export type AuthZRole = z.infer<typeof authZRoleSchema>;

export const authZActionSchema = z.enum(["read", "edit", "publish", "finance"]);

export type AuthZAction = z.infer<typeof authZActionSchema>;

const nonEmptyRolesArraySchema = z
  .array(authZRoleSchema)
  .nonempty("requiredRoles must include at least one role");

const scopeSchema = z
  .object({
    action: authZActionSchema,
  })
  .strict();

export const baseActorContextSchema = z
  .object({
    actorHumanId: z.uuid("actorHumanId must be a UUID"),
  })
  .strict();

export type BaseActorContext = z.infer<typeof baseActorContextSchema>;

export const orgRoleCheckInputSchema = baseActorContextSchema
  .extend({
    orgId: z.uuid("orgId must be a UUID"),
    requiredRoles: nonEmptyRolesArraySchema,
    scope: scopeSchema.optional(),
  })
  .strict();

export type OrgRoleCheckInput = z.infer<typeof orgRoleCheckInputSchema>;

export const permissionProbeResultSchema = z
  .object({
    allowed: z.boolean(),
  })
  .strict();

export type PermissionProbeResult = z.infer<typeof permissionProbeResultSchema>;

export const eventPermissionInputSchema = baseActorContextSchema
  .extend({
    eventId: z.uuid("eventId must be a UUID"),
    scope: scopeSchema.optional(),
  })
  .strict();

export type EventPermissionInput = z.infer<typeof eventPermissionInputSchema>;

export const placePermissionInputSchema = baseActorContextSchema
  .extend({
    placeId: z.uuid("placeId must be a UUID"),
    scope: scopeSchema.optional(),
  })
  .strict();

export type PlacePermissionInput = z.infer<typeof placePermissionInputSchema>;

export const orgFinancePermissionInputSchema = baseActorContextSchema
  .extend({
    orgId: z.uuid("orgId must be a UUID"),
    scope: scopeSchema.optional(),
  })
  .strict();

export type OrgFinancePermissionInput = z.infer<
  typeof orgFinancePermissionInputSchema
>;

export const staffPermissionInputSchema = baseActorContextSchema
  .extend({
    requiredRoles: z
      .array(humanRoleSchema)
      .nonempty("requiredRoles must include at least one staff role"),
    /**
     * Answer on the role alone, skipping the enrolled-second-factor rule.
     * Only for callers whose answer grants nothing by itself: a status probe
     * the shell redirects on, or a check that EXCLUDES staff. A gate that
     * wants `SECOND_FACTOR_REQUIRED` as its own code asks the default probe
     * and reads `secondFactorRequired` from the answer.
     */
    allowWithoutSecondFactor: z.boolean().optional(),
  })
  .strict();

export type StaffPermissionInput = z.infer<typeof staffPermissionInputSchema>;

/**
 * The staff probe's answer. Its own schema, so the org, event and place probes
 * keep emitting exactly `{ allowed }`.
 */
export const staffPermissionProbeResultSchema = permissionProbeResultSchema
  .extend({
    /**
     * Set (with `allowed: false`) when the actor holds a required role and was
     * refused only because no second factor is enrolled.
     */
    secondFactorRequired: z.literal(true).optional(),
  })
  .strict();

export type StaffPermissionProbeResult = z.infer<
  typeof staffPermissionProbeResultSchema
>;

export type AuthZErrorCode =
  | "invalid_input"
  | "forbidden"
  | "not_found"
  | "transient";

export interface AuthZPortError extends Error {
  readonly code: AuthZErrorCode;
}

export interface AuthZPort {
  hasOrgRole(input: OrgRoleCheckInput): Promise<PermissionProbeResult>;

  requireOrgRole(input: OrgRoleCheckInput): Promise<void>;

  canEditEvent(input: EventPermissionInput): Promise<PermissionProbeResult>;

  canManagePlace(input: PlacePermissionInput): Promise<PermissionProbeResult>;

  canFinanceOrg(
    input: OrgFinancePermissionInput,
  ): Promise<PermissionProbeResult>;

  /**
   * Ithas Fire staff roles are global (not scoped to an org membership).
   *
   * Use this for support/admin capabilities like approving post-payout refunds.
   *
   * A staff role counts only with a passkey or TOTP enrolled: a role holder
   * with neither gets `{ allowed: false, secondFactorRequired: true }`. Every
   * caller inherits that; `allowWithoutSecondFactor` is the opt-out.
   */
  hasStaffRole(
    input: StaffPermissionInput,
  ): Promise<StaffPermissionProbeResult>;
}
