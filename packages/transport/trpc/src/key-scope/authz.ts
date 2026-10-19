import type {
  AuthZErrorCode,
  AuthZPort,
  AuthZPortError,
  PermissionProbeResult,
} from "@th/ports/authz";
import type { ApiKeyScope } from "@th/ports/authn";

type ScopedKey = Extract<ApiKeyScope, { kind: "scoped" }>;

class KeyScopeAuthZError extends Error implements AuthZPortError {
  readonly code: AuthZErrorCode = "forbidden";
  constructor(message: string) {
    super(message);
    this.name = "KeyScopeAuthZError";
  }
}

const REFUSED: PermissionProbeResult = { allowed: false };
// Derived from the port, not named: the staff probe's answer type is being
// widened by another session's work (second-factor flag), and this file
// must compile with or without it.
type StaffProbeResult = Awaited<ReturnType<AuthZPort["hasStaffRole"]>>;
const REFUSED_STAFF: StaffProbeResult = { allowed: false };

/**
 * The authz port as seen by one scoped-key call (FR-006 (c)(d), spec risk 1).
 * It only NARROWS: every answer it gives "yes" to is the real port's answer
 * on the holder's LIVE role, so a demoted, removed or banned holder fails on
 * the next call; it never says "yes" where the real port says "no".
 *
 * Narrowing by subject:
 * - ORG: org probes (`hasOrgRole`, `requireOrgRole`, `canFinanceOrg`) pass
 *   only for the key's own org, compared with the `orgId` the CALL RESOLVED
 *   (its argument), never with procedure input. `canEditEvent` and
 *   `canManagePlace` resolve their org inside the adapter, where this wrapper
 *   cannot see it, so they are refused: per the spec's risk-1 mitigation, a
 *   procedure that cannot report its resolved org is not usable by ORG keys.
 *   Staff probes are refused.
 * - STAFF: `hasStaffRole` passes through untouched (the holder's live staff
 *   role, the enrolled-second-factor rule included). Org, event, place and
 *   finance probes are refused: a key covers one subject.
 * - PERSONAL and PLATFORM_WIDE: every role probe is refused. (A
 *   PLATFORM_WIDE call has no actor at all, FR-007; refusing here is a
 *   second wall.)
 *
 * Every probe is narrowed whoever it asks about, the holder or a third
 * party: a use case that reads a third party's role to decide what the
 * caller may do (delegation, on-behalf-of) must not see more than the key
 * covers. The cost: a probe used to EXCLUDE a role (e.g. "staff may not apply
 * to be a moderator") reads "no" under a key, so such a procedure must not be
 * tagged without review.
 */
export function scopeAuthzToKey(authz: AuthZPort, key: ScopedKey): AuthZPort {
  const orgAllowed = (orgId: string): boolean =>
    key.subject === "ORG" && key.orgId !== null && orgId === key.orgId;

  return {
    async hasOrgRole(input) {
      if (!orgAllowed(input.orgId)) return REFUSED;
      return authz.hasOrgRole(input);
    },
    async requireOrgRole(input) {
      if (!orgAllowed(input.orgId)) {
        throw new KeyScopeAuthZError(
          "API key scope does not cover this organization",
        );
      }
      return authz.requireOrgRole(input);
    },
    async canFinanceOrg(input) {
      if (!orgAllowed(input.orgId)) return REFUSED;
      return authz.canFinanceOrg(input);
    },
    async canEditEvent() {
      return REFUSED;
    },
    async canManagePlace() {
      return REFUSED;
    },
    async hasStaffRole(input) {
      if (key.subject !== "STAFF") return REFUSED_STAFF;
      return authz.hasStaffRole(input);
    },
  };
}
