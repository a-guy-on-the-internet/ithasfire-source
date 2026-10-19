import type {
  RoleTemplateRecord,
  RoleTemplateShiftRecord,
  RoleTemplateShiftDraft,
  RoleTemplateWithShiftsRecord,
  CreateRoleTemplateInput,
  UpdateRoleTemplateInput,
  VolunteerPackStatus,
  VolunteerPackRecord,
  VolunteerPackWithCountsRecord,
  VolunteerPackWithRolesRecord,
  CreateVolunteerPackInput,
  UpdateVolunteerPackInput,
  CreatePlatformRoleTemplateInput,
  VolunteerShiftAnchor,
  EventVolunteerRoleRecord,
  EventVolunteerRoleWithShiftsRecord,
  CreateEventVolunteerRoleInput,
  UpdateEventVolunteerRoleInput,
  VolunteerShiftRecord,
  CreateVolunteerShiftInput,
  UpdateVolunteerShiftInput,
  VolunteerSignupRecord,
  CreateVolunteerSignupInput,
  UpdateVolunteerSignupStatusInput,
  ListVolunteerSignupsOpts,
  ListVolunteerSignupsCursorOpts,
  VolunteerSignupCursorPage,
  VolunteerSignupStatus,
  VolunteerSignupEmailKey,
  ShiftReminderCandidate,
  FindShiftsNeedingReminderInput,
  RecordShiftNotificationInput,
  FindStartReminderCandidatesInput,
  EventStartReminderCandidate,
  AskStartReminderCandidate,
  HoursReportRow,
  OrgVolunteerHoursRange,
  OrgVolunteerHoursRow,
  VolunteerReminderKind,
  VolunteerReminderChannel,
  VolunteerSubjectType,
  VolunteerAskStatus,
  VolunteerAskCadence,
  VolunteerAskRecord,
  CreateVolunteerAskInput,
  UpdateVolunteerAskInput,
  VolunteerGroupRecord,
  VolunteerGroupCoordinatorInfo,
  VolunteerGroupWithRosterInfoRecord,
  CreateVolunteerGroupInput,
  UpdateVolunteerGroupInput,
  VolunteerBroadcastScopeType,
  VolunteerBroadcastScope,
  VolunteerBroadcastRecord,
  CreateVolunteerBroadcastInput,
  VolunteerBroadcastRecipient,
  VolunteerFeedSignupRecord,
  VolunteerCommitmentRecord,
  VolunteerCommitmentReminderBasis,
  VolunteerRewardTrigger,
  VolunteerRewardGrantStatus,
  VolunteerRewardRecord,
  UpsertVolunteerRewardInput,
  VolunteerRewardBudgetLock,
  VolunteerRewardGrantRecord,
  CreateVolunteerRewardGrantInput,
  UpdateVolunteerRewardGrantStatusInput,
  ListRewardGrantsByAskOpts,
  VolunteerRewardGrantLedgerRow,
  VolunteerRewardGrantStatusBySignup,
  VolunteerOccurrenceStatus,
  VolunteerOccurrenceClaimStatus,
  VolunteerOccurrenceClaimSource,
  VolunteerShiftOccurrenceRecord,
  VolunteerShiftOccurrenceWithClaimCountRecord,
  CreateVolunteerShiftOccurrenceInput,
  UpdateVolunteerShiftOccurrenceInput,
  ListVolunteerOccurrencesOpts,
  VolunteerOccurrenceClaimRecord,
  CreateVolunteerOccurrenceClaimInput,
  UpdateVolunteerOccurrenceClaimInput,
  VolunteerOccurrenceClaimRosterRow,
} from "@th/types";

import type { OffsetPaginatedResult } from "../pagination";

export interface VolunteerRepo {
  // ── Generic asks ────────────────────────────────────────────────────
  /**
   * Create a generic volunteer ask. The DB enforces at most ONE
   * EVENT-subject ask per event via a raw partial unique index
   * (`VolunteerAsk_event_subject_key`); a race loser surfaces as
   * `{ code: "duplicate_event_ask" }` — same convention as the
   * booking-requests open-pair conflict. Core still pre-checks via
   * `listAsksBySubject` for the friendly path.
   */
  createAsk(input: CreateVolunteerAskInput): Promise<VolunteerAskRecord>;
  /**
   * Race-safe insert-if-absent variant of `createAsk` for the lazy
   * EVENT-ask resolution path (`resolveOrCreateEventAsk`). Implemented as
   * `createMany({ skipDuplicates: true })` — ON CONFLICT DO NOTHING — so a
   * unique-index race loser does NOT abort the surrounding Postgres
   * transaction the way a plain `createAsk` P2002 does (25P02: every later
   * statement in the tx, including a recovery re-read, would fail).
   * Returns nothing; callers re-read the winner via `listAsksBySubject`.
   * Management flows keep using `createAsk`, where the surfaced
   * `duplicate_event_ask` conflict is the desired user-facing error.
   */
  createAskIfAbsent(input: CreateVolunteerAskInput): Promise<void>;
  /** Partial patch, including status transitions. Subject is immutable. */
  updateAsk(
    id: string,
    input: UpdateVolunteerAskInput,
  ): Promise<VolunteerAskRecord>;
  /**
   * Set / replace / clear (null) the ask's waiver template
   * (ask-level-volunteer-waivers spec). Dumb write — template existence
   * and ownership validation live in core (`assignWaiverToAsk`), the
   * single validation path. Deliberately NOT part of `updateAsk` so a
   * broad field patch can never silently re-point a liability gate.
   * Returns the freshly read ask row.
   */
  setAskWaiverTemplate(input: {
    askId: string;
    waiverTemplateId: string | null;
  }): Promise<VolunteerAskRecord>;
  getAsk(id: string): Promise<VolunteerAskRecord | null>;
  /**
   * Batched owner lookup: each ask's `subjectType` + `subjectId`, in ONE
   * query, for the given ids. Unknown ids are simply absent; order is not
   * guaranteed. Exists so a list read (`listMyVolunteerCommitments`) can
   * check every row's owner against `bans.findBannedOwners` without a
   * `getAsk` per row.
   *
   * For an EVENT ask `subjectId` is the event id, so the row also carries
   * `eventOwner`: that event's owning human or org (exclusive; both null
   * for an ownerless community listing or a missing event). Resolved with
   * at most ONE extra batched read. Null/absent for every other subject.
   */
  listAskOwnersByIds(askIds: string[]): Promise<
    Array<{
      id: string;
      subjectType: VolunteerSubjectType;
      subjectId: string;
      eventOwner?: { humanId: string | null; orgId: string | null } | null;
    }>
  >;
  /** All asks posted against one subject, newest first. */
  listAsksBySubject(
    subjectType: VolunteerSubjectType,
    subjectId: string,
  ): Promise<VolunteerAskRecord[]>;
  /**
   * Standing-asks dashboard listing via the denormalized `orgId`, newest
   * first. EVENT-subject asks are excluded — those are managed on the
   * per-event volunteer page, and every volunteering-enabled event backfills
   * one on the org's `orgId`. Only ORG/PLACE/HUMAN standing asks come back.
   */
  listAsksByOrg(
    orgId: string,
    opts?: { status?: VolunteerAskStatus },
  ): Promise<VolunteerAskRecord[]>;

  // ── Volunteer groups ────────────────────────────────────────────────
  /**
   * Create a volunteer group under an ask. Group names are unique per ask
   * (`@@unique([askId, name])`); a duplicate surfaces as
   * `{ code: "duplicate_group_name" }` — same convention as
   * `duplicate_event_ask` on `createAsk`.
   */
  createGroup(input: CreateVolunteerGroupInput): Promise<VolunteerGroupRecord>;
  updateGroup(
    id: string,
    input: UpdateVolunteerGroupInput,
  ): Promise<VolunteerGroupRecord>;
  getGroup(id: string): Promise<VolunteerGroupRecord | null>;
  /**
   * Groups of an ask with roster aggregates: accepted member count
   * (APPROVED | CHECKED_IN) and coordinator display info in one query —
   * no N+1 (mirrors how the hours report joins the human).
   */
  listGroupsByAsk(askId: string): Promise<VolunteerGroupWithRosterInfoRecord[]>;
  /** Set / replace / clear (null) the single coordinator on a group. */
  setGroupCoordinator(
    groupId: string,
    coordinatorHumanId: string | null,
  ): Promise<VolunteerGroupRecord>;
  /**
   * Compare-and-swap variant: writes `next` ONLY if the group's coordinator
   * is still `expected`, else returns null and writes nothing. Lets two
   * concurrent assignments of the same change resolve to one write (and
   * one notice) instead of two.
   */
  setGroupCoordinatorIfCurrent(
    groupId: string,
    expected: string | null,
    next: string | null,
  ): Promise<VolunteerGroupRecord | null>;
  /** Members fall back to the general pool (FK SetNull), never deleted. */
  deleteGroup(id: string): Promise<void>;

  // ── Volunteer packs (staff-curated catalogue metadata) ──────────────
  //
  // Packs hold no roles of their own; catalogue roles are ordinary
  // `VolunteerRoleTemplate` rows with `packId` set. Every method here is
  // PLATFORM-scoped — none of them can reach an org's rows.

  createPack(input: CreateVolunteerPackInput): Promise<VolunteerPackRecord>;
  updatePack(
    id: string,
    input: UpdateVolunteerPackInput,
  ): Promise<VolunteerPackRecord>;
  getPack(id: string): Promise<VolunteerPackRecord | null>;
  /** Lookup by the stable seed slug. */
  getPackByKey(key: string): Promise<VolunteerPackRecord | null>;
  /**
   * Staff catalogue list. `status` unset = every pack, DRAFT included — this
   * is the STAFF read; organizer-facing callers must pass `status: "LIVE"`
   * or use `listLivePacksWithRoles`. Carries the catalogue-role and
   * org-fork counts (FR-014) so the list is one query set, not an N+1.
   */
  listPacks(opts?: {
    status?: VolunteerPackStatus;
  }): Promise<VolunteerPackWithCountsRecord[]>;
  /**
   * Deletes the pack row ONLY. Its platform roles must already be gone —
   * `VolunteerRoleTemplate_platform_pack_check` turns the FK's SET NULL on a
   * surviving platform row into a CHECK violation, so this throws rather
   * than orphaning catalogue rows. Call
   * `deletePlatformRoleTemplatesByPack` first, in the same transaction.
   * Org-owned forks SET NULL freely and survive.
   */
  deletePack(id: string): Promise<void>;
  /**
   * LIVE packs with their catalogue roles and shift presets, for the
   * organizer picker. DRAFT packs are unreachable through this method by
   * construction, so no organizer-facing path can leak unpublished content.
   */
  listLivePacksWithRoles(): Promise<VolunteerPackWithRolesRecord[]>;
  /**
   * One pack with its catalogue roles + shifts REGARDLESS of status — the
   * staff preview read (FR-016). Never call this from an organizer-facing
   * path; it is deliberately status-blind.
   */
  getPackWithRoles(id: string): Promise<VolunteerPackWithRolesRecord | null>;

  // ── Platform (catalogue) role templates ─────────────────────────────
  /**
   * Create a catalogue row: `orgId` NULL, `isPlatform` true, `packId` from
   * the input. Neither `orgId` nor `isPlatform` is caller-settable, so no
   * organizer-facing path can mint one.
   */
  createPlatformRoleTemplate(
    input: CreatePlatformRoleTemplateInput,
  ): Promise<RoleTemplateRecord>;
  /**
   * Hard-delete catalogue rows by id. The where clause pins
   * `isPlatform: true`, so passing an org row's id is a silent no-op rather
   * than data loss. Returns the number actually deleted.
   */
  deletePlatformRoleTemplates(ids: string[]): Promise<number>;
  /**
   * Hard-delete every catalogue row of a pack (`packId` + `isPlatform`).
   * Org-owned forks carrying the same `packId` are NOT matched. Returns the
   * number deleted.
   */
  deletePlatformRoleTemplatesByPack(packId: string): Promise<number>;
  /** Catalogue rows still attached to a pack — the pre-delete race guard. */
  countPlatformRoleTemplatesByPack(packId: string): Promise<number>;

  // ── Role templates (org-owned + platform catalogue) ─────────────────
  /** Creates an ORG-OWNED row only — `CreateRoleTemplateInput.orgId` is required. */
  createRoleTemplate(
    input: CreateRoleTemplateInput,
  ): Promise<RoleTemplateRecord>;
  updateRoleTemplate(
    id: string,
    input: UpdateRoleTemplateInput,
  ): Promise<RoleTemplateRecord>;
  archiveRoleTemplate(id: string): Promise<void>;
  /**
   * Templates visible to `orgId`.
   *
   * Default (`includePlatform` unset/false) = THIS ORG'S ROWS ONLY. Platform
   * catalogue rows have `orgId` null so they can never match the org filter
   * — which is what the name-collision prechecks want, since the DB unique
   * is `(orgId, name)`.
   *
   * `includePlatform: true` = org rows PLUS platform rows whose pack is
   * LIVE, in one query (NFR-003). DRAFT packs' roles are never returned by
   * this method, so no organizer-facing path can leak them.
   */
  listRoleTemplates(
    orgId: string,
    opts?: { includeArchived?: boolean; includePlatform?: boolean },
  ): Promise<RoleTemplateRecord[]>;
  /**
   * Fetch by id with NO tenancy filter — the raw row, platform or any org's.
   * Callers must decide what to do with it; mutating callers must reject
   * `isPlatform` rows and rows whose `orgId` isn't theirs. Prefer
   * `getRoleTemplateUsableBy` for anything org-scoped.
   */
  getRoleTemplate(id: string): Promise<RoleTemplateRecord | null>;
  /**
   * Fetch a template that `orgId` is allowed to USE (apply to an event/ask,
   * read for defaults): the org's own row, or a platform row whose pack is
   * LIVE. Anything else — another org's row, a platform row in a DRAFT pack
   * — returns null, so callers 404 without confirming the row exists.
   *
   * `orgId: null` (an ask with no owning org) matches LIVE platform rows
   * only; it must never fall through to "any row".
   */
  getRoleTemplateUsableBy(
    id: string,
    orgId: string | null,
  ): Promise<RoleTemplateRecord | null>;

  // ── Role-template shift presets ─────────────────────────────────────
  /**
   * Replace the full shift list for a template in one call. Easier to
   * reason about than per-shift CRUD because the template editor lets
   * the user reorder, add, and remove rows in a single edit session —
   * the use case can compute the new desired set, hand it off here, and
   * let the adapter run the diff inside a transaction.
   */
  upsertRoleTemplateShifts(
    templateId: string,
    shifts: RoleTemplateShiftDraft[],
  ): Promise<RoleTemplateShiftRecord[]>;
  listRoleTemplateShifts(
    templateId: string,
  ): Promise<RoleTemplateShiftRecord[]>;
  /** Convenience getter — template plus its shift list in one round trip. */
  getRoleTemplateWithShifts(
    id: string,
  ): Promise<RoleTemplateWithShiftsRecord | null>;
  /**
   * Batch read used by the apply-template flow so we can fetch shifts
   * for N templates without N+1 queries.
   */
  listRoleTemplateShiftsByTemplateIds(
    templateIds: string[],
  ): Promise<Record<string, RoleTemplateShiftRecord[]>>;

  // ── Event volunteer roles ───────────────────────────────────────────
  /**
   * Create a volunteer role owned by exactly one of eventId/askId. Role
   * names are unique per owner (`@@unique([eventId, name])` /
   * `@@unique([askId, name])`); a duplicate on either surfaces as
   * `{ code: "duplicate_role_name" }` — same convention as
   * `duplicate_event_ask` on `createAsk`.
   */
  createEventRole(
    input: CreateEventVolunteerRoleInput,
  ): Promise<EventVolunteerRoleRecord>;
  updateEventRole(
    id: string,
    input: UpdateEventVolunteerRoleInput,
  ): Promise<EventVolunteerRoleRecord>;
  deleteEventRole(id: string): Promise<void>;
  listEventRoles(
    eventId: string,
  ): Promise<EventVolunteerRoleWithShiftsRecord[]>;
  /** Roles owned by a generic ask — mirrors `listEventRoles`. */
  listRolesByAsk(askId: string): Promise<EventVolunteerRoleWithShiftsRecord[]>;
  getEventRole(id: string): Promise<EventVolunteerRoleWithShiftsRecord | null>;

  // ── Shifts ──────────────────────────────────────────────────────────
  createShift(input: CreateVolunteerShiftInput): Promise<VolunteerShiftRecord>;
  getShift(id: string): Promise<VolunteerShiftRecord | null>;
  updateShift(
    id: string,
    input: UpdateVolunteerShiftInput,
  ): Promise<VolunteerShiftRecord>;
  deleteShift(id: string): Promise<void>;
  listShifts(roleId: string): Promise<VolunteerShiftRecord[]>;

  // ── Signups ─────────────────────────────────────────────────────────
  createSignup(
    input: CreateVolunteerSignupInput,
  ): Promise<VolunteerSignupRecord>;
  updateSignupStatus(
    id: string,
    input: UpdateVolunteerSignupStatusInput,
  ): Promise<VolunteerSignupRecord>;
  /**
   * Narrow contact-preference write — currently just the per-signup
   * `smsOptIn` flag (Gap 6). Deliberately separate from
   * `updateSignupStatus` so the volunteer-facing toggle can never touch
   * review state. The use case enforces ownership and the
   * phone-required-to-enable rule; this is a dumb write. Returns the
   * freshly read signup row. `contactPhone`, when given, replaces the
   * stored number (the use case passes the E.164 form when SMS is turned
   * on, so a number kept as typed becomes sendable).
   */
  updateSignupContactPrefs(
    id: string,
    input: { smsOptIn: boolean; contactPhone?: string },
  ): Promise<VolunteerSignupRecord>;
  getSignup(id: string): Promise<VolunteerSignupRecord | null>;
  /**
   * Duplicate lookup on either uniqueness key: the legacy event-scoped
   * `(eventId, roleId, contactEmail)` or the ask-scoped
   * `(askId, roleId, contactEmail)`.
   */
  getSignupByEmail(
    key: VolunteerSignupEmailKey,
  ): Promise<VolunteerSignupRecord | null>;
  listSignups(
    eventId: string,
    opts?: ListVolunteerSignupsOpts,
  ): Promise<OffsetPaginatedResult<VolunteerSignupRecord>>;
  /**
   * Ask-scoped signup listing — mirrors `listSignups`. The `groupId`
   * opt is the roster primitive: a string returns ONLY that group's
   * signups (coordinator PII scoping in core relies on this never
   * leaking cross-group rows) and explicit `null` returns unassigned
   * signups — `{ groupId: null, status: "APPROVED" }` is the ask's
   * general pool.
   */
  listSignupsByAsk(
    askId: string,
    opts?: ListVolunteerSignupsOpts,
  ): Promise<OffsetPaginatedResult<VolunteerSignupRecord>>;
  /**
   * Keyset-cursor variant of `listSignupsByAsk` for the roster reads
   * (list-ask-roster general pool, list-coordinator-roster group members).
   * Same filters and the same `groupId` scoping contract (a string narrows
   * to EXACTLY that group's rows — coordinator PII scoping in core relies
   * on this never leaking cross-group rows). Ordering is a stable compound
   * keyset (`createdAt` desc, `id` desc) so no row is skipped or duplicated
   * across pages; the cursor is value-based (survives the boundary row
   * being deleted/reassigned — mirrors event-saves) and opaque to callers.
   * A malformed cursor restarts from the first page rather than 500ing.
   */
  listSignupsByAskCursor(
    askId: string,
    opts?: ListVolunteerSignupsCursorOpts,
  ): Promise<VolunteerSignupCursorPage>;
  /**
   * Move a signup into / between / out of (null) a group. Dumb write —
   * core enforces same-ask + coordinator scope. Returns the fresh row.
   */
  assignSignupToGroup(
    signupId: string,
    groupId: string | null,
  ): Promise<VolunteerSignupRecord>;
  listSignupsByHuman(humanId: string): Promise<VolunteerSignupRecord[]>;
  /**
   * Disable `smsOptIn` on every signup whose `contactPhone` matches the given
   * E.164 number. Used by the SMS opt-out use case so a STOP reply (or manual
   * support opt-out) unsubscribes the volunteer from reminder SMS everywhere.
   * Returns the number of signups updated. Idempotent: re-running after the
   * flags are already cleared updates zero rows.
   */
  clearSmsOptInByPhone(phoneE164: string): Promise<number>;
  countByRole(eventId: string): Promise<Record<string, number>>;
  countByShift(roleId: string): Promise<Record<string, number>>;
  /**
   * Count active signups (PENDING | APPROVED | CHECKED_IN) per shift across
   * all roles of a single event in one query. Returns a flat map keyed by
   * `shiftId`. Shifts with zero signups are omitted.
   */
  countByShiftForEvent(eventId: string): Promise<Record<string, number>>;
  /**
   * Count accepted occupancy (APPROVED | CHECKED_IN) for a single shift or
   * role. The role branch counts every accepted signup on the role —
   * including ones that also picked a shift — because role capacity caps
   * the role as a whole. PENDING never counts: capacity gates acceptance,
   * not application.
   *
   * Locks the parent shift/role row (`SELECT … FOR UPDATE`) before counting
   * so concurrent approvals serialize. Only meaningful inside `repos.tx(...)`
   * — the lock is held until the transaction commits, which makes the count
   * plus a subsequent status update race-safe. Outside a transaction the
   * lock releases immediately and provides no protection.
   */
  countAcceptedOccupancy(
    target: { shiftId: string } | { roleId: string },
  ): Promise<number>;
  /**
   * Count PENDING signups for a single shift or role — the "waitlist depth"
   * behind one spot. The role branch counts every pending signup on the
   * role, shifted or not, mirroring how `countAcceptedOccupancy` scopes
   * role capacity (a freed shiftless seat is claimable by any applicant on
   * the role). Unlike `countAcceptedOccupancy` this takes no row lock —
   * it's an informational read for the spot-opened notification (Gap 9),
   * not a capacity gate.
   */
  countPendingSignups(
    target: { shiftId: string } | { roleId: string },
  ): Promise<number>;
  /**
   * Accepted-only (APPROVED | CHECKED_IN) signup counts per role for one
   * event. Mirrors `countByRole` but excludes PENDING — used by the public
   * roles list to show real occupancy against capacity. Roles with zero
   * accepted signups are omitted.
   */
  countAcceptedByRole(eventId: string): Promise<Record<string, number>>;
  /**
   * Accepted-only (APPROVED | CHECKED_IN) signup counts per shift across
   * all roles of one event. Mirrors `countByShiftForEvent` but excludes
   * PENDING. Shifts with zero accepted signups are omitted.
   */
  countAcceptedByShiftForEvent(
    eventId: string,
  ): Promise<Record<string, number>>;
  /**
   * Count signups across many events in one query, grouped by event and
   * status. Used by the admin events list to surface "needs review" counts
   * per row without an N+1 fetch. Events with zero signups are omitted from
   * the returned map.
   */
  countByEventsAndStatus(
    eventIds: string[],
  ): Promise<Record<string, Partial<Record<VolunteerSignupStatus, number>>>>;

  // ── Shift occurrences + claims (standing asks, phase A) ─────────────
  //
  // generic-volunteer-shifts-occurrences spec. Occurrences are concrete
  // dated slots on ask-owned roles; claims are per-date commitments by
  // already-APPROVED signups. Non-EVENT asks only (enforced in core).

  createOccurrence(
    input: CreateVolunteerShiftOccurrenceInput,
  ): Promise<VolunteerShiftOccurrenceRecord>;
  getOccurrence(id: string): Promise<VolunteerShiftOccurrenceRecord | null>;
  /**
   * `SELECT … FOR UPDATE` on the occurrence row, then a fresh re-read of it
   * under that lock — THE claim-gate serialization point. Only meaningful
   * inside `repos.tx(...)`: the lock is held until commit, so the returned
   * status/capacity/window can't be invalidated by a concurrent
   * cancel/edit/claim (a plain `getOccurrence` read taken before the lock
   * can be stale — never gate a claim on it). Returns null when the row no
   * longer exists.
   */
  getOccurrenceForUpdate(
    id: string,
  ): Promise<VolunteerShiftOccurrenceRecord | null>;
  /** Partial patch; ask/role/pattern linkage is immutable. */
  updateOccurrence(
    id: string,
    input: UpdateVolunteerShiftOccurrenceInput,
  ): Promise<VolunteerShiftOccurrenceRecord>;
  /**
   * Ask-scoped occurrence listing with per-occurrence active (CLAIMED)
   * claim counts in one query set — powers both the public schedule (open
   * slot counts) and the owner schedule tab. Ordered `startsAt` asc.
   */
  listOccurrencesByAsk(
    askId: string,
    opts?: ListVolunteerOccurrencesOpts,
  ): Promise<VolunteerShiftOccurrenceWithClaimCountRecord[]>;
  /**
   * Count active (CLAIMED) claims for one occurrence, locking the
   * occurrence row first (`SELECT … FOR UPDATE`) so concurrent claims
   * serialize — mirrors `countAcceptedOccupancy`'s lock-then-count
   * contract. Only meaningful inside `repos.tx(...)`: the lock is held
   * until commit, making count + insert race-safe.
   */
  countActiveOccurrenceClaims(occurrenceId: string): Promise<number>;
  /**
   * Insert one claim. The `@@unique([occurrenceId, signupId])` is the
   * idempotency anchor — a race loser surfaces as
   * `{ code: "duplicate_claim" }` (same convention as `duplicate_event_ask`
   * on `createAsk`). NOTE: inside an interactive Postgres tx the underlying
   * P2002 has already aborted the tx (25P02) — callers pre-read via
   * `getClaimByOccurrenceAndSignup` and treat the race loser as a full-tx
   * failure the client retries.
   */
  createOccurrenceClaim(
    input: CreateVolunteerOccurrenceClaimInput,
  ): Promise<VolunteerOccurrenceClaimRecord>;
  getOccurrenceClaim(
    id: string,
  ): Promise<VolunteerOccurrenceClaimRecord | null>;
  /** Idempotency pre-read on the (occurrence, signup) unique. */
  getClaimByOccurrenceAndSignup(
    occurrenceId: string,
    signupId: string,
  ): Promise<VolunteerOccurrenceClaimRecord | null>;
  /** Dumb patch — status transitions / check-in stamping validated in core. */
  updateOccurrenceClaim(
    id: string,
    input: UpdateVolunteerOccurrenceClaimInput,
  ): Promise<VolunteerOccurrenceClaimRecord>;
  /**
   * Roster read for one occurrence: every claim (CLAIMED and WITHDRAWN)
   * joined with the signup's contact identity + group assignment. Core
   * applies the coordinator group-scope PII filter; owners see all rows.
   * Ordered `createdAt` asc.
   */
  listClaimsByOccurrence(
    occurrenceId: string,
  ): Promise<VolunteerOccurrenceClaimRosterRow[]>;
  /**
   * Bulk-withdraw a signup's CLAIMED claims on FUTURE occurrences
   * (`occurrence.startsAt >= from`) — the signup-withdrawal cascade
   * (FR-003). Past/checked-in history is untouched. Returns the number of
   * claims flipped; idempotent (re-running flips zero).
   */
  withdrawFutureClaimsBySignup(signupId: string, from: Date): Promise<number>;

  // ── Shift reminders ─────────────────────────────────────────────────
  /**
   * Find approved signups whose shift starts within the given window.
   * Includes all relations needed by the reminder dispatcher and the
   * set of channels that have already been recorded for this kind, so
   * the dispatcher can skip them and avoid a second-query round trip.
   */
  findShiftsNeedingReminder(
    input: FindShiftsNeedingReminderInput,
  ): Promise<ShiftReminderCandidate[]>;
  /**
   * Of `eventIds`, the ones that are still ON right now: PUBLISHED (not
   * DRAFT, CANCELLED, ARCHIVED, COMPLETED) and not owner-withheld (banned).
   * The same rule `findShiftsNeedingReminder` applies, asked again just
   * before dispatch because an organiser can cancel between the two.
   */
  findEventIdsStillOn(eventIds: string[]): Promise<string[]>;
  /**
   * APPROVED event signups with no shift, on a role with NO shifts, whose
   * EVENT starts within the window (volunteer-ask-reminders R7), on events
   * still on by the same rule as `findShiftsNeedingReminder`. A signup with
   * a shift is never here (its shift is its anchor), nor a shiftless one on
   * a role that has shifts (no anchor).
   */
  findEventStartReminderCandidates(
    input: FindStartReminderCandidatesInput,
  ): Promise<EventStartReminderCandidate[]>;
  /**
   * APPROVED signups (no event, no shift) on a non-EVENT ask that is
   * ONE_TIME with its `startsAt` in the window (R1), OPEN, PAUSED or CLOSED
   * (R6), and whose owner is not withheld (the `isAskOwnerWithheld` rule).
   */
  findAskStartReminderCandidates(
    input: FindStartReminderCandidatesInput,
  ): Promise<AskStartReminderCandidate[]>;
  /**
   * Of `askIds`, the ones a reminder may still go out for right now: the
   * ask-level half of `findAskStartReminderCandidates`, asked again just
   * before dispatch because an organiser can archive (or an owner be
   * banned) between the two.
   */
  findAskIdsStillRemindable(askIds: string[]): Promise<string[]>;
  /**
   * Atomic write of "we sent this kind/channel for this signup".
   * Backed by a unique constraint on `(signupId, kind, channel)` and an
   * `ON CONFLICT DO NOTHING` insert — concurrent cron ticks racing the
   * same row both succeed but only one row exists. Returns `true` when
   * a new row was inserted (the caller should send), `false` when a
   * conflict short-circuited (someone else already sent it).
   */
  recordShiftNotification(
    input: RecordShiftNotificationInput,
  ): Promise<boolean>;
  /**
   * Best-effort delete of a notification ledger row. Used by the
   * dispatcher to roll back a claim when the downstream mailer / SMS /
   * in-app send threw — without this rollback, the failed channel
   * would be marked "sent" forever and the volunteer would silently
   * never get reminded. Safe to call when no row exists (no-op).
   */
  deleteShiftNotification(input: RecordShiftNotificationInput): Promise<void>;

  // ── Hours tracking ──────────────────────────────────────────────────
  /**
   * Admin-only override for `hoursWorked`. Pass `null` to clear and
   * fall back to scheduled hours. Returns the freshly read signup row.
   */
  updateSignupHoursWorked(input: {
    id: string;
    hoursWorked: number | null;
  }): Promise<VolunteerSignupRecord>;
  /**
   * Flat denormalised projection of every signup for an event, joined
   * with role + shift + (optional) human, ready for CSV serialisation.
   * One query, no N+1.
   */
  listSignupsForHoursReport(eventId: string): Promise<HoursReportRow[]>;
  /**
   * Org-wide cross-event hours aggregate: one row per distinct
   * volunteer (keyed by `humanId`, falling back to lowercased
   * `contactEmail` for shadow-only signups) with total hours, distinct
   * events count, and last shift date. Single grouped query — no N+1.
   *
   * Population and hours semantics intentionally mirror
   * `listSignupsForHoursReport`: every signup is included regardless of
   * status (consumers filter), and a signup's hours are the
   * `hoursWorked` override when set, else the shift's scheduled
   * duration (`endsAt - startsAt`, 2dp); shiftless signups without an
   * override contribute NULL hours (skipped by SUM, so the total is
   * unaffected) but still count toward
   * `eventsCount` / `signupsCount`. Keeping the two in lockstep is what
   * guarantees the org totals equal the sum of the per-event exports.
   *
   * `range` bounds the shift start (signup `createdAt` for shiftless
   * signups); `from` inclusive, `to` exclusive.
   *
   * `opts.acceptedOnly` narrows the population to accepted signups
   * (APPROVED | CHECKED_IN). The default (false / omitted) keeps the
   * all-statuses population above so the org totals reconcile against
   * the sum of per-event exports; acceptedOnly is the recognition /
   * grant-reporting view, where a withdrawn or rejected volunteer's
   * scheduled hours must not inflate their total.
   */
  aggregateHoursByVolunteer(
    orgId: string,
    range?: OrgVolunteerHoursRange,
    opts?: { acceptedOnly?: boolean },
  ): Promise<OrgVolunteerHoursRow[]>;

  // ── Roster broadcasts ───────────────────────────────────────────────
  /**
   * Write the audit/idempotency ledger row for a one-way announcement.
   * The send path keys on this row to never double-send on retry.
   *
   * `recipientCount` is the ADDRESSED count stamped at send time (deduped
   * contacts in scope), NOT a delivered count: dispatch happens post-commit
   * and is best-effort, so a crash between commit and the send loop loses
   * those sends silently, and a retry replays this ledger row without
   * re-sending.
   *
   * A pk collision on a client-supplied `id` (a concurrent retry losing
   * the race) surfaces as `{ code: "duplicate_broadcast" }` — same
   * convention as `duplicate_event_ask` on `createAsk`. NOTE: inside an
   * interactive Postgres transaction the underlying P2002 has already
   * aborted the tx (25P02), so callers must treat it as a full-tx
   * failure the client retries (the retry then replays via
   * `getBroadcast`), never attempt in-tx recovery.
   */
  createBroadcast(
    input: CreateVolunteerBroadcastInput,
  ): Promise<VolunteerBroadcastRecord>;
  /** Pk read — the broadcast idempotency pre-check inside the send tx. */
  getBroadcast(id: string): Promise<VolunteerBroadcastRecord | null>;
  /** Broadcast history for an ask, newest first. */
  listBroadcastsByAsk(askId: string): Promise<VolunteerBroadcastRecord[]>;
  /**
   * Deliverable audience for a broadcast scope: APPROVED and CHECKED_IN
   * signups on the ask, narrowed to a role (ROLE), a group (GROUP), or
   * the general pool (POOL = no group assignment). One row per signup —
   * the dispatcher dedupes by contact as needed.
   */
  listBroadcastRecipients(
    askId: string,
    scope: VolunteerBroadcastScope,
  ): Promise<VolunteerBroadcastRecipient[]>;

  // ── "My volunteering" .ics feed ─────────────────────────────────────
  /**
   * Persist the lazily minted feed token (unique per Human) with
   * SET-IF-ABSENT semantics: the write only lands when the human's token
   * column is currently NULL. Returns `true` when this call won (the
   * token was stored), `false` when it lost — either a concurrent
   * first-subscribe already committed a token (callers must re-read via
   * `getVolunteerIcsFeedToken` and return the winner's token, never
   * their own losing candidate) or no such human exists. Never
   * overwrites: an unconditional write here would let a race loser kill
   * the token the winner already handed out as a calendar URL.
   */
  setVolunteerIcsFeedToken(humanId: string, token: string): Promise<boolean>;
  /**
   * UNCONDITIONAL overwrite of the feed token — the rotation primitive
   * (contrast `setVolunteerIcsFeedToken`, which is set-if-NULL and never
   * clobbers). Replaces whatever value the column holds (including NULL)
   * so the old token stops resolving via `findHumanIdByIcsFeedToken`
   * the moment this commits. Returns `true` when the row was updated,
   * `false` when no such human exists (callers surface NOT_FOUND).
   */
  replaceVolunteerIcsFeedToken(humanId: string, token: string): Promise<boolean>;
  getVolunteerIcsFeedToken(humanId: string): Promise<string | null>;
  /** Token-auth resolution for the public feed URL. */
  findHumanIdByIcsFeedToken(token: string): Promise<string | null>;
  /**
   * Time-bound accepted (APPROVED | CHECKED_IN) signups for one human,
   * soonest first: event-path rows via their shift window (event
   * title/venue joined like `findShiftsNeedingReminder`), ask-path rows
   * via the ask's startsAt/endsAt window when set (title from the ask).
   * Windowless rows (shiftless event signups, asks without `startsAt`)
   * are excluded — a calendar entry needs a start time. `from` bounds
   * `startsAt` (inclusive).
   */
  listUpcomingSignupsForFeed(
    humanId: string,
    from: Date,
  ): Promise<VolunteerFeedSignupRecord[]>;

  // ── "My volunteering" page ──────────────────────────────────────────
  /**
   * EVERY volunteer commitment one human holds — the read behind the
   * attendee-facing `/my-volunteering` page. Same joins as
   * `listUpcomingSignupsForFeed` (event-path rows via the shift window
   * with event title/venue, ask-path rows via the ask), but deliberately
   * UNFILTERED where the feed filters: all six statuses (the page shows
   * pending applications), no `from` bound (the page shows history), and
   * windowless rows INCLUDED with `startsAt: null` (shiftless event
   * signups, asks without `startsAt`) rather than dropped.
   *
   * `now` is the caller's clock, used ONLY to split the occurrence-claim
   * read into upcoming/past buckets (see the truncation contract below).
   * It filters nothing: past rows are in the result either way.
   *
   * ── Three row kinds, and the de-duplication rule ─────────────────────
   *
   * Beyond the two signup kinds this also emits ONE ROW PER CLAIMED
   * OCCURRENCE (`VolunteerOccurrenceClaim` → `VolunteerShiftOccurrence`) —
   * how a volunteer commits to dated slots on a standing/recurring ask.
   * Those rows carry `claimId` / `occurrenceId` (null on signup rows), the
   * OCCURRENCE's window and hours, the occurrence's role, and the ask's
   * title. `signupId` therefore REPEATS across a standing volunteer's
   * dates: row identity is `claimId ?? signupId`.
   *
   * Only `CLAIMED` claims on `SCHEDULED` occurrences appear. WITHDRAWN
   * claims are gone by the volunteer's own choice. A CANCELLED occurrence
   * is OMITTED rather than surfaced — `VolunteerSignupStatus` has no value
   * that honestly means "the organizer cancelled this slot" (WITHDRAWN
   * blames the volunteer, NO_SHOW libels them), and the volunteer is told
   * directly instead: `cancelShiftOccurrence` notifies/emails every
   * claimant. Adding a seventh status is a contract change for its own
   * phase.
   *
   * DE-DUPLICATION: when a signup contributed occurrence rows to THIS
   * result, its own bare row is suppressed — otherwise a standing
   * volunteer sees a phantom "No set shift time" row sitting beside their
   * actual dates. Two carve-outs, both deliberate:
   *   - Suppression keys off rows actually emitted, so a claim lost to a
   *     CANCELLED occurrence or to truncation never suppresses a parent
   *     that was not replaced.
   *   - A parent carrying its OWN `checkedInAt` or `hoursWorked` survives.
   *     It is not a duplicate — `checkInVolunteer` stamps ask-level hours
   *     there and they appear nowhere else in the result.
   *
   * Ordering: `startsAt` ASC with NULLS LAST — windowless rows sort after
   * every dated row — then `createdAt` DESC as the tiebreak, so rows
   * sharing a start (and the whole windowless tail) read newest-first.
   * (`createdAt` is the CLAIM's on an occurrence row.)
   *
   * ── Truncation contract (the page is unpaginated) ────────────────────
   *
   * Each source is bounded SEPARATELY, so one can never evict another —
   * three years of Tuesday-night claims must not push out a volunteer's
   * event signups. At most `COMMITMENTS_MAX_ROWS` (200) signup rows +
   * `COMMITMENT_CLAIM_MAX_ROWS` (100) upcoming claim rows + 100 past claim
   * rows = 400. Callers must not treat the result as exhaustive history.
   *
   * What each bound drops, precisely:
   *   - CLAIMS: exact. Split at `now`, ordered ASC (upcoming) and DESC
   *     (past), so only the FURTHEST-FUTURE slot beyond the 100th, or the
   *     OLDEST past one, is ever dropped. An imminent claimed slot cannot
   *     be truncated away.
   *   - SIGNUPS: ordered `createdAt` DESC, so the oldest-CREATED go first.
   *     This is a proxy, not a guarantee: a signup made long ago for a
   *     far-future shift sits in the tail and could be dropped by a
   *     volunteer holding 200 newer signups. (Unchanged behaviour, stated
   *     honestly — an earlier revision of this doc claimed an absolute
   *     "never an upcoming commitment", which the ordering cannot deliver
   *     while the window lives in two different relations.) Fixing it
   *     needs the signup read split by window the way claims now are.
   */
  listCommitmentsByHuman(
    humanId: string,
    now: Date,
  ): Promise<VolunteerCommitmentRecord[]>;

  // ── Comp-ticket rewards ─────────────────────────────────────────────
  /**
   * Create-or-update the reward attached to (askId, roleId?). `roleId`
   * null/omitted addresses the whole-ask reward; a value addresses the
   * role-specific one. The DB enforces at most ONE reward per (askId,
   * roleId) via `@@unique([askId, roleId])` AND — because Postgres treats
   * NULLs as distinct in a compound unique — a raw partial unique index
   * (`VolunteerReward_ask_level_key` on `askId WHERE roleId IS NULL`, added
   * in the 20260702150000 migration) for the ask-level case. A race loser
   * on either surfaces as `{ code: "duplicate_reward" }` — same convention
   * as `duplicate_event_ask` on `createAsk`.
   */
  upsertReward(input: UpsertVolunteerRewardInput): Promise<VolunteerRewardRecord>;
  getReward(rewardId: string): Promise<VolunteerRewardRecord | null>;
  /**
   * Every reward configured on an ask — the ask-level (roleId null) reward
   * AND every role-level reward — INCLUDING inactive ones. Unlike
   * `getRewardForSignup` (resolution) and `listGrantsByAsk` (grant-derived),
   * this enumerates the full CONFIG so the reward config form and a complete
   * ledger can show a configured-but-zero-grant reward. Ordered oldest first
   * (ask-level typically leads). Never filters on `active`.
   */
  listRewardsByAsk(askId: string): Promise<VolunteerRewardRecord[]>;
  /**
   * Resolve the applicable reward for a signup: an active role-specific
   * reward wins, else the active ask-level (roleId null) reward, else null.
   * Inactive rewards are skipped.
   */
  getRewardForSignup(
    askId: string,
    roleId: string,
  ): Promise<VolunteerRewardRecord | null>;
  /**
   * `SELECT … FOR UPDATE` on the reward row in the ambient transaction —
   * THE budget serialization point. Only meaningful inside `repos.tx(...)`:
   * the lock is held until commit, so a concurrent grant's own
   * `getRewardForUpdate` blocks until this tx's budget check + increment
   * lands, guaranteeing `grantsUsed` can never overshoot `maxGrants`
   * (mirrors `countAcceptedOccupancy`'s FOR UPDATE precedent). Returns null
   * when the reward no longer exists.
   */
  getRewardForUpdate(
    rewardId: string,
  ): Promise<VolunteerRewardBudgetLock | null>;
  /** Bump the budget counter after a grant commits. */
  incrementGrantsUsed(rewardId: string): Promise<void>;
  /**
   * Return a budget slot when an unused grant is revoked. Floored at 0 via
   * a guarded `GREATEST(grantsUsed - 1, 0)` so a double-revoke or an
   * out-of-order call can never drive the counter negative.
   */
  decrementGrantsUsed(rewardId: string): Promise<void>;
  /**
   * Insert one grant. The `@@unique([rewardId, signupId])` is the
   * idempotency anchor — a double-fired trigger surfaces as
   * `{ code: "duplicate_grant" }` (same convention as `duplicate_event_ask`).
   */
  createGrant(
    input: CreateVolunteerRewardGrantInput,
  ): Promise<VolunteerRewardGrantRecord>;
  getGrant(grantId: string): Promise<VolunteerRewardGrantRecord | null>;
  /** Idempotency pre-read: the live grant for this (reward, signup), if any. */
  getGrantByRewardAndSignup(
    rewardId: string,
    signupId: string,
  ): Promise<VolunteerRewardGrantRecord | null>;
  listGrantsBySignup(signupId: string): Promise<VolunteerRewardGrantRecord[]>;
  /**
   * COORDINATOR-SAFE batch read (FR-006, NFR-003): the bare reward STATUS
   * enum per signup for exactly the signup ids passed in — no face value, no
   * comp order, no budget. Returns one entry ONLY for signups that have a
   * grant; a signup with no grant is absent from the result. `REDEEMED` is
   * derived from the grant being `REDEEMED` OR its linked
   * `Ticket.status === "SCANNED"` (mirrors `listGrantsByAsk`'s derivation).
   *
   * A signup should carry at most one applicable grant (rewards are
   * one-per-(ask,role) plus one ask-level, and `@@unique([rewardId, signupId])`
   * bars a duplicate), but if somehow multiple exist the meaningful live one
   * wins: `REDEEMED > GRANTED > REVOKED`.
   *
   * The caller scopes authorization by passing ONLY signup ids it is
   * authorized to read (e.g. a coordinator's own group members) — this
   * primitive applies no authz of its own. One query for the whole batch.
   */
  listRewardGrantStatusesBySignupIds(
    signupIds: string[],
  ): Promise<VolunteerRewardGrantStatusBySignup[]>;
  /**
   * Owner/finance ledger read for an ask: every grant on any of the ask's
   * rewards, joined to its reward (role + target ticket type) and the LIVE
   * comp `Ticket.status`. A `ticketStatus === "SCANNED"` row is effectively
   * redeemed even if `redeemedAt` is not yet stamped, so the ledger can
   * report redemption straight off the ticket. Newest grant first.
   */
  listGrantsByAsk(
    askId: string,
    opts?: ListRewardGrantsByAskOpts,
  ): Promise<VolunteerRewardGrantLedgerRow[]>;
  /** Patch a grant's lifecycle (redeem / revoke). Returns the fresh row. */
  updateGrantStatus(
    grantId: string,
    patch: UpdateVolunteerRewardGrantStatusInput,
  ): Promise<VolunteerRewardGrantRecord>;
}

export type {
  RoleTemplateRecord,
  RoleTemplateShiftRecord,
  RoleTemplateShiftDraft,
  RoleTemplateWithShiftsRecord,
  CreateRoleTemplateInput,
  UpdateRoleTemplateInput,
  VolunteerPackStatus,
  VolunteerPackRecord,
  VolunteerPackWithCountsRecord,
  VolunteerPackWithRolesRecord,
  CreateVolunteerPackInput,
  UpdateVolunteerPackInput,
  CreatePlatformRoleTemplateInput,
  VolunteerShiftAnchor,
  EventVolunteerRoleRecord,
  EventVolunteerRoleWithShiftsRecord,
  CreateEventVolunteerRoleInput,
  UpdateEventVolunteerRoleInput,
  VolunteerShiftRecord,
  CreateVolunteerShiftInput,
  UpdateVolunteerShiftInput,
  VolunteerSignupRecord,
  CreateVolunteerSignupInput,
  UpdateVolunteerSignupStatusInput,
  ListVolunteerSignupsOpts,
  ListVolunteerSignupsCursorOpts,
  VolunteerSignupCursorPage,
  // Was imported above and used across this interface but never re-exported,
  // so `import type { VolunteerSignupStatus } from "@th/ports/repos/volunteering"`
  // did not resolve — invisible because no typecheck gate reaches the test
  // files that tried it (`tsconfig.base.json` excludes `**/*.test.ts` AND
  // `**/volunteering/**`).
  VolunteerSignupStatus,
  VolunteerSignupEmailKey,
  ShiftReminderCandidate,
  FindShiftsNeedingReminderInput,
  RecordShiftNotificationInput,
  FindStartReminderCandidatesInput,
  EventStartReminderCandidate,
  AskStartReminderCandidate,
  HoursReportRow,
  OrgVolunteerHoursRange,
  OrgVolunteerHoursRow,
  VolunteerReminderKind,
  VolunteerReminderChannel,
  VolunteerSubjectType,
  VolunteerAskStatus,
  VolunteerAskCadence,
  VolunteerAskRecord,
  CreateVolunteerAskInput,
  UpdateVolunteerAskInput,
  VolunteerGroupRecord,
  VolunteerGroupCoordinatorInfo,
  VolunteerGroupWithRosterInfoRecord,
  CreateVolunteerGroupInput,
  UpdateVolunteerGroupInput,
  VolunteerBroadcastScopeType,
  VolunteerBroadcastScope,
  VolunteerBroadcastRecord,
  CreateVolunteerBroadcastInput,
  VolunteerBroadcastRecipient,
  VolunteerFeedSignupRecord,
  VolunteerCommitmentRecord,
  VolunteerCommitmentReminderBasis,
  VolunteerRewardTrigger,
  VolunteerRewardGrantStatus,
  VolunteerRewardRecord,
  UpsertVolunteerRewardInput,
  VolunteerRewardBudgetLock,
  VolunteerRewardGrantRecord,
  CreateVolunteerRewardGrantInput,
  UpdateVolunteerRewardGrantStatusInput,
  ListRewardGrantsByAskOpts,
  VolunteerRewardGrantLedgerRow,
  VolunteerRewardGrantStatusBySignup,
  VolunteerOccurrenceStatus,
  VolunteerOccurrenceClaimStatus,
  VolunteerOccurrenceClaimSource,
  VolunteerShiftOccurrenceRecord,
  VolunteerShiftOccurrenceWithClaimCountRecord,
  CreateVolunteerShiftOccurrenceInput,
  UpdateVolunteerShiftOccurrenceInput,
  ListVolunteerOccurrencesOpts,
  VolunteerOccurrenceClaimRecord,
  CreateVolunteerOccurrenceClaimInput,
  UpdateVolunteerOccurrenceClaimInput,
  VolunteerOccurrenceClaimRosterRow,
};
