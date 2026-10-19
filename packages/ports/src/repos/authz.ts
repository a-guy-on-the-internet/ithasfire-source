import type {
  OrgMembership,
  OrgMembershipLookupInput,
  OrgRole,
  PlaceAccessContext,
  PlaceOrgVerificationInput,
} from "@th/types";

import type { HumanRole } from "../authz";

export interface AuthZRepo {
  getOrgMembership(
    input: OrgMembershipLookupInput,
  ): Promise<OrgMembership | null>;
  /**
   * Batch-fetch org memberships for a human across multiple orgs.
   * Returns only the memberships that exist; missing orgs are silently omitted.
   */
  getOrgMemberships(input: {
    orgIds: string[];
    humanId: string;
  }): Promise<OrgMembership[]>;
  listOrgMembershipsByHumanId(input: {
    humanId: string;
    roles?: OrgRole[];
  }): Promise<OrgMembership[]>;

  getStaffRolesForHumanId(humanId: string): Promise<HumanRole[]>;
  /**
   * Forward lookup: every humanId currently holding the given staff
   * {@link HumanRole}. The inverse of {@link getStaffRolesForHumanId}. Used to
   * fan a notification out to every community moderator when an edit
   * suggestion lands on a COMMUNITY listing. Returns distinct humanIds
   * (one row per human); ordering is unspecified.
   */
  listHumanIdsByStaffRole(role: HumanRole): Promise<string[]>;
  /**
   * Every AuthUser whose Human holds any of `roles` AND has a second factor
   * enrolled (`twoFactorEnabled`, or at least one passkey): the accounts
   * whose sessions carry staff authority. `sessionCount` is every session
   * row the AuthUser has. Ordering is unspecified. Used by the one-time
   * `revokeSecondFactorStaffSessions` sweep.
   */
  listSecondFactorStaffAuthUsers(roles: readonly HumanRole[]): Promise<
    Array<{ humanId: string; authUserId: string; sessionCount: number }>
  >;
  /**
   * Idempotently append a {@link HumanRole} to `Human.roles[]` (no-op when
   * already granted). This is the ONLY supported role-grant path — `roles` is
   * deliberately excluded from `UpdateHumanInput` so profile updates can
   * never escalate privileges. Used by review-moderator-application (FR-010)
   * to grant COMMUNITY_MODERATOR inside the review transaction.
   *
   * Returns `granted: true` when a row was updated (the role was newly
   * appended — which also proves the human exists). `granted: false` means
   * nothing changed: the human already holds the role OR no such human
   * exists; callers that must distinguish those cases verify the human
   * before granting (as review-moderator-application does).
   */
  grantHumanRole(input: {
    humanId: string;
    role: HumanRole;
  }): Promise<{ granted: boolean }>;
  /**
   * Idempotently remove a {@link HumanRole} from `Human.roles[]` (no-op when
   * not currently held). The revoke counterpart to {@link grantHumanRole} —
   * used by the platform roles admin UI (`admin-revoke-human-role` use case)
   * so ADMIN staff can walk back an over-grant.
   *
   * Returns `revoked: true` when a row was updated (the role was actually
   * removed — which also proves the human exists). `revoked: false` means
   * nothing changed: the human never held the role OR no such human exists;
   * callers that must distinguish those cases verify the human before
   * revoking (mirrors the grantHumanRole calling convention).
   */
  revokeHumanRole(input: {
    humanId: string;
    role: HumanRole;
  }): Promise<{ revoked: boolean }>;
  /**
   * Acquire a Postgres transaction-scoped advisory lock that serializes
   * concurrent last-ADMIN lockout guards (`admin-revoke-human-role.ts`).
   *
   * The guard there is "count remaining ADMINs, then revoke" — two separate
   * statements. Under READ COMMITTED, two concurrent revoke transactions
   * targeting *different* ADMIN humans each take their own count snapshot
   * before the other commits, so both can observe "2 ADMINs left" and both
   * proceed, leaving zero. Row-level locking doesn't help here because the
   * two transactions touch two different `Human` rows — there is no shared
   * row for Postgres to serialize on. This call takes an application-level
   * advisory lock instead, keyed on a fixed constant (not scoped to any row),
   * so any two callers contend on the *same* lock regardless of which human
   * they're revoking from.
   *
   * Must be called inside the same transaction as the count-read, BEFORE it,
   * whenever `role === "ADMIN"`. Released automatically on commit/rollback
   * (the `_xact_` lock variant) — no matching unlock call needed.
   *
   * Deliberately NOT used by `grantHumanRole`: granting ADMIN only ever
   * increases the admin count, so a concurrent grant can never manufacture
   * the "last ADMIN" race — only concurrent revokes need to serialize
   * against each other.
   */
  lockAdminRoleGuard(): Promise<void>;
  getEventOrgId(eventId: string): Promise<string | null>;
  /** Get the humanId of a human-owned event (null if org-owned or event doesn't exist). */
  getEventHumanId(eventId: string): Promise<string | null>;
  getPlaceAccessContext(placeId: string): Promise<PlaceAccessContext | null>;
  isPlaceVerifiedForOrg(input: PlaceOrgVerificationInput): Promise<boolean>;
  /** Lookup a human delegation for the authz adapter. */
  getHumanDelegation(input: {
    principalId: string;
    delegateId: string;
  }): Promise<OrgMembership | null>;
}

export type {
  OrgMembership,
  OrgMembershipLookupInput,
  OrgRole,
  PlaceAccessContext,
  PlaceOrgVerificationInput,
} from "@th/types";
