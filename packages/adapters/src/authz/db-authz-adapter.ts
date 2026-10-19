import {
  permissionProbeResultSchema,
  orgRoleCheckInputSchema,
  eventPermissionInputSchema,
  placePermissionInputSchema,
  orgFinancePermissionInputSchema,
  staffPermissionInputSchema,
  staffPermissionProbeResultSchema,
  isSecondFactorStaffRole,
  type AuthZPort,
  type AuthZPortError,
  type AuthZErrorCode,
  type OrgRoleCheckInput,
  type PermissionProbeResult,
  type EventPermissionInput,
  type PlacePermissionInput,
  type OrgFinancePermissionInput,
  type StaffPermissionInput,
  type StaffPermissionProbeResult,
} from "@th/ports/authz";
import { actorHoldsEventEditRole } from "@th/core/lib/event-edit-rights";
import type { Repos } from "@th/ports/repos";
import type { OrgRole } from "@th/ports/repos/authz";

class AuthZAdapterError extends Error implements AuthZPortError {
  readonly code: AuthZErrorCode;

  constructor(code: AuthZErrorCode, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "AuthZAdapterError";
    this.code = code;
  }
}

const ROLE_IMPLICATIONS: Record<OrgRole, readonly OrgRole[]> = {
  OWNER: ["OWNER", "ADMIN", "EDITOR", "VIEWER", "FINANCE", "SCANNER"],
  ADMIN: ["ADMIN", "EDITOR", "VIEWER", "FINANCE", "SCANNER"],
  EDITOR: ["EDITOR", "VIEWER"],
  VIEWER: ["VIEWER"],
  FINANCE: ["FINANCE"],
  SCANNER: ["SCANNER"],
};

function roleSatisfies(actual: OrgRole, required: OrgRole): boolean {
  return ROLE_IMPLICATIONS[actual].includes(required);
}

function satisfiesAny(actual: OrgRole, requiredRoles: OrgRole[]): boolean {
  return requiredRoles.some((role) => roleSatisfies(actual, role));
}

function makeForbidden(message: string): AuthZAdapterError {
  return new AuthZAdapterError("forbidden", message);
}

export type DbAuthZAdapterDeps = {
  repos: Repos;
  /**
   * Dev-only: every staff role holder reads as second-factor enrolled.
   * Composition roots pass `staffSecondFactorBypassEnabled`
   * (`@th/trpc/dev-staff-2fa-bypass`), which is true only off Cloud Run,
   * with `NODE_ENV` unset, `development` or `test`, and the flag set.
   */
  staffSecondFactorBypass?: boolean;
};

export function createDbAuthZAdapter({
  repos,
  staffSecondFactorBypass = false,
}: DbAuthZAdapterDeps): AuthZPort {
  async function hasOrgRole(
    input: OrgRoleCheckInput,
  ): Promise<PermissionProbeResult> {
    const parsed = orgRoleCheckInputSchema.parse(input);
    const membership = await repos.authz.getOrgMembership({
      orgId: parsed.orgId,
      humanId: parsed.actorHumanId,
    });

    const allowed = membership
      ? satisfiesAny(membership.role, parsed.requiredRoles)
      : false;

    return permissionProbeResultSchema.parse({ allowed });
  }

  async function requireOrgRole(input: OrgRoleCheckInput): Promise<void> {
    const result = await hasOrgRole(input);
    if (!result.allowed) {
      throw makeForbidden("Actor lacks required organization role");
    }
  }

  async function canEditEvent(
    input: EventPermissionInput,
  ): Promise<PermissionProbeResult> {
    const parsed = eventPermissionInputSchema.parse(input);

    // Resolve the owner (org first; the human owner is only looked up for a
    // non-org event), then apply THE editor rule — the same function the
    // hidden-event read gate uses, so the two cannot drift again.
    const orgId = await repos.authz.getEventOrgId(parsed.eventId);
    const humanId = orgId
      ? null
      : await repos.authz.getEventHumanId(parsed.eventId);
    const allowed = await actorHoldsEventEditRole(
      repos.authz,
      { orgId, humanId },
      parsed.actorHumanId,
    );
    return permissionProbeResultSchema.parse({ allowed });
  }

  async function canManagePlace(
    input: PlacePermissionInput,
  ): Promise<PermissionProbeResult> {
    const parsed = placePermissionInputSchema.parse(input);
    const context = await repos.authz.getPlaceAccessContext(parsed.placeId);
    if (!context) {
      return permissionProbeResultSchema.parse({ allowed: false });
    }

    if (context.verifiedHumanOwnerIds.includes(parsed.actorHumanId)) {
      return permissionProbeResultSchema.parse({ allowed: true });
    }

    for (const orgId of context.owningOrgIds) {
      const membership = await repos.authz.getOrgMembership({
        orgId,
        humanId: parsed.actorHumanId,
      });
      if (
        membership &&
        satisfiesAny(membership.role, ["OWNER", "ADMIN", "EDITOR"])
      ) {
        return permissionProbeResultSchema.parse({ allowed: true });
      }
    }

    return permissionProbeResultSchema.parse({ allowed: false });
  }

  async function canFinanceOrg(
    input: OrgFinancePermissionInput,
  ): Promise<PermissionProbeResult> {
    const parsed = orgFinancePermissionInputSchema.parse(input);
    const membership = await repos.authz.getOrgMembership({
      orgId: parsed.orgId,
      humanId: parsed.actorHumanId,
    });

    const allowed = membership
      ? satisfiesAny(membership.role, ["OWNER", "ADMIN", "FINANCE"])
      : false;
    return permissionProbeResultSchema.parse({ allowed });
  }

  async function hasStaffRole(
    input: StaffPermissionInput,
  ): Promise<StaffPermissionProbeResult> {
    const parsed = staffPermissionInputSchema.parse(input);
    const roles = await repos.authz.getStaffRolesForHumanId(
      parsed.actorHumanId,
    );
    const held = parsed.requiredRoles.filter((required) =>
      roles.includes(required),
    );
    if (held.length === 0) {
      return staffPermissionProbeResultSchema.parse({ allowed: false });
    }

    // A staff role is authority only with a second factor enrolled. The
    // enrolment read runs after the role match, so a non-staff caller costs
    // one query. USER is in the `HumanRole` enum but is no staff grant (new
    // humans start with an empty `roles` array; no sign-up path sets it), so
    // a match on USER itself is answered without a second factor. A request
    // that names USER beside staff roles gets no pass from that: only an
    // actor who holds USER skips the enrolment read. The staff list is
    // `SECOND_FACTOR_STAFF_ROLES`, shared with the API's sign-in gate.
    if (
      held.some((role) => !isSecondFactorStaffRole(role)) ||
      parsed.allowWithoutSecondFactor ||
      staffSecondFactorBypass
    ) {
      return staffPermissionProbeResultSchema.parse({ allowed: true });
    }

    const enrolled = await repos.humans.hasSecondFactorEnrolled(
      parsed.actorHumanId,
    );
    return staffPermissionProbeResultSchema.parse(
      enrolled
        ? { allowed: true }
        : { allowed: false, secondFactorRequired: true },
    );
  }

  return {
    hasOrgRole,
    requireOrgRole,
    canEditEvent,
    canManagePlace,
    canFinanceOrg,
    hasStaffRole,
  };
}
