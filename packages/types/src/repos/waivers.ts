// ── Waiver Template ──────────────────────────────────────────────────────────

export interface WaiverTemplateRecord {
  id: string;
  orgId: string | null;
  humanId: string | null;
  name: string;
  body: string;
  version: number;
  isDefault: boolean;
  /**
   * Audience discriminator (attendee-facing vs volunteer-facing). Optional
   * (like `source`) so lightweight fakes stay valid; the Prisma adapter
   * always provides it. Defaults to ATTENDEE at the schema level.
   */
  kind?: WaiverTemplateKind;
  source?: WaiverTemplateSource;
  assembledFromClauses?: WaiverTemplateClauseReference[] | null;
  jurisdictionState?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type WaiverTemplateSource = "FREEFORM" | "ASSEMBLED" | "PLATFORM";

export type WaiverTemplateKind = "ATTENDEE" | "VOLUNTEER";

export interface WaiverTemplateClauseReference {
  clauseId: string;
  clauseSlug: string;
  clauseVersion: number;
}

export interface CreateWaiverTemplateInput {
  orgId: string | null;
  humanId: string | null;
  name: string;
  body: string;
  isDefault?: boolean;
  source?: WaiverTemplateSource;
  assembledFromClauses?: WaiverTemplateClauseReference[] | null;
  jurisdictionState?: string | null;
}

export interface UpdateWaiverTemplateInput {
  id: string;
  name?: string;
  body?: string;
  isDefault?: boolean;
  source?: WaiverTemplateSource;
  assembledFromClauses?: WaiverTemplateClauseReference[] | null;
  jurisdictionState?: string | null;
}

export interface ListWaiverTemplatesInput {
  /** Filter by org. Null to list platform-provided templates only. */
  orgId?: string | null;
  /** Filter by human (solo-owner templates). */
  humanId?: string | null;
  /** Include platform-provided (orgId=null, humanId=null) templates. */
  includePlatform?: boolean;
  limit?: number;
  offset?: number;
}

// ── Waiver Acceptance ───────────────────────────────────────────────────────

export interface WaiverAcceptanceRecord {
  id: string;
  orderId: string;
  humanId: string;
  waiverTemplateId: string;
  waiverVersion: number;
  waiverBodyHash: string;
  acceptedAt: Date;
  ipAddress: string | null;
}

export interface CreateWaiverAcceptanceInput {
  orderId: string;
  humanId: string;
  waiverTemplateId: string;
  waiverVersion: number;
  waiverBodyHash: string;
  ipAddress?: string | null;
}

// ── Volunteer Waiver Acceptance ─────────────────────────────────────────────
// Human-profile-keyed acceptance recorded at volunteer signup time (Gap 3).
// Separate from the order-keyed `WaiverAcceptance` by design.

export interface VolunteerWaiverAcceptanceRecord {
  id: string;
  /**
   * Null for a CONTACT-ONLY signup (anonymous signup naming an email that
   * already has an account): proven for that signup, never attributed to
   * the account, so never "already on file" for anyone.
   */
  humanId: string | null;
  signupId: string;
  waiverTemplateId: string;
  waiverVersion: number;
  waiverBodyHash: string;
  acceptedAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface CreateVolunteerWaiverAcceptanceInput {
  /** Null for a contact-only signup — see VolunteerWaiverAcceptanceRecord. */
  humanId: string | null;
  signupId: string;
  waiverTemplateId: string;
  waiverVersion: number;
  waiverBodyHash: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export type WaiverClauseLayer = "STRUCTURAL" | "RISK_SPECIFIC";

export interface WaiverClauseRecord {
  id: string;
  slug: string;
  title: string;
  body: string;
  layer: WaiverClauseLayer;
  sortOrder: number;
  version: number;
  voidInStates: string[];
  requiredInStates: string[];
}
