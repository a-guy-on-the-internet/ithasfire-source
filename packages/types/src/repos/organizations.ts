import type { OrgRole } from "./authz";

export type OrganizationStatus = "ACTIVE" | "SUSPENDED" | "ARCHIVED";
export type OrgInvitationStatus =
  | "PENDING"
  | "ACCEPTED"
  | "EXPIRED"
  | "REVOKED";
export type OrgTrustTier = "NEW" | "ESTABLISHED" | "TRUSTED" | "TOP" | "CUSTOM";

export interface OrganizationRecord {
  id: string;
  name: string;
  slug: string;
  status: OrganizationStatus;
  defaultLocale?: string | null;
  /** Public contact email. Used as Reply-To on org-originated emails. */
  contactEmail?: string | null;
  /** Physical mailing address for CAN-SPAM footer in announcements. */
  physicalAddress?: string | null;
  /** FK to the org-level default PRIMARY PayoutTerms. */
  defaultPrimaryPayoutTermsId?: string | null;
  /** FK to the org-level default RESALE PayoutTerms. */
  defaultResalePayoutTermsId?: string | null;
  trustTier: OrgTrustTier;
  trustBadgeLabel: string | null;
  trustBadgeIcon: string | null;
  chargebackTermsVersion?: string | null;
  chargebackTermsAcceptedAt?: Date | null;
  chargebackTermsAcceptedByHumanId?: string | null;
  createdAt: Date;
}

/** Organization record with aggregated counts for search indexing */
export interface OrganizationWithCounts extends OrganizationRecord {
  eventCount: number;
  memberCount: number;
}

export interface CreateOrganizationInput {
  name: string;
  slug: string;
  status: OrganizationStatus;
  createdAt: Date;
  defaultLocale?: string | null;
  contactEmail?: string | null;
}

export interface UpdateOrganizationInput {
  id: string;
  name?: string;
  slug?: string;
  defaultLocale?: string | null;
  contactEmail?: string | null;
  physicalAddress?: string | null;
  defaultPrimaryPayoutTermsId?: string | null;
  defaultResalePayoutTermsId?: string | null;
  trustTier?: OrgTrustTier;
  trustBadgeLabel?: string | null;
  trustBadgeIcon?: string | null;
}

export interface AcceptOrganizationChargebackTermsInput {
  orgId: string;
  version: string;
  acceptedAt: Date;
  acceptedByHumanId: string;
}

export interface AddOrganizationMemberInput {
  orgId: string;
  humanId: string;
  role: OrgRole;
  addedAt: Date;
}

export interface AddOrganizationMemberResult {
  created: boolean;
  previousRole: OrgRole | null;
}

export interface CountOrganizationMembersByRoleInput {
  orgId: string;
  role: OrgRole;
}

export interface ListActiveOrganizationsInput {
  limit: number;
  offset: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Org member management
// ─────────────────────────────────────────────────────────────────────────────

export interface OrgMemberRecord {
  humanId: string;
  name: string | null;
  email: string | null;
  role: OrgRole;
  joinedAt: Date;
}

export interface ListOrgMembersInput {
  orgId: string;
  limit: number;
  offset: number;
}

export interface ListOrgMembersResult {
  items: OrgMemberRecord[];
  total: number;
}

export interface RemoveOrgMemberInput {
  orgId: string;
  humanId: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Org invitations
// ─────────────────────────────────────────────────────────────────────────────

export interface OrgInvitationRecord {
  id: string;
  orgId: string;
  email: string;
  role: OrgRole;
  invitedByHumanId: string;
  token: string;
  status: OrgInvitationStatus;
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedByHumanId: string | null;
  createdAt: Date;
}

export interface CreateOrgInvitationInput {
  orgId: string;
  email: string;
  role: OrgRole;
  invitedByHumanId: string;
  token: string;
  expiresAt: Date;
}

export interface ListOrgInvitationsInput {
  orgId: string;
  status?: OrgInvitationStatus;
  limit: number;
  offset: number;
}

export interface ListOrgInvitationsResult {
  items: OrgInvitationRecord[];
  total: number;
}

export interface UpdateOrgInvitationStatusInput {
  id: string;
  status: OrgInvitationStatus;
  acceptedAt?: Date;
  acceptedByHumanId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Trust / Reputation
// ─────────────────────────────────────────────────────────────────────────────

export interface OrgTrustStats {
  completedEventCount: number;
  totalTicketsSold: number;
  disputeRate: number;
  accountAgeDays: number;
  hasContactEmail: boolean;
  hasVerifiedVenue: boolean;
}
