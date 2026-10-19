export type OrgRole =
  | "OWNER"
  | "ADMIN"
  | "EDITOR"
  | "VIEWER"
  | "FINANCE"
  | "SCANNER";

/**
 * Platform-level staff roles. Mirrors `@th/ports/authz` `humanRoleSchema` so
 * client packages (e.g. `@th/ui`) can reference the union without importing
 * from `@th/ports`. Keep in sync with that schema.
 */
export type StaffRole =
  | "USER"
  | "REVIEWER"
  | "ADMIN"
  | "DEVELOPER"
  | "SUPPORT"
  | "COMMUNITY_MODERATOR";

export interface OrgMembership {
  orgId: string;
  humanId: string;
  role: OrgRole;
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonical role-set constants (client-importable)
// ─────────────────────────────────────────────────────────────────────────────
// Org sets mirror `packages/core/src/lib/rbac.ts` (the server-side source of
// truth) so nav `rbac` annotations reference one set of role lists instead of
// duplicating inline arrays. Typed `readonly OrgRole[]` / `readonly StaffRole[]`
// so typo'd role strings fail at compile time at every definition site.

/** Any org member — no role filter. (mirrors core/lib/rbac.ts ORG_ANY_ROLE) */
export const ORG_ANY_ROLE: readonly OrgRole[] = [
  "OWNER",
  "ADMIN",
  "EDITOR",
  "VIEWER",
  "FINANCE",
  "SCANNER",
];

/** Roles that can edit content. (mirrors core/lib/rbac.ts ORG_EDIT_ROLES) */
export const ORG_EDIT_ROLES: readonly OrgRole[] = ["OWNER", "ADMIN", "EDITOR"];

/** Admin/management roles. (mirrors core/lib/rbac.ts ORG_ADMIN_ROLES) */
export const ORG_ADMIN_ROLES: readonly OrgRole[] = ["OWNER", "ADMIN"];

/** Financial roles. (mirrors core/lib/rbac.ts ORG_FINANCE_ROLES) */
export const ORG_FINANCE_ROLES: readonly OrgRole[] = [
  "OWNER",
  "ADMIN",
  "FINANCE",
];

/**
 * Edit-or-finance workflows — attendee/comps reads, agreements.
 * (mirrors core/lib/rbac.ts ORG_EDIT_OR_FINANCE_ROLES)
 */
export const ORG_EDIT_OR_FINANCE_ROLES: readonly OrgRole[] = [
  "OWNER",
  "ADMIN",
  "EDITOR",
  "FINANCE",
];

/** Ticket-scanning roles. (mirrors core/lib/rbac.ts ORG_SCAN_ROLES) */
export const ORG_SCAN_ROLES: readonly OrgRole[] = [
  "OWNER",
  "ADMIN",
  "EDITOR",
  "SCANNER",
];

/** Only the org owner. (mirrors core/lib/rbac.ts ORG_OWNER_ONLY) */
export const ORG_OWNER_ONLY: readonly OrgRole[] = ["OWNER"];

/**
 * Every org role except SCANNER — the "back-office" surfaces a door-only
 * scanner has no use for. New set for the nav visibility matrix.
 */
export const ORG_NON_SCANNER: readonly OrgRole[] = [
  "OWNER",
  "ADMIN",
  "EDITOR",
  "FINANCE",
  "VIEWER",
];

/**
 * Content surfaces a VIEWER can read but a scanner/finance role cannot manage
 * (audiences, volunteer templates, announcements, embeds). Nav matrix set.
 */
export const ORG_CONTENT_VIEW: readonly OrgRole[] = [
  "OWNER",
  "ADMIN",
  "EDITOR",
  "VIEWER",
];

/**
 * Financial surfaces with read-only VIEWER access (promos, payments).
 * Nav matrix set.
 */
export const ORG_FINANCE_VIEW: readonly OrgRole[] = [
  "OWNER",
  "ADMIN",
  "FINANCE",
  "VIEWER",
];

/**
 * Management surfaces with read-only VIEWER access (team roster, settings).
 * Nav matrix set.
 */
export const ORG_MANAGE_VIEW: readonly OrgRole[] = ["OWNER", "ADMIN", "VIEWER"];

// Platform staff sets (StaffRole) for the /platform nav matrix.

/** All staff who can enter /platform. */
export const STAFF_ALL: readonly StaffRole[] = [
  "ADMIN",
  "REVIEWER",
  "SUPPORT",
  "DEVELOPER",
];

/** Technical/operations panels — ADMIN + DEVELOPER only. */
export const STAFF_TECH: readonly StaffRole[] = ["ADMIN", "DEVELOPER"];

/** Customer-data panels (orders, tickets, humans) — staff who serve users. */
export const STAFF_CUSTOMER: readonly StaffRole[] = [
  "ADMIN",
  "SUPPORT",
  "DEVELOPER",
];

export interface PlaceAccessContext {
  placeId: string;
  verifiedHumanOwnerIds: string[];
  owningOrgIds: string[];
}

export interface OrgMembershipLookupInput {
  orgId: string;
  humanId: string;
}

export interface PlaceOrgVerificationInput {
  placeId: string;
  orgId: string;
}
