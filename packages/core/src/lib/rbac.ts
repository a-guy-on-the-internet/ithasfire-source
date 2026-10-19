import type { OrgRole, OrgMembership } from "@th/ports/repos/authz";
import type { AuthZPort, HumanRole } from "@th/ports/authz";
import { type AppErrorCode, fail } from "@th/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Canonical role sets
// ─────────────────────────────────────────────────────────────────────────────
// Use these constants (or pass a literal array) to `requireOrgMembership`.
// They keep role lists consistent across use cases and make grep-able.

/** Any org member — no role filter. */
export const ORG_ANY_ROLE: readonly OrgRole[] = [
  "OWNER",
  "ADMIN",
  "EDITOR",
  "VIEWER",
  "FINANCE",
  "SCANNER",
] as const;

/** Roles that can edit content (events, embeds, tags, etc.). */
export const ORG_EDIT_ROLES: readonly OrgRole[] = [
  "OWNER",
  "ADMIN",
  "EDITOR",
] as const;

/** Roles that can perform admin/management actions (org settings, members, etc.). */
export const ORG_ADMIN_ROLES: readonly OrgRole[] = ["OWNER", "ADMIN"] as const;

/** Roles that can view financial data and manage money (payouts, promos, connect, etc.). */
export const ORG_FINANCE_ROLES: readonly OrgRole[] = [
  "OWNER",
  "ADMIN",
  "FINANCE",
] as const;

/** Roles that can scan tickets at events. */
export const ORG_SCAN_ROLES: readonly OrgRole[] = [
  "OWNER",
  "ADMIN",
  "EDITOR",
  "SCANNER",
] as const;

/** Roles that can manage agreements, connect status, and other edit+finance workflows. */
export const ORG_EDIT_OR_FINANCE_ROLES: readonly OrgRole[] = [
  "OWNER",
  "ADMIN",
  "EDITOR",
  "FINANCE",
] as const;

/** Only the org owner. */
export const ORG_OWNER_ONLY: readonly OrgRole[] = ["OWNER"] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal repos surface needed for the membership lookup. */
export type OrgMembershipLookup = {
  authz: {
    getOrgMembership(input: {
      orgId: string;
      humanId: string;
    }): Promise<OrgMembership | null>;
  };
};

export type RequireOrgMembershipInput = {
  /** Repository handle (can be full Repos, TxRepos, or the minimal pick above). */
  repos: OrgMembershipLookup;
  orgId: string;
  actorHumanId: string;
  /** Roles the actor must hold. At least one must match. */
  roles: readonly OrgRole[];
  /** Optional explicit AppErrorCode (defaults to INSUFFICIENT_ROLE). */
  errorCode?: AppErrorCode;
};

export type RequireOwnerAccessInput = {
  /** Repository handle (can be full Repos, TxRepos, or the minimal pick above). */
  repos: OrgMembershipLookup;
  ownerType: "HUMAN" | "ORGANIZATION";
  ownerId: string;
  actorHumanId: string;
  /** Org roles the actor must hold when ownerType is ORGANIZATION. */
  roles: readonly OrgRole[];
  /** Optional explicit AppErrorCode for org membership failures. */
  errorCode?: AppErrorCode;
};

/**
 * What `requireOwnerAccess` knows once it has authorized the actor.
 *
 * Discriminated on `ownerType` so the HUMAN case stays honest: there is no
 * `OrgMembership` row for a human-owned resource, and we deliberately do NOT
 * synthesize a fake one (contrast {@link ScannerAccessResult}, which mints a
 * synthetic OWNER role because its callers must have SOME role to act on).
 *
 * `canFinance` exists so a caller that needs finance-ness does not have to
 * re-ask via `AuthZPort.canFinanceOrg`, which re-reads the identical
 * `OrgMembership` row this guard just fetched.
 *
 * Equivalence with `canFinanceOrg` (`packages/adapters/src/authz/db-authz-adapter.ts`)
 * — the ONE production implementation of that port:
 *   - ORG: it answers `satisfiesAny(membership.role, ["OWNER","ADMIN","FINANCE"])`
 *     over `ROLE_IMPLICATIONS`, whose closure is exactly
 *     `{OWNER, ADMIN, FINANCE}` = {@link ORG_FINANCE_ROLES}. No membership row
 *     ⇒ `false`, which this guard reaches by throwing first. It consults NO
 *     staff role and NO other state (`hasStaffRole` is a separate port method).
 *   - HUMAN: `canFinanceOrg` takes an `orgId` and is never callable for a
 *     human-owned resource; callers short-circuit to `true` because the actor
 *     has already been proven to BE the owner. `canFinance: true` preserves
 *     that decision verbatim.
 */
export type OwnerAccessResult =
  | {
      ownerType: "HUMAN";
      /** No membership row exists for a human-owned resource. */
      membership: null;
      /** The actor IS the owner — their own resources are always finance-visible. */
      canFinance: true;
    }
  | {
      ownerType: "ORGANIZATION";
      membership: OrgMembership;
      canFinance: boolean;
    };

export type RequirePlatformStaffInput = {
  authz: Pick<AuthZPort, "hasStaffRole">;
  actorHumanId: string;
  /** Platform staff roles required. At least one must match. */
  roles: readonly HumanRole[];
  /** Optional explicit AppErrorCode (defaults to STAFF_ONLY). */
  errorCode?: AppErrorCode;
};

// ─────────────────────────────────────────────────────────────────────────────
// Org membership guard
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensures the actor holds one of the specified org roles.
 *
 * Returns the `OrgMembership` on success so callers can inspect the role
 * downstream if needed (e.g. conditional logic based on OWNER vs EDITOR).
 *
 * @throws `{ code: "forbidden", message }` when the actor is not a member or
 *   lacks one of the required roles.
 *
 * @example
 * ```ts
 * const membership = await requireOrgMembership({
 *   repos: deps.repos,
 *   orgId: input.orgId,
 *   actorHumanId: input.actorHumanId,
 *   roles: ORG_EDIT_ROLES,
 * });
 * ```
 */
export async function requireOrgMembership(
  input: RequireOrgMembershipInput,
): Promise<OrgMembership> {
  const { repos, orgId, actorHumanId, roles, errorCode } = input;

  const membership = await repos.authz.getOrgMembership({
    orgId,
    humanId: actorHumanId,
  });

  if (!membership || !roles.includes(membership.role)) {
    throw fail(errorCode ?? "INSUFFICIENT_ROLE");
  }

  return membership;
}

// ─────────────────────────────────────────────────────────────────────────────
// Owner access guard (HUMAN or ORGANIZATION)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Authorizes access to a resource that can be owned by either a HUMAN or an
 * ORGANIZATION. For human-owned resources, the actor must be the owner. For
 * org-owned resources, the actor must hold one of the specified org roles.
 *
 * Returns an {@link OwnerAccessResult} so a caller that needs the role — or
 * finance-ness — downstream can read it off the row this guard already
 * fetched, instead of issuing a second authz round-trip. Returning a value
 * where `void` was returned is source-compatible: `await requireOwnerAccess(…)`
 * call sites need no edit.
 *
 * @throws `{ code: "forbidden", message: "not_owner" }` when the actor is not
 *   the human owner.
 * @throws `{ code: "forbidden", message }` when the actor lacks the required
 *   org role (delegates to `requireOrgMembership`).
 *
 * @example
 * ```ts
 * const access = await requireOwnerAccess({
 *   repos: deps.repos,
 *   ownerType: input.ownerType,
 *   ownerId: input.ownerId,
 *   actorHumanId: input.actorHumanId,
 *   roles: ORG_FINANCE_ROLES,
 * });
 * if (access.canFinance) { … }
 * ```
 */
export async function requireOwnerAccess(
  input: RequireOwnerAccessInput,
): Promise<OwnerAccessResult> {
  const { repos, ownerType, ownerId, actorHumanId, roles, errorCode } =
    input;

  if (ownerType === "HUMAN") {
    if (actorHumanId !== ownerId) {
      throw fail("NOT_RESOURCE_OWNER");
    }
    return { ownerType: "HUMAN", membership: null, canFinance: true };
  }

  const membership = await requireOrgMembership({
    repos,
    orgId: ownerId,
    actorHumanId,
    roles,
    errorCode,
  });

  return {
    ownerType: "ORGANIZATION",
    membership,
    // Single source of truth for the finance role list — see the equivalence
    // note on OwnerAccessResult before changing either side.
    canFinance: ORG_FINANCE_ROLES.includes(membership.role),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Platform staff guard
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensures the actor holds one of the specified platform-level staff roles,
 * with a second factor enrolled (the authz port applies that rule).
 *
 * @throws `STAFF_ONLY` (or `errorCode`) when the actor lacks the required
 *   staff role.
 * @throws `SECOND_FACTOR_REQUIRED` when the actor holds the role and has no
 *   passkey or TOTP enrolled.
 *
 * @example
 * ```ts
 * await requirePlatformStaff({
 *   authz: deps.authz,
 *   actorHumanId: input.actorHumanId,
 *   roles: ["ADMIN", "REVIEWER", "SUPPORT"],
 * });
 * ```
 */
export async function requirePlatformStaff(
  input: RequirePlatformStaffInput,
): Promise<void> {
  const { authz, actorHumanId, roles, errorCode } = input;

  const result = await authz.hasStaffRole({
    actorHumanId,
    requiredRoles: [...roles],
  });

  if (result.secondFactorRequired) {
    throw fail("SECOND_FACTOR_REQUIRED");
  }
  if (!result.allowed) {
    throw fail(errorCode ?? "STAFF_ONLY");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scanner / POS access guard with platform-admin override
// ─────────────────────────────────────────────────────────────────────────────

export type ScannerAccessVia = "membership" | "platform_admin";

export type ScannerAccessResult = {
  via: ScannerAccessVia;
  /**
   * Effective org role to use downstream. Real org membership when
   * `via === "membership"`; synthesized OWNER when the access is granted
   * via the platform-admin override (mirrors how root admin elsewhere is
   * treated as the highest tenant role).
   */
  role: OrgRole;
};

export type RequireScannerAccessOnOrgInput = {
  repos: OrgMembershipLookup;
  authz: Pick<AuthZPort, "hasStaffRole">;
  orgId: string;
  actorHumanId: string;
  /** Org roles considered scanner-eligible (e.g. ORG_SCAN_ROLES). */
  roles: readonly OrgRole[];
  /** Optional explicit AppErrorCode (defaults to INSUFFICIENT_ROLE). */
  errorCode?: AppErrorCode;
};

/**
 * Authorize a scanner-shell or POS action against a single event-owning org.
 *
 * Membership in `roles` is the primary path. Platform staff with the ADMIN
 * role bypass the membership check — required so platform admins can
 * diagnose, support, and operate against any tenant. Callers that mutate
 * state MUST emit an audit-log entry whenever `via === "platform_admin"`
 * so we can trace those actions back to the platform operator.
 *
 * The override needs an enrolled second factor: a platform ADMIN with none,
 * and no qualifying membership, gets `SECOND_FACTOR_REQUIRED`.
 */
export async function requireScannerAccessOnOrg(
  input: RequireScannerAccessOnOrgInput,
): Promise<ScannerAccessResult> {
  const membership = await input.repos.authz.getOrgMembership({
    orgId: input.orgId,
    humanId: input.actorHumanId,
  });

  if (membership && input.roles.includes(membership.role)) {
    return { via: "membership", role: membership.role };
  }

  const staff = await input.authz.hasStaffRole({
    actorHumanId: input.actorHumanId,
    requiredRoles: ["ADMIN"],
  });

  if (staff.allowed) {
    return { via: "platform_admin", role: "OWNER" };
  }
  if (staff.secondFactorRequired) {
    throw fail("SECOND_FACTOR_REQUIRED");
  }

  throw fail(input.errorCode ?? "INSUFFICIENT_ROLE");
}
