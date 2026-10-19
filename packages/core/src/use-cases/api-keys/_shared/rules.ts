import type { AuthZPort, HumanRole } from "@th/ports/authz";
import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  ApiKeyListItem,
  ApiKeyRequestRecord,
  ApiKeySubject,
} from "@th/ports/repos/api-keys";

import {
  isPlatformOwner,
  type PlatformOwnerEnvironment,
} from "../../../lib/security/platform-owner";

// ── Terms (scoped-api-keys spec 2026-10-08) ─────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/** FR-004: an undecided request lapses 14 days after it was sent. */
export const REQUEST_LAPSE_DAYS = 14;
/** FR-005 / R14: an approved request not collected within 7 days lapses. */
export const COLLECT_WINDOW_DAYS = 7;
/** FR-009 / R7: a key renews itself in its last 7 days. */
export const RENEW_WINDOW_DAYS = 7;
/** FR-012: the holder is warned 7 days before a key expires. */
export const EXPIRY_NOTICE_DAYS = 7;

/**
 * FR-011 / R15: at most 5 active keys per human per subject (per org for ORG
 * keys) and 20 per org across holders. Counts APPROVAL SLOTS, not key rows
 * (`lockAndCountForCap`): a pending request, an approved request inside its
 * collect window, or a collected request with a live key; a renewal pair in
 * its 24h overlap is one slot. The DB does not enforce these numbers; the
 * term caps it does enforce are CHECK `api_key_requests_expiry_days_cap`.
 */
export const MAX_KEYS_PER_HOLDER_PER_SUBJECT = 5;
export const MAX_KEYS_PER_ORG = 20;

/**
 * Key requests one holder may send in 24 hours, every subject and state
 * (withdrawn included), counted on the DB clock under the cap lock
 * (`lockAndCountForCap().holderRequestsLast24h`).
 *
 * An ABUSE LIMIT set by the orchestrator (2026-10-13, step-3 security
 * review), NOT a spec rule: FR-011 caps active keys and pending requests, but
 * a request-and-withdraw loop frees its slot each time and notifies the
 * approvers on every send. Ten a day is far above any honest use.
 */
export const MAX_REQUESTS_PER_HOLDER_PER_DAY = 10;

/**
 * R6: ORG / PERSONAL keys never expire or last up to 90 days; STAFF /
 * PLATFORM_WIDE keys at most 30 days. Mirrors CHECK
 * `api_key_requests_expiry_days_cap` (migration 20261012120000), which is the
 * backstop and is fired by the adapter integration tests.
 */
export const EXPIRY_DAYS_MAX: Readonly<Record<ApiKeySubject, number>> = {
  ORG: 90,
  PERSONAL: 90,
  STAFF: 30,
  PLATFORM_WIDE: 30,
};
export const NEVER_EXPIRING_ALLOWED: Readonly<Record<ApiKeySubject, boolean>> =
  { ORG: true, PERSONAL: true, STAFF: false, PLATFORM_WIDE: false };

/** R30: auto-renew needs a term of 2+ days (and a term at all, FR-009). */
export const AUTO_RENEW_MIN_TERM_DAYS = 2;

/** FR-003 / R21 / R30: a self-approved STAFF key's term is 2 to 30 days. */
export const SELF_APPROVAL_MIN_TERM_DAYS = 2;
export const SELF_APPROVAL_MAX_TERM_DAYS = 30;
/** FR-003: the step-up check must be within the last 5 minutes. */
export const STEP_UP_MAX_AGE_SECONDS = 300;

// ── Roles (Key scopes table) ────────────────────────────────────────────────

/** R28: staff roles that may request a STAFF key (not COMMUNITY_MODERATOR). */
export const STAFF_KEY_REQUESTER_ROLES = [
  "ADMIN",
  "REVIEWER",
  "DEVELOPER",
  "SUPPORT",
] as const satisfies readonly HumanRole[];

/**
 * "Any platform staff" in the Key scopes table: who approves PERSONAL
 * requests and ORG requests with no other live org approver, and who sees the
 * platform page (R9 "staff see all"). The spec does not list the roles; this
 * reading uses the R28 set (COMMUNITY_MODERATOR out, as for STAFF keys).
 */
export const PLATFORM_STAFF_ROLES = STAFF_KEY_REQUESTER_ROLES;

/** R21 / FR-010: staff ADMINs approve STAFF + PLATFORM_WIDE and revoke any key. */
export const STAFF_ADMIN_ROLES = [
  "ADMIN",
] as const satisfies readonly HumanRole[];

/** R13: only org OWNERs / ADMINs request or approve ORG keys. */
export const ORG_KEY_ROLES = ["OWNER", "ADMIN"] as const;

type RoleDeps = { authz: AuthZPort };

export async function isOrgKeyAdmin(
  deps: RoleDeps,
  humanId: string,
  orgId: string,
): Promise<boolean> {
  const { allowed } = await deps.authz.hasOrgRole({
    actorHumanId: humanId,
    orgId,
    requiredRoles: [...ORG_KEY_ROLES],
  });
  return allowed;
}

export async function hasStaffRoleIn(
  deps: RoleDeps,
  humanId: string,
  roles: readonly HumanRole[],
): Promise<boolean> {
  const [first, ...rest] = roles;
  if (!first) return false;
  const { allowed } = await deps.authz.hasStaffRole({
    actorHumanId: humanId,
    requiredRoles: [first, ...rest],
  });
  return allowed;
}

// ── Eligibility (FR-002: at request, again at approval and collection) ──────

type EligibilityDeps = RoleDeps & {
  repos: Pick<TxRepos, "humans">;
};

export type EligibilityAnswer =
  | { eligible: true }
  | {
      eligible: false;
      why: "not_found" | "inactive" | "email_unverified" | "role";
    };

/**
 * Whether `humanId` may hold a key on `subject` (Key scopes table, "who may
 * request"): an ACTIVE human with a verified email, plus ORG: a live OWNER /
 * ADMIN of the org; STAFF: a staff role in R28's set. PERSONAL and
 * PLATFORM_WIDE need nothing more (R20).
 */
export async function checkHolderEligibility(
  deps: EligibilityDeps,
  input: { humanId: string; subject: ApiKeySubject; orgId: string | null },
): Promise<EligibilityAnswer> {
  const found = await deps.repos.humans.getByIdWithIdentity(input.humanId);
  if (!found) return { eligible: false, why: "not_found" };
  if (found.human.status !== "ACTIVE")
    return { eligible: false, why: "inactive" };
  if (!found.identity.emailVerified) {
    return { eligible: false, why: "email_unverified" };
  }
  switch (input.subject) {
    case "ORG":
      if (!input.orgId) return { eligible: false, why: "role" };
      return (await isOrgKeyAdmin(deps, input.humanId, input.orgId))
        ? { eligible: true }
        : { eligible: false, why: "role" };
    case "STAFF":
      return (await hasStaffRoleIn(
        deps,
        input.humanId,
        STAFF_KEY_REQUESTER_ROLES,
      ))
        ? { eligible: true }
        : { eligible: false, why: "role" };
    case "PERSONAL":
    case "PLATFORM_WIDE":
      return { eligible: true };
  }
}

// ── Approval rights (FR-003, Key scopes table "who approves") ───────────────

export type DecideRight =
  /** May approve or deny. */
  | { kind: "approver"; via: "org_admin" | "platform_staff" | "staff_admin" }
  /** The platform owner's own STAFF request: approve only, with step-up. */
  | { kind: "self_approval" }
  /** Sees the request (requester, org admin, staff) but may not decide it. */
  | { kind: "visible_only"; why: "own_request" | "role" | "org_has_approver" }
  /** No business with this request: answered as not found (no IDOR). */
  | { kind: "none" };

type DecideRightDeps = RoleDeps & {
  repos: { apiKeys: Pick<Repos["apiKeys"], "orgHasOtherLiveApprover"> };
  platformOwnerEnvironment: PlatformOwnerEnvironment | null;
};

/**
 * What `actorHumanId` may do with `request`. ORG requests: an OWNER / ADMIN
 * of the request's org (read from the ROW, never from input) other than the
 * requester; when the org has no live OWNER / ADMIN besides the requester,
 * any platform staff. The fallback is decided by the repo's
 * `orgHasOtherLiveApprover`, the same SQL that builds the platform queue, so
 * the queue and the rights cannot drift. PERSONAL: platform staff. STAFF /
 * PLATFORM_WIDE: staff ADMINs. Nobody decides their own request, except the
 * platform owner approving their own STAFF request (FR-003).
 */
export async function decideRight(
  deps: DecideRightDeps,
  actorHumanId: string,
  request: ApiKeyRequestRecord,
): Promise<DecideRight> {
  if (actorHumanId === request.requesterHumanId) {
    if (
      request.subject === "STAFF" &&
      deps.platformOwnerEnvironment !== null &&
      isPlatformOwner(actorHumanId, deps.platformOwnerEnvironment) &&
      // The platform owner is an identity, not a role: they still need the
      // role that approves STAFF keys.
      (await hasStaffRoleIn(deps, actorHumanId, STAFF_ADMIN_ROLES))
    ) {
      return { kind: "self_approval" };
    }
    return { kind: "visible_only", why: "own_request" };
  }

  switch (request.subject) {
    case "ORG": {
      const orgId = request.orgId;
      if (!orgId) return { kind: "none" };
      if (await isOrgKeyAdmin(deps, actorHumanId, orgId)) {
        return { kind: "approver", via: "org_admin" };
      }
      const isStaff = await hasStaffRoleIn(
        deps,
        actorHumanId,
        PLATFORM_STAFF_ROLES,
      );
      if (!isStaff) return { kind: "none" };
      const orgHasApprover = await deps.repos.apiKeys.orgHasOtherLiveApprover({
        orgId,
        excludeHumanId: request.requesterHumanId,
      });
      return orgHasApprover
        ? { kind: "visible_only", why: "org_has_approver" }
        : { kind: "approver", via: "platform_staff" };
    }
    case "PERSONAL":
      return (await hasStaffRoleIn(deps, actorHumanId, PLATFORM_STAFF_ROLES))
        ? { kind: "approver", via: "platform_staff" }
        : { kind: "none" };
    case "STAFF":
    case "PLATFORM_WIDE":
      if (await hasStaffRoleIn(deps, actorHumanId, STAFF_ADMIN_ROLES)) {
        return { kind: "approver", via: "staff_admin" };
      }
      return (await hasStaffRoleIn(deps, actorHumanId, PLATFORM_STAFF_ROLES))
        ? { kind: "visible_only", why: "role" }
        : { kind: "none" };
  }
}

// ── Revoke rights (FR-010, R9) ──────────────────────────────────────────────

export type RevokeRight = "holder" | "org_admin" | "staff_admin" | null;

/**
 * Who may revoke (and so switch off auto-renew on) `key`: its holder; an org
 * OWNER / ADMIN of the key's org (from the ROW) for ORG keys; a staff ADMIN
 * for any key. Null = no right (answered as not found).
 */
export async function revokeRight(
  deps: RoleDeps,
  actorHumanId: string,
  key: Pick<ApiKeyListItem, "humanId" | "subject" | "orgId">,
): Promise<RevokeRight> {
  if (key.humanId === actorHumanId) return "holder";
  if (
    key.subject === "ORG" &&
    key.orgId &&
    (await isOrgKeyAdmin(deps, actorHumanId, key.orgId))
  ) {
    return "org_admin";
  }
  if (await hasStaffRoleIn(deps, actorHumanId, STAFF_ADMIN_ROLES)) {
    return "staff_admin";
  }
  return null;
}

/**
 * Whether the human who DECIDED `key`'s request still holds a role that
 * could decide it today (Key scopes table): for an ORG key, an OWNER / ADMIN
 * of the key's org, or any platform staff role; for a PERSONAL key, platform
 * staff; for STAFF / PLATFORM_WIDE, a staff ADMIN. A former approver who
 * lost the role keeps no right over the key (step-3 review, BLOCKING).
 *
 * The ORG route (org admin or the staff fallback) is in the
 * `api_key_request.approved` audit row (`via`) but not on the request row,
 * and this check deliberately does not read it: for ORG keys it accepts any
 * platform staff role, whichever route the decision took. Accepted by the
 * orchestrator (2026-10-13) because the right is switch-OFF only, and staff
 * could reach the request through the fallback queue anyway.
 */
export async function deciderStillHoldsRole(
  deps: RoleDeps,
  deciderHumanId: string,
  key: Pick<ApiKeyListItem, "subject" | "orgId">,
): Promise<boolean> {
  switch (key.subject) {
    case "ORG":
      return (
        (!!key.orgId &&
          (await isOrgKeyAdmin(deps, deciderHumanId, key.orgId))) ||
        (await hasStaffRoleIn(deps, deciderHumanId, PLATFORM_STAFF_ROLES))
      );
    case "PERSONAL":
      return hasStaffRoleIn(deps, deciderHumanId, PLATFORM_STAFF_ROLES);
    case "STAFF":
    case "PLATFORM_WIDE":
      return hasStaffRoleIn(deps, deciderHumanId, STAFF_ADMIN_ROLES);
    case null:
      return false;
  }
}

// ── Time helpers ────────────────────────────────────────────────────────────

export function addDays(at: Date, days: number): Date {
  return new Date(at.getTime() + days * DAY_MS);
}
