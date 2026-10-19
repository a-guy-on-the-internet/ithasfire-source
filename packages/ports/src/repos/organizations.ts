import type {
  AddOrganizationMemberInput,
  AddOrganizationMemberResult,
  AcceptOrganizationChargebackTermsInput,
  CountOrganizationMembersByRoleInput,
  CreateOrganizationInput,
  CreateOrgInvitationInput,
  ListActiveOrganizationsInput,
  ListOrgInvitationsInput,
  ListOrgInvitationsResult,
  ListOrgMembersInput,
  ListOrgMembersResult,
  OrgInvitationRecord,
  OrgMemberRecord,
  OrganizationRecord,
  OrganizationStatus,
  OrganizationWithCounts,
  OrgTrustStats,
  OrgTrustTier,
  RemoveOrgMemberInput,
  UpdateOrganizationInput,
  UpdateOrgInvitationStatusInput,
} from "@th/types/repos/organizations";

export interface OrganizationsRepo {
  getById(id: string): Promise<OrganizationRecord | null>;
  getByIds(ids: string[]): Promise<OrganizationRecord[]>;
  create(input: CreateOrganizationInput): Promise<OrganizationRecord>;
  /** Partial update of organization fields (name, slug, defaultLocale, contactEmail). */
  update(input: UpdateOrganizationInput): Promise<OrganizationRecord>;
  /**
   * Guarded compare-and-swap pointer write (mirrors
   * `PayoutTermsRepo.activate`'s updateMany-with-WHERE pattern): set
   * `defaultPrimaryPayoutTermsId` ONLY when it is currently NULL. Returns
   * `true` when the write landed, `false` on a 0-match (a concurrent
   * transaction already set the pointer — callers re-read and adopt the
   * winner's row instead of clobbering it).
   */
  setDefaultPrimaryPayoutTermsIdIfNull(input: {
    id: string;
    payoutTermsId: string;
  }): Promise<boolean>;
  acceptChargebackTerms(
    input: AcceptOrganizationChargebackTermsInput,
  ): Promise<OrganizationRecord>;
  addMember(
    input: AddOrganizationMemberInput,
  ): Promise<AddOrganizationMemberResult>;
  countMembersByRole(
    input: CountOrganizationMembersByRoleInput,
  ): Promise<number>;
  /**
   * Take a transaction-scoped advisory lock on one org's owner roster.
   *
   * The last-owner guards are "read the target, count the OWNERs, then
   * write" — separate statements. Under READ COMMITTED two owners demoting
   * or removing EACH OTHER at once each read a count of 2 and both commit,
   * leaving the org with no OWNER; and only an OWNER can grant OWNER, so no
   * member could repair it. A row lock does not help: the two transactions
   * write two different `OrgMember` rows. This lock is keyed on the org id,
   * so any two callers for the same org run one after the other and the
   * second reads what the first committed.
   *
   * Take it before any row the decision depends on (the actor row, the
   * target row, the owner count, an invitation) is read, or read that row
   * again after it is taken. Released at commit or rollback (the `_xact_`
   * variant) — there is no unlock call.
   */
  lockOwnerRoster(orgId: string): Promise<void>;
  /**
   * Take {@link lockOwnerRoster} for every org the human is a MEMBER of, at
   * any role, ordered by lock id so two callers never take the same pair of
   * locks in opposite orders, then lock the human's row so no new membership
   * can be created for them until the transaction ends.
   *
   * For the transaction that deletes a human: the `OrgMember` cascade
   * removes them from each of those orgs, so it must serialize with role
   * changes, removals and ownership transfers there. Every membership, not
   * only the OWNER ones: a transfer can make the human an org's only OWNER
   * between this delete's sole-owner check and its commit, and the two share
   * a lock only if the delete locked that org while the human was still an
   * EDITOR in it. The row lock covers the memberships no roster lock can: a
   * new org's creator is its only OWNER, and `createOrg` takes no roster
   * lock. Memberships that commit while the locks are being taken are read
   * again and locked too. Those are locked out of order, so they can
   * deadlock with an invite or accept in the same org; Postgres then aborts
   * one side with 40P01, which must reach the caller and never be caught.
   *
   * Call it BEFORE `isSoleOwnerOfAnyOrg`, inside the same transaction as the
   * delete. The human delete is the only caller that holds more than one
   * roster lock at a time.
   */
  lockOwnerRostersForMember(humanId: string): Promise<void>;
  /**
   * Whether the given human is the SOLE `OWNER` of at least one organization.
   * Used to block account deletion that would silently orphan an org (the
   * `OrgMember.human` FK is `ON DELETE CASCADE`, so deleting the human would
   * otherwise remove their membership without any equivalent of the
   * `CANNOT_REMOVE_LAST_OWNER` guard `removeMember` callers already enforce).
   */
  isSoleOwnerOfAnyOrg(humanId: string): Promise<boolean>;
  /**
   * List active organizations with event and member counts.
   * Used for search indexing.
   */
  listActive(
    input: ListActiveOrganizationsInput,
  ): Promise<{ items: OrganizationWithCounts[]; total: number }>;
  /** List org members with identity info for the team management page. */
  listMembers(input: ListOrgMembersInput): Promise<ListOrgMembersResult>;
  /** Remove a member from an organization. */
  removeMember(input: RemoveOrgMemberInput): Promise<boolean>;
  /**
   * Whether the account registered to `email` (case-insensitive) is a member
   * of the org. ONE query that runs the same way whether or not the email has
   * an account — callers use it to avoid an account-existence timing oracle
   * (security review, 2026-09-29).
   */
  isMemberByEmail(orgId: string, email: string): Promise<boolean>;

  // ── Invitations ───────────────────────────────────────────────────────
  /** Create or upsert a pending invitation. */
  createInvitation(
    input: CreateOrgInvitationInput,
  ): Promise<OrgInvitationRecord>;
  /** Look up an invitation by its unique token. */
  getInvitationByToken(token: string): Promise<OrgInvitationRecord | null>;
  /** Look up an existing invitation for an email within an org. */
  getInvitationByOrgAndEmail(
    orgId: string,
    email: string,
  ): Promise<OrgInvitationRecord | null>;
  /** List invitations for the team management page. */
  listInvitations(
    input: ListOrgInvitationsInput,
  ): Promise<ListOrgInvitationsResult>;
  /** Update an invitation's status (accept, revoke, expire). */
  updateInvitationStatus(
    input: UpdateOrgInvitationStatusInput,
  ): Promise<OrgInvitationRecord>;
  /**
   * Set every PENDING invitation at role OWNER that `invitedByHumanId` sent
   * in this org to REVOKED, in one statement, and return the rows it revoked.
   * Invitations at other roles, in other orgs, from other inviters, or no
   * longer PENDING are left alone.
   */
  revokePendingOwnerInvitationsByInviter(input: {
    orgId: string;
    invitedByHumanId: string;
  }): Promise<Array<Pick<OrgInvitationRecord, "id" | "email">>>;
  /**
   * Set every PENDING invitation of the org, at any role and from any
   * inviter, to REVOKED in one statement. Returns how many were revoked.
   * For the transaction that dissolves the org.
   */
  revokeAllPendingInvitations(orgId: string): Promise<number>;

  // ── Trust / Reputation ──────────────────────────────────────────────
  /** Compute aggregated trust stats for an organization. */
  getOrgTrustStats(orgId: string): Promise<OrgTrustStats>;
}

export type {
  AddOrganizationMemberInput,
  AddOrganizationMemberResult,
  AcceptOrganizationChargebackTermsInput,
  CountOrganizationMembersByRoleInput,
  CreateOrganizationInput,
  CreateOrgInvitationInput,
  ListActiveOrganizationsInput,
  ListOrgInvitationsInput,
  ListOrgInvitationsResult,
  ListOrgMembersInput,
  ListOrgMembersResult,
  OrgInvitationRecord,
  OrgMemberRecord,
  OrganizationRecord,
  OrganizationStatus,
  OrganizationWithCounts,
  OrgTrustStats,
  OrgTrustTier,
  RemoveOrgMemberInput,
  UpdateOrganizationInput,
  UpdateOrgInvitationStatusInput,
} from "@th/types/repos/organizations";
