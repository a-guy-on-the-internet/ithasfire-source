import type {
  AuthIdentityRecord,
  AuthUserDetails,
  AcceptHumanChargebackTermsInput,
  AckScannerTermsInput,
  CreateHumanInput,
  EnsureGuestHumanInput,
  EnsureGuestHumanResult,
  EnsureHumanByProviderInput,
  EnsureHumanByProviderResult,
  HumanRecord,
  HumanStatus,
  HumanWithIdentity,
  UpdateHumanInput,
  UpdateHumanJobsInput,
} from "@th/types/repos/humans";
import type { EntityPageRecord } from "@th/types/repos/entity-pages";
import type { OrgRole } from "@th/types/repos/authz";

import type {
  OffsetPaginatedResult,
  OffsetPaginationInput,
} from "../pagination";

/** See {@link HumansRepo.getSignInFootprint}. */
export type SignInFootprint = {
  hasPasswordCredential: boolean;
  /** Non-password providers linked (e.g. "google", "apple"). */
  linkedProviders: string[];
  passkeys: number;
  hasPhoneNumber: boolean;
  phoneNumberVerified: boolean;
  twoFactorEnabled: boolean;
  activeApiKeys: number;
  /** HumanDelegate rows where this human is the PRINCIPAL. */
  delegateGrants: number;
};

export type HumanWithPage = {
  human: HumanRecord;
  page: Pick<
    EntityPageRecord,
    "ownerId" | "slug" | "displayName" | "avatarUrl" | "bannerUrl"
  >;
  identity?: AuthIdentityRecord;
};

/** Org membership summary for the platform humans table. */
export type HumanOrgMembershipSummary = {
  orgId: string;
  orgName: string;
  orgSlug: string;
  role: OrgRole;
};

/** Human with identity + org memberships for platform admin listing. */
export type HumanWithMemberships = {
  human: HumanRecord;
  identity: AuthIdentityRecord | null;
  memberships: HumanOrgMembershipSummary[];
};

/** Filter/sort input for the platform humans listing. */
export type ListAllHumansWithMembershipsInput = OffsetPaginationInput & {
  searchQuery?: string;
  status?: HumanStatus;
  emailVerified?: boolean;
  /** Restrict to these humans (the "Flagged sign-ups" filter). */
  humanIds?: string[];
  sort?: "createdAt_asc" | "createdAt_desc" | "name_asc" | "name_desc";
};

export interface HumansRepo {
  getById(id: string): Promise<HumanRecord | null>;

  /**
   * Batch-fetch humans by ID.
   * Returns records only for IDs that exist; missing IDs are silently omitted.
   */
  getByIds(ids: string[]): Promise<HumanRecord[]>;

  /**
   * Get a Human with their AuthUser identity data joined.
   * Use this when you need email, phone, username, etc.
   */
  getByIdWithIdentity(id: string): Promise<HumanWithIdentity | null>;

  /**
   * The subset of `humanIds` whose AuthUser has a verified email
   * (`AuthUser.emailVerified`). One query; duplicates collapse; an empty
   * input returns `[]` without querying; a human with no AuthUser is
   * absent. Fan-outs use it to keep holder-only content off accounts that
   * never proved their address (B2, account squatting through guest
   * checkout).
   */
  listEmailVerifiedIds(humanIds: readonly string[]): Promise<string[]>;

  /**
   * When this human actually created their account (owner ruling
   * 2026-10-07: "A new account is new the moment it gets created", i.e. their
   * first sign-in). Read from AuthUser.firstSignedInAt, stored once by the
   * `session.create.after` auth hook (`stampFirstSignInIfUnset`) and never
   * cleared, except by the unproven-account sweep, where the inbox prover's
   * sign-in becomes the first sign-in. Combined (earliest
   * wins) with the oldest of their sign-in methods (AuthAccount: password,
   * Google, Apple), sessions and passkeys, which covers a missing stamp.
   *
   * Not the AuthUser's own `createdAt`: a guest checkout (`ensureGuestHuman`)
   * creates that row without a sign-in, and a later sign-in takes it over, so
   * it would date the account from the checkout. Not the Human row's either
   * (INVITED, POS walk-up and imported humans predate any account). Because
   * the first sign-in is stored, deleting sessions no longer makes an account
   * look new.
   *
   * Null when the human has no AuthUser, or has one that never signed in
   * (a guest-checkout shadow).
   */
  getAccountCreatedAt(humanId: string): Promise<Date | null>;

  /**
   * Record the AuthUser's first sign-in: set `firstSignedInAt = at` only
   * while it is still null, in one guarded UPDATE, so it writes once per
   * account and every later call is a no-op. Called from the
   * `session.create.after` auth hook on every sign-in. A missing AuthUser is
   * a no-op too.
   */
  stampFirstSignInIfUnset(authUserId: string, at: Date): Promise<void>;

  /**
   * Get a Human by their AuthUser's email.
   * Returns the Human with identity data.
   */
  getByEmail(email: string): Promise<HumanWithIdentity | null>;

  /**
   * Get a Human by their AuthUser's phone number.
   * Returns the Human with identity data.
   */
  getByPhone(phone: string): Promise<HumanWithIdentity | null>;

  /**
   * Get a Human by their AuthUser's username (case-insensitive, exact match).
   * Returns the Human with identity data, or null when no match exists.
   */
  getByUsername(username: string): Promise<HumanWithIdentity | null>;

  /**
   * Batch-lookup humanIds for a list of email addresses by querying AuthUser.
   * Returns a Map<email, humanId> for emails that have linked humans.
   * Missing or unlinked emails are silently omitted from the result.
   */
  batchLookupHumanIdsByEmail(emails: string[]): Promise<Map<string, string>>;

  /**
   * Resolve a domain `Human` for a Better Auth user id.
   *
   * Better Auth is authoritative for auth identity; we persist the linkage
   * between Better Auth's `user.id` and our domain `Human.id` in `AuthUser`.
   */
  getHumanIdForAuthUserId(
    authUserId: string,
  ): Promise<{ humanId: string } | null>;

  /**
   * `getHumanIdForAuthUserId` plus the linked Human's `status`, in one read.
   *
   * The per-request auth path (`BetterAuthAuthNAdapter.ensureAuthedHuman`)
   * uses this so a SUSPENDED/BANNED human is refused without a second query.
   * When `opts.sessionId` is given, the same read also reports whether that
   * session still exists and is unexpired (`sessionActive`); otherwise
   * `sessionActive` is null. Returns null when the AuthUser does not exist or
   * is not linked to a Human.
   */
  getAuthActorForAuthUserId(
    authUserId: string,
    opts?: { sessionId?: string; now?: Date },
  ): Promise<{
    humanId: string;
    status: HumanStatus;
    sessionActive: boolean | null;
  } | null>;

  /**
   * Fetch minimal auth-user details by Better Auth user id.
   *
   * Used by the auth adapter to auto-provision a domain Human when the
   * signup-time hook failed silently and left the AuthUser unlinked.
   */
  getAuthUserById(authUserId: string): Promise<AuthUserDetails | null>;

  /**
   * Acquire a transaction-scoped advisory lock keyed on an `AuthUser.id`.
   *
   * MUST be called as the first statement inside the provisioning transaction
   * so concurrent provisions for the SAME auth user serialize: the lock is
   * held until the surrounding transaction commits/rolls back, after which the
   * next waiter proceeds and observes the committed `AuthUser.humanId` link
   * (so it no-ops instead of creating a duplicate `Human`).
   *
   * This is a no-op on backends without advisory locks; the Postgres adapter
   * uses `pg_advisory_xact_lock`.
   */
  lockForAuthUser(authUserId: string): Promise<void>;

  /**
   * Link a Better Auth user (`AuthUser.id`) to a domain `Human.id`.
   *
   * This MUST be safe to call multiple times and should be executed inside a
   * transaction alongside provisioning/upserting the `Human` record.
   */
  linkAuthUserToHuman(input: {
    authUserId: string;
    humanId: string;
  }): Promise<{ humanId: string }>;

  /**
   * Search humans by email (exact), username, or display name (case-insensitive prefix).
   * Used for transfer recipient lookup. Excludes the given humanId (the actor).
   */
  searchByQuery(
    query: string,
    opts?: { limit?: number; excludeHumanId?: string },
  ): Promise<HumanWithIdentity[]>;

  create(input: CreateHumanInput): Promise<HumanRecord>;
  update(id: string, updates: UpdateHumanInput): Promise<HumanRecord>;

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

  /**
   * Persist the human's web light/dark appearance preference.
   * Self-scoped write: callers must pass the authenticated caller's own
   * humanId (there is no cross-user path). Idempotent.
   */
  setThemeMode(humanId: string, mode: "light" | "dark"): Promise<void>;
  acceptChargebackTerms(
    input: AcceptHumanChargebackTermsInput,
  ): Promise<HumanRecord>;
  acknowledgeScannerTerms(input: AckScannerTermsInput): Promise<HumanRecord>;
  updateJobs(id: string, input: UpdateHumanJobsInput): Promise<HumanRecord>;
  ensureByProvider(
    input: EnsureHumanByProviderInput,
  ): Promise<EnsureHumanByProviderResult>;

  /**
   * Resolve or create a "shadow" guest Human + AuthUser.
   *
   * If an AuthUser with the given email already exists and is linked to a
   * Human, returns that humanId and changes nothing on it (never renames;
   * `input.name` applies only to a Human this call creates). Otherwise
   * creates a new Human (ACTIVE) and a shadow AuthUser (emailVerified=false,
   * no password) linked together so the guest's email is persisted and
   * discoverable for future sign-up merging.
   *
   * The existing account may be UNVERIFIED (anyone can sign up with any
   * address), so what this attaches must not be shown to it until it proves
   * the inbox: the own-orders/tickets surfaces refuse an unverified actor
   * (B2, tRPC `verifiedEmailProcedure`).
   */
  ensureGuestHuman(
    input: EnsureGuestHumanInput,
  ): Promise<EnsureGuestHumanResult>;

  listForSearchIndex(
    input: OffsetPaginationInput,
  ): Promise<OffsetPaginatedResult<HumanWithPage>>;

  /**
   * Paginated listing of all humans with identity + org memberships.
   * Used by the platform admin humans table.
   */
  listAllWithMemberships(
    input: ListAllHumansWithMembershipsInput,
  ): Promise<OffsetPaginatedResult<HumanWithMemberships>>;

  // ── Admin methods (platform human management) ────────────────────────

  /**
   * List OAuth/credential accounts linked to a human's AuthUser.
   * Returns providerId + accountId pairs for display in admin UI.
   */
  listAuthAccounts(humanId: string): Promise<
    {
      providerId: string;
      accountId: string;
      createdAt: Date;
    }[]
  >;

  /**
   * Unlink a specific OAuth provider from a human's AuthUser.
   * Deletes the AuthAccount row. Throws if it's the only account
   * (credential) and the user has no password — they'd be locked out.
   */
  unlinkAuthAccount(input: {
    humanId: string;
    providerId: string;
  }): Promise<void>;

  /**
   * Whether the human has a `credential`-provider `AuthAccount` (i.e. a
   * password) linked to their AuthUser. `false` for OAuth/passkey-only
   * accounts (Google/Apple/passkey) as well as unlinked/shadow AuthUsers.
   */
  hasPasswordCredential(humanId: string): Promise<boolean>;

  /**
   * Whether the human has ANY enrolled second factor: a Better Auth
   * `twoFactor` plugin secret (`AuthUser.twoFactorEnabled`) OR at least one
   * enrolled WebAuthn passkey (`Passkey` rows keyed by `AuthUser.id`).
   * `false` (never throws) when there is no linked AuthUser at all.
   *
   * Backs the platform/moderation staff step-up 2FA gate — see
   * `packages/transport/trpc/src/guard.ts`.
   */
  hasSecondFactorEnrolled(humanId: string): Promise<boolean>;

  /**
   * Verify a plaintext password against the human's stored credential
   * password hash. Returns `false` (never throws) when there is no linked
   * AuthUser, no `credential` AuthAccount, or no password hash set — callers
   * should treat any `false` as "not verified" without distinguishing why.
   */
  verifyPassword(humanId: string, password: string): Promise<boolean>;

  /**
   * Force-set emailVerified on the human's AuthUser.
   */
  forceVerifyEmail(humanId: string): Promise<void>;

  /**
   * What can currently sign in to (or act for) this human's account: the
   * password credential, other linked providers, passkeys, phone number,
   * active API keys and delegate grants it made. Read-only. Used by
   * `adminForceVerifyEmail` so staff SEE what an unverified account carries
   * before vouching for its address (a squatter may have attached these).
   * Returns null when the human has no AuthUser.
   */
  getSignInFootprint(humanId: string): Promise<SignInFootprint | null>;

  /**
   * Whether the human holds any row an email-resolved path attaches to an
   * EXISTING account: an order it bought, a ticket it owns, a volunteer
   * coordinator seat or a lineup link (B2, owner ruling 2026-10-16). Same
   * definition as the email-change refusal in
   * `apps/api/src/auth/unproven-email-move.ts`. Read-only; a lookup error
   * THROWS so callers fail closed. Used by `adminForceVerifyEmail` to refuse
   * vouching for an unverified address that would hand those rows over.
   */
  holdsEmailAttachedRows(humanId: string): Promise<boolean>;

  /**
   * Batched `holdsEmailAttachedRows`: of `humanIds`, the ids that hold at least
   * one email-attached row (same four definitions, 4 queries in total however
   * many ids). Empty input returns `[]` without a query. A lookup error
   * THROWS, like the single-id form. Used by the `/platform/humans` roster.
   */
  listHumanIdsHoldingEmailAttachedRows(humanIds: string[]): Promise<string[]>;

  /**
   * Invalidate all active sessions for a human's AuthUser.
   * Used after suspend/ban to force logout.
   */
  invalidateAllSessions(humanId: string): Promise<{ count: number }>;

  /**
   * Every AuthUser whose email delivers to `canonicalEmail` — the form core's
   * `canonicalEmail` produces (lowercase + trim, `+tag` stripped, Gmail dots
   * dropped and googlemail.com folded into gmail.com). Ban that sticks: finds
   * a banned human's alt accounts on the same mailbox. `humanId` is null for
   * an AuthUser not linked to a Human yet.
   */
  listAuthUsersByCanonicalEmail(
    canonicalEmail: string,
  ): Promise<Array<{ authUserId: string; humanId: string | null }>>;

  /** Delete every session of these AuthUsers. Returns the rows deleted. */
  invalidateSessionsForAuthUsers(
    authUserIds: string[],
  ): Promise<{ count: number }>;

  /**
   * Hard-delete a human and all associated data.
   * Cascades through AuthUser → AuthAccount, AuthSession.
   * Also deletes: OrgMember rows, push devices, API keys,
   * notification preferences, entity pages.
   * Orders, tickets, and financial records are NOT deleted
   * (orphaned with humanId preserved for audit).
   */
  deleteHuman(humanId: string): Promise<void>;

  /**
   * Whether the human has any history behind a `Human` FK column that is
   * `ON DELETE RESTRICT` (orders placed, tickets owned/scanned/transferred,
   * resale claims/listings/holds). `deleteHuman` would otherwise fail with an
   * unhandled Postgres FK-constraint violation for any human with real
   * transaction history — this lets callers fail with a clear, typed error
   * instead.
   */
  hasDeletionBlockingHistory(humanId: string): Promise<boolean>;

  /**
   * Aggregate trust stats for a human organizer.
   * Used by the trust-profile use case for tier computation.
   */
  getHumanTrustStats(humanId: string): Promise<{
    completedEventCount: number;
    totalTicketsSold: number;
    disputeRate: number;
    accountAgeDays: number;
    hasContactEmail: boolean;
    hasVerifiedVenue: boolean;
  }>;
}

export type {
  AuthIdentityRecord,
  AuthUserDetails,
  AcceptHumanChargebackTermsInput,
  AckScannerTermsInput,
  CreateHumanInput,
  EnsureGuestHumanInput,
  EnsureGuestHumanResult,
  EnsureHumanByProviderInput,
  EnsureHumanByProviderResult,
  HumanRecord,
  HumanStatus,
  HumanWithIdentity,
  UpdateHumanInput,
  UpdateHumanJobsInput,
} from "@th/types/repos/humans";
