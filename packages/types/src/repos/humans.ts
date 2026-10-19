export type HumanStatus = "INVITED" | "ACTIVE" | "SUSPENDED" | "BANNED";
export type HumanTrustTier =
  | "NEW"
  | "ESTABLISHED"
  | "TRUSTED"
  | "TOP"
  | "CUSTOM";
/**
 * Where this Human row originated. Drives audit/marketing-exclusion rules.
 * `POS_WALKUP` flags the per-sale phantom buyers created by anonymous
 * in-person sales (POS card or cash) — see scanner-pos-tap-to-pay spec
 * FR-004 / FR-015.
 */
export type HumanSource = "WEB" | "POS_WALKUP" | "IMPORT";

/**
 * HumanRecord is the domain entity for a user.
 * Identity fields (email, phone, username) live on AuthUser.
 */
export interface HumanRecord {
  id: string;
  name: string | null;
  status: HumanStatus;
  roles: string[];
  locale?: string | null;
  /**
   * Web light/dark appearance preference ('light' | 'dark'). Null = no explicit
   * account preference (the web layer falls back to cookie, then default).
   */
  themeMode?: string | null;
  // Saved contact details for faster checkout
  phone: string | null;
  billingAddressLine1: string | null;
  billingAddressLine2: string | null;
  billingCity: string | null;
  billingState: string | null;
  billingPostalCode: string | null;
  billingCountry: string | null;
  /** FK to the human-level default PRIMARY PayoutTerms. */
  defaultPrimaryPayoutTermsId: string | null;
  /** FK to the human-level default RESALE PayoutTerms. */
  defaultResalePayoutTermsId: string | null;
  /** Computed or overridden trust tier. */
  trustTier: HumanTrustTier;
  /** Free-text badge label for CUSTOM tier. */
  trustBadgeLabel: string | null;
  /** Optional icon key (lucide icon name) for CUSTOM badge. */
  trustBadgeIcon: string | null;
  chargebackTermsVersion?: string | null;
  chargebackTermsAcceptedAt?: Date | null;
  scannerTermsAckAt?: Date | null;
  scannerTermsAckVersion?: string | null;
  scannerTermsAckIp?: string | null;
  scannerTermsAckUserAgent?: string | null;
  /** Self-declared industry jobs (e.g. MUSICIAN, PHOTOGRAPHER). */
  jobs: string[];
  /** Genre tags (relevant when MUSICIAN is in jobs). */
  genreTags: string[];
  /** Free-text description when OTHER is in jobs. */
  otherJobDescription: string | null;
  createdAt: Date;
}

/**
 * Identity data from AuthUser (Better Auth).
 * This is the source of truth for email, phone, username, verification status.
 */
export interface AuthIdentityRecord {
  authUserId: string;
  email: string;
  emailVerified: boolean;
  phone: string | null;
  phoneVerified: boolean;
  username: string | null;
  displayUsername: string | null;
  image: string | null;
}

/**
 * Human with their auth identity joined.
 * Use this when you need identity fields (email, phone, etc).
 */
export interface HumanWithIdentity {
  human: HumanRecord;
  identity: AuthIdentityRecord;
}

/**
 * Minimal auth-user details needed by the adapter when auto-provisioning a
 * Human for a signed-in user whose signup hook failed silently.
 */
export interface AuthUserDetails {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
}

export interface CreateHumanInput {
  name: string | null;
  status: HumanStatus;
  locale?: string | null;
  /** Source of this Human row; defaults to WEB when omitted. */
  source?: HumanSource;
}

export type UpdateHumanInput = Partial<
  Pick<
    HumanRecord,
    | "name"
    | "status"
    | "locale"
    | "themeMode"
    | "phone"
    | "billingAddressLine1"
    | "billingAddressLine2"
    | "billingCity"
    | "billingState"
    | "billingPostalCode"
    | "billingCountry"
    | "defaultPrimaryPayoutTermsId"
    | "defaultResalePayoutTermsId"
    | "trustTier"
    | "trustBadgeLabel"
    | "trustBadgeIcon"
  >
>;

export interface AcceptHumanChargebackTermsInput {
  humanId: string;
  version: string;
  acceptedAt: Date;
}

export interface AckScannerTermsInput {
  humanId: string;
  version: string;
  acknowledgedAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface EnsureHumanByProviderInput {
  providerUserId: string;
  email: string;
  emailVerified?: boolean;
  name?: string | null;
}

export interface EnsureHumanByProviderResult {
  humanId: string;
  created: boolean;
}

/**
 * Input for creating or resolving a "shadow" guest Human + AuthUser pair.
 * If an AuthUser already exists for the email, we return the linked humanId.
 * Otherwise we create both a Human and a shadow AuthUser (no password, not
 * email-verified) so the guest's email is persisted and discoverable.
 */
export interface EnsureGuestHumanInput {
  email: string;
  /**
   * Display name, applied ONLY when a Human is created by this call. An
   * existing account is never renamed: the method resolves by EMAIL, and the
   * name comes from whoever typed that address (a guest form, an organiser,
   * a door sale), not the account holder (B2, owner ruling 2026-10-16: a
   * guest purchase never overwrites the account name).
   * `ensureGuestHumanKeepingName` is the usual way to call this.
   */
  name?: string;
}

export interface EnsureGuestHumanResult {
  humanId: string;
  /** True when a brand-new Human + shadow AuthUser were created this call. */
  created: boolean;
}

export interface UpdateHumanJobsInput {
  jobs: string[];
  genreTags: string[];
  otherJobDescription: string | null;
}
