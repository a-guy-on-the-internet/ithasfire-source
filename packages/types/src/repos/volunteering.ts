// ─────────────────────────────────────────────────────────────────────────────
// Volunteering — Repo DTOs and input types
// ─────────────────────────────────────────────────────────────────────────────

import type { TicketStatus } from "./tickets";

export type VolunteerSignupStatus =
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "WITHDRAWN"
  | "CHECKED_IN"
  | "NO_SHOW";

// ── Generic volunteer asks ────────────────────────────────────────────────
// See docs/specs/2026-06-29/completed/generic-volunteering-asks.spec.yaml (incl. the
// 2026-07-01 resolutions block). An ask is a polymorphic "we need
// volunteers" container; event volunteering is the EVENT-subject case.

/** Mirrors the Prisma `VolunteerSubjectType` enum. */
export type VolunteerSubjectType = "PLACE" | "ORG" | "HUMAN" | "EVENT";

/** Mirrors the Prisma `VolunteerAskStatus` enum. */
export type VolunteerAskStatus =
  | "DRAFT"
  | "OPEN"
  | "PAUSED"
  | "CLOSED"
  | "ARCHIVED";

/** Mirrors the Prisma `VolunteerAskCadence` enum. */
export type VolunteerAskCadence = "ONE_TIME" | "ONGOING" | "RECURRING";

export interface VolunteerAskRecord {
  id: string;
  subjectType: VolunteerSubjectType;
  /** Place.id | Organization.id | Human.id | Event.id — no hard FK. */
  subjectId: string;
  /** Denormalized owning org (nullable) for org dashboards / fast perms. */
  orgId: string | null;
  title: string;
  description: string | null;
  status: VolunteerAskStatus;
  cadence: VolunteerAskCadence;
  /** Optional scheduling window (v1 scheduling = window + cadence label). */
  startsAt: Date | null;
  endsAt: Date | null;
  /**
   * IANA zone the organiser stated the window in, so every surface renders
   * the same wall clock. Null on asks created before the zone was asked for
   * (no backfill). May be set without a window; meaningful only when
   * `startsAt`/`endsAt` exist.
   */
  timezone: string | null;
  /** Soft cap across the whole ask — UI indicator only. */
  capacity: number | null;
  autoApprove: boolean;
  waiverRequired: boolean;
  /**
   * Waiver template backing `waiverRequired` for non-EVENT signups
   * (ask-level-volunteer-waivers spec). The gate only arms when BOTH are
   * set (`waiverRequired && waiverTemplateId`) — a flag with no template
   * stays inert, mirroring Event.volunteerWaiverRequired semantics.
   * Assigned exclusively via `setAskWaiverTemplate` (never `updateAsk`)
   * so template ownership validation has a single path.
   */
  waiverTemplateId: string | null;
  /**
   * The organiser's old SMS switch. Gates nothing since 2026-10-17
   * (volunteer-ask-reminders R5): the volunteer chooses, on any ask a
   * reminder is sent for. Column kept, unused.
   */
  smsOptInEnabled: boolean;
  /** Application questions (same shape as event application answers). */
  formSchema: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateVolunteerAskInput {
  subjectType: VolunteerSubjectType;
  subjectId: string;
  orgId?: string | null;
  title: string;
  description?: string | null;
  status?: VolunteerAskStatus;
  cadence?: VolunteerAskCadence;
  startsAt?: Date | null;
  endsAt?: Date | null;
  timezone?: string | null;
  capacity?: number | null;
  autoApprove?: boolean;
  waiverRequired?: boolean;
  smsOptInEnabled?: boolean;
  formSchema?: unknown;
}

/** Partial patch — the subject (type/id) and orgId are immutable. */
export interface UpdateVolunteerAskInput {
  title?: string;
  description?: string | null;
  status?: VolunteerAskStatus;
  cadence?: VolunteerAskCadence;
  startsAt?: Date | null;
  endsAt?: Date | null;
  timezone?: string | null;
  capacity?: number | null;
  autoApprove?: boolean;
  waiverRequired?: boolean;
  smsOptInEnabled?: boolean;
  formSchema?: unknown;
}

// ── Volunteer groups ──────────────────────────────────────────────────────

export interface VolunteerGroupRecord {
  id: string;
  askId: string;
  name: string;
  description: string | null;
  /** Soft cap — UI indicator only. */
  capacity: number | null;
  /** Single coordinator (v1). Need not be an OrgMember. */
  coordinatorHumanId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Coordinator display info embedded on roster-facing group reads (mirrors
 * the `{ humanId, displayName }` embeds on place-verification records).
 *
 * NO account email (2026-09-29 security review): the owner picks a
 * coordinator by typing an address or a humanId, and returning the linked
 * AuthUser's email turned that into an email/humanId → account-email lookup
 * for anyone who can create an ask. An invitee without an account shows the
 * address the owner typed, because their shadow profile's `name` IS it.
 */
export interface VolunteerGroupCoordinatorInfo {
  humanId: string;
  name: string | null;
}

/** Group + roster aggregates, returned by `listGroupsByAsk`. */
export interface VolunteerGroupWithRosterInfoRecord
  extends VolunteerGroupRecord {
  /** Accepted members (APPROVED | CHECKED_IN) assigned to this group. */
  memberCount: number;
  coordinator: VolunteerGroupCoordinatorInfo | null;
}

export interface CreateVolunteerGroupInput {
  askId: string;
  name: string;
  description?: string | null;
  capacity?: number | null;
}

export interface UpdateVolunteerGroupInput {
  name?: string;
  description?: string | null;
  capacity?: number | null;
}

// ── Roster broadcasts ─────────────────────────────────────────────────────

/** Mirrors the string column on `VolunteerBroadcast.scopeType`. */
export type VolunteerBroadcastScopeType = "ALL" | "ROLE" | "GROUP" | "POOL";

/**
 * Audience selector for broadcast recipient queries. POOL = approved
 * signups on the ask with no group assignment (the general pool).
 */
export type VolunteerBroadcastScope =
  | { kind: "ALL" }
  | { kind: "ROLE"; roleId: string }
  | { kind: "GROUP"; groupId: string }
  | { kind: "POOL" };

export interface VolunteerBroadcastRecord {
  id: string;
  askId: string;
  senderHumanId: string;
  scopeType: VolunteerBroadcastScopeType;
  /** roleId | groupId when scoped, null for ALL / POOL. */
  scopeId: string | null;
  subject: string;
  body: string;
  /**
   * ADDRESSED count stamped at send time — the number of deduped contacts
   * the broadcast was aimed at, NOT a delivered count. Post-commit delivery
   * is best-effort: a crash between the ledger commit and the send loop
   * loses those sends silently, and an idempotent retry replays this row
   * without re-sending.
   */
  recipientCount: number;
  createdAt: Date;
}

export interface CreateVolunteerBroadcastInput {
  /**
   * Optional client-supplied id — the broadcast idempotency key. When set,
   * the row is created with this exact pk so a retry can detect the earlier
   * send (pre-read via `getBroadcast`). Omitted → DB-generated uuid.
   */
  id?: string | null;
  askId: string;
  senderHumanId: string;
  scopeType: VolunteerBroadcastScopeType;
  scopeId?: string | null;
  subject: string;
  body: string;
  recipientCount: number;
}

/**
 * One deliverable recipient row for a broadcast — an APPROVED or
 * CHECKED_IN signup in scope. One row per signup (a human holding two
 * role signups on the ask appears twice); the send path dedupes by
 * email/humanId as needed.
 */
export interface VolunteerBroadcastRecipient {
  signupId: string;
  humanId: string | null;
  contactEmail: string;
  contactName: string | null;
}

// ── "My volunteering" .ics feed ───────────────────────────────────────────

/**
 * One time-bound row in a volunteer's aggregate .ics feed. Event-path
 * signups derive their window from the shift (title/venue from the
 * event, like `findShiftsNeedingReminder`); ask-path signups use the
 * ask's optional startsAt/endsAt window (title from the ask, no venue).
 */
export interface VolunteerFeedSignupRecord {
  signupId: string;
  status: VolunteerSignupStatus;
  source: "EVENT_SHIFT" | "ASK_WINDOW";
  /** Event title (event path) or ask title (ask path). */
  title: string;
  roleName: string;
  shiftLabel: string | null;
  startsAt: Date;
  /** Null only on the ask path when the ask has no `endsAt`. */
  endsAt: Date | null;
  eventId: string | null;
  eventSlug: string | null;
  eventTimezone: string | null;
  /**
   * RAW `Event.addressText`. Never render it as-is: core replaces it through
   * the holder-address gate (`gatedRowAddressText`) before a volunteer sees
   * it — no street before the reveal, none for NEVER, the Place's street for
   * a venue that withholds its address.
   */
  addressText: string | null;
  askId: string | null;
}

// ── "My volunteering" page ────────────────────────────────────────────────

/**
 * One volunteer commitment row for the attendee-facing `/my-volunteering`
 * page — every signup a human holds, past and future, in every status.
 *
 * Superset of `VolunteerFeedSignupRecord` (the .ics feed row) and read from
 * the same joins: event-path rows take their window from the shift and their
 * title/venue from the event (same joins as `findShiftsNeedingReminder`),
 * ask-path rows take their window and title from the ask. It differs from
 * the feed row in exactly four ways, all of them because a page is not a
 * calendar:
 *
 *  1. Every status is readable (the page has an "awaiting confirmation"
 *     section), not just APPROVED | CHECKED_IN.
 *  2. Past rows are included (the history section) — there is no `from`
 *     bound.
 *  3. Windowless rows are INCLUDED with `startsAt: null` (a shiftless event
 *     signup, or an ask with no `startsAt`); the feed excludes them because
 *     a calendar entry needs a start time.
 *  4. It carries the three page-only fields the feed has no use for:
 *     `hoursWorked`, `checkedInAt`, `createdAt`.
 *
 * ── THREE row kinds, not two ──────────────────────────────────────────────
 *
 * `source` still has two values, but there are THREE kinds of row. The
 * discriminator for the third is `occurrenceId`, NOT `source`:
 *
 *   | kind             | source      | occurrenceId | claimId | window from |
 *   |------------------|-------------|--------------|---------|-------------|
 *   | event shift      | EVENT_SHIFT | null         | null    | the shift   |
 *   | ask window       | ASK_WINDOW  | null         | null    | the ask     |
 *   | claimed occurrence | ASK_WINDOW | set        | set     | the OCCURRENCE |
 *
 * An occurrence row is an ask-path row (its title, `askId` and link target
 * are the ask's) whose WINDOW and HOURS come from one dated
 * `VolunteerShiftOccurrence` the volunteer claimed — a standing venue
 * night's 3 September slot, not the open-ended ask behind it. `source` was
 * deliberately NOT widened to a third value: nothing about the ask-path
 * classification is false for these rows, and widening the union would break
 * every exhaustive `switch` a consumer has already written.
 *
 * ROW IDENTITY IS `claimId ?? signupId`, NOT `signupId`. One parent signup
 * emits one row PER CLAIMED OCCURRENCE, so `signupId` repeats across a
 * standing volunteer's dates and is no longer a usable React key.
 */
export interface VolunteerCommitmentRecord {
  /**
   * The parent `VolunteerSignup`. NOT unique across the result: every
   * occurrence row on a standing ask repeats its parent's id. Use
   * `claimId ?? signupId` for row identity.
   */
  signupId: string;
  /**
   * Set on an occurrence row = the `VolunteerOccurrenceClaim` behind it.
   * Null on signup rows. The row-kind discriminator, and half of the
   * identity key above.
   */
  claimId: string | null;
  /**
   * Set on an occurrence row = the dated `VolunteerShiftOccurrence` this
   * row's window and hours come from. Null on signup rows.
   */
  occurrenceId: string | null;
  /**
   * Signup rows: the signup's own status.
   *
   * Occurrence rows: the CLAIM's state expressed in the same vocabulary —
   * `CHECKED_IN` when this claim has a `checkedInAt`, otherwise the parent
   * signup's status EXCEPT that a parent `CHECKED_IN` is reported as
   * `APPROVED`. That downgrade is load-bearing, not tidiness: an ask-level
   * check-in says the volunteer turned up ONCE, nothing about this dated
   * slot, and `CHECKED_IN` is the gate every hours surface counts on — so
   * inheriting it would bill every future slot they merely claimed.
   */
  status: VolunteerSignupStatus;
  source: "EVENT_SHIFT" | "ASK_WINDOW";
  /** Event title (event path), or ask title (ask path AND occurrence rows). */
  title: string;
  roleName: string;
  shiftLabel: string | null;
  /**
   * Null = windowless: shiftless event signup, or ask with no startsAt.
   * NEVER null on an occurrence row — an occurrence has both bounds.
   */
  startsAt: Date | null;
  endsAt: Date | null;
  eventId: string | null;
  eventSlug: string | null;
  /**
   * IANA zone the row's window renders in. Shift path: the event's zone.
   * Ask path: the ask's stated `VolunteerAsk.timezone`, falling back to the
   * event's zone for an older zoneless ask. Occurrence row: the ask's
   * stated zone (occurrences exist only on non-EVENT asks, so there is no
   * event to fall back to). Null when nothing states a zone; callers then
   * fall back to the viewer's own zone. The .ics feed projection re-nulls
   * it on ask-path rows (`toFeedRecord`).
   */
  eventTimezone: string | null;
  /**
   * RAW `Event.addressText`. Never render it as-is: core replaces it through
   * the holder-address gate (`gatedRowAddressText`) before a volunteer sees
   * it — no street before the reveal, none for NEVER, the Place's street for
   * a venue that withholds its address.
   */
  addressText: string | null;
  askId: string | null;
  /**
   * Admin hours override; null means fall back to the scheduled duration.
   * On an occurrence row this is the CLAIM's per-occurrence override
   * (`VolunteerOccurrenceClaim.hoursWorked`, stamped by
   * `checkInOccurrenceClaim`) — never the parent signup's, which is a
   * separate, additive figure.
   */
  hoursWorked: number | null;
  /**
   * Hours to credit this commitment: the `hoursWorked` override when set,
   * else the SHIFT's scheduled duration. Null when neither is available.
   *
   * Render this, not `hoursWorked` — and NULL IS NOT ZERO. A CHECKED_IN
   * 4-hour shift with no override has `hoursWorked: null` and
   * `hoursCredited: 4`; showing the raw override told a volunteer they had
   * worked "0 HOURS THIS YEAR" while the organizer's export said 4.
   *
   * Null on every `source: "ASK_WINDOW"` row that lacks an override — the
   * ask's window is not a shift and is never converted to hours (see
   * `mapCommitment`). `hoursWorked` is retained above unchanged for
   * callers that need to distinguish "an admin set this" from "we derived
   * it".
   *
   * OCCURRENCE ROWS ARE THE EXCEPTION AND THE POINT: an occurrence IS a
   * shift (a bounded, dated slot capped at 24h), so its duration is a legal
   * hours source and these rows derive from the OCCURRENCE window. They
   * still never touch the ask window — see the guard in `mapCommitment`.
   */
  hoursCredited: number | null;
  /** Signup rows: the signup's check-in. Occurrence rows: the CLAIM's. */
  checkedInAt: Date | null;
  /**
   * When this commitment was made: signup creation on a signup row, CLAIM
   * creation on an occurrence row. The page renders "Applied <date>" on
   * pending rows.
   */
  createdAt: Date;
  /**
   * The owning ask's cadence, or null when the row has no ask at all (a
   * pure event-shift signup the `askId` backfill never reached).
   *
   * Exists so callers can tell an ONGOING standing ask ("we always need
   * door help", legitimately open-ended) from a ONE_TIME ask whose `endsAt`
   * was simply never filled in. Without it `/my-volunteering` could only
   * key off `endsAt`, which files a live standing commitment under History.
   */
  cadence: VolunteerAskCadence | null;
  /** The signup's current text-reminder opt-in (the parent's, on an occurrence row). */
  smsOptIn: boolean;
  /**
   * Whether a contact phone is on file. A boolean on purpose: the number
   * itself never leaves the adapter on this page read.
   */
  hasContactPhone: boolean;
  /**
   * The raw facts `signupReminderAnchor` reads, joined here so core can
   * derive "does this row get text reminders" for the whole list without a
   * per-row read. Adapter returns facts only; the rule lives in core, which
   * strips this field before the row reaches a caller.
   */
  reminderBasis: VolunteerCommitmentReminderBasis;
}

export interface VolunteerCommitmentReminderBasis {
  /** The signup's own shift (not the occurrence's). */
  shiftId: string | null;
  /** The signup's role has at least one shift. */
  roleHasShifts: boolean;
  /** The signup's ask, null when it has none. */
  ask: Pick<
    VolunteerAskRecord,
    "subjectType" | "cadence" | "startsAt"
  > | null;
}

// ── Role templates (org-level) ────────────────────────────────────────────

/** Mirrors the Prisma `VolunteerPackStatus` enum. */
export type VolunteerPackStatus = "DRAFT" | "LIVE";

/** Mirrors the Prisma `VolunteerShiftAnchor` enum. */
export type VolunteerShiftAnchor = "WALL_CLOCK" | "EVENT_START" | "EVENT_END";

/**
 * Platform-curated bundle of role templates. Metadata only — the roles are
 * ordinary `VolunteerRoleTemplate` rows pointing back via `packId`.
 */
export interface VolunteerPackRecord {
  id: string;
  /** Stable slug — the seed path's convergence key. */
  key: string;
  name: string;
  /** Staff-authored free text. Escaped at the sink, never HTML (NFR-004). */
  blurb: string | null;
  status: VolunteerPackStatus;
  /** Category ids this pack fits; ranking hint only, no FK. */
  targetCategoryIds: string[];
  /** Pin above category-matched packs in the organizer picker. */
  rankFirst: boolean;
  sortOrder: number;
  curatedByHumanId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Pack plus the two counts the staff catalogue list shows (FR-014):
 * how many catalogue roles it owns, and how many org-owned forks descend
 * from it.
 */
export interface VolunteerPackWithCountsRecord extends VolunteerPackRecord {
  /** Platform rows owned by this pack (`isPlatform` true). */
  roleCount: number;
  /** Org-owned rows carrying this pack as provenance (`isPlatform` false). */
  forkCount: number;
}

/** Pack plus its catalogue roles and their shift presets. */
export interface VolunteerPackWithRolesRecord extends VolunteerPackRecord {
  roles: RoleTemplateWithShiftsRecord[];
}

export interface CreateVolunteerPackInput {
  key: string;
  name: string;
  blurb?: string | null;
  status?: VolunteerPackStatus;
  targetCategoryIds?: string[];
  rankFirst?: boolean;
  sortOrder?: number;
  curatedByHumanId?: string | null;
}

export interface UpdateVolunteerPackInput {
  name?: string;
  blurb?: string | null;
  status?: VolunteerPackStatus;
  targetCategoryIds?: string[];
  rankFirst?: boolean;
  sortOrder?: number;
  curatedByHumanId?: string | null;
}

/**
 * Create a PLATFORM catalogue row: `orgId` is NULL and `isPlatform` is true,
 * neither of them settable by the caller. `packId` is required — the
 * `VolunteerRoleTemplate_platform_pack_check` CHECK constraint refuses a
 * pack-less platform row.
 */
export interface CreatePlatformRoleTemplateInput {
  packId: string;
  name: string;
  description?: string | null;
  defaultCapacity?: number | null;
  sortOrder?: number;
}

/**
 * A reusable volunteer role template — org-owned OR platform-curated.
 *
 * - ORG row:      `orgId` set, `isPlatform` false. `packId` may be set when
 *                 the row was forked from a catalogue pack (provenance).
 * - PLATFORM row: `orgId` null, `isPlatform` true, `packId` set. Read-only
 *                 to every organizer — mutating use cases reject these
 *                 before any membership check, because there is no owning
 *                 org to derive authz from.
 *
 * `orgId === null` is NOT the same test as "belongs to another org": callers
 * must state which one they mean.
 */
export interface RoleTemplateRecord {
  id: string;
  /** Null on platform catalogue rows. */
  orgId: string | null;
  name: string;
  description: string | null;
  defaultCapacity: number | null;
  sortOrder: number;
  archived: boolean;
  /** True = platform catalogue row, read-only to organizers. */
  isPlatform: boolean;
  /** Owning pack (platform rows) or source pack (org forks). */
  packId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Shift preset attached to a role template. Stored as time-of-day
 * (minute-of-day, 0–1439) plus an optional day offset from the event
 * date — same pattern used by mainstream shift schedulers (When I Work,
 * Sling, Mobilize). When `endMinuteOfDay <= startMinuteOfDay` the shift
 * wraps past midnight onto `startDayOffset + 1`, captured by `endsNextDay`.
 *
 * Materialized into concrete `EventVolunteerShift` rows via
 * `InlineShiftComposer` at apply time, never auto-persisted.
 */
export interface RoleTemplateShiftRecord {
  id: string;
  templateId: string;
  label: string;
  startMinuteOfDay: number;
  endMinuteOfDay: number;
  startDayOffset: number;
  endsNextDay: boolean;
  capacity: number | null;
  position: number;
  /**
   * What the start is measured from. WALL_CLOCK (default) ignores
   * `offsetMinutes` and reproduces the pre-anchor behaviour exactly.
   */
  anchor: VolunteerShiftAnchor;
  /** Signed minutes from the anchor; ignored when anchor is WALL_CLOCK. */
  offsetMinutes: number;
  /** Preset admin-only note, copied onto the materialized shift. */
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Template + its shifts in a single record. Returned by `getRoleTemplateWithShifts` and `listRoleTemplatesWithShifts`. */
export interface RoleTemplateWithShiftsRecord extends RoleTemplateRecord {
  shifts: RoleTemplateShiftRecord[];
}

/** Draft shift used by `upsertRoleTemplateShifts`. `id` is omitted because the repo replaces the full set. */
export interface RoleTemplateShiftDraft {
  label: string;
  startMinuteOfDay: number;
  endMinuteOfDay: number;
  startDayOffset?: number;
  endsNextDay?: boolean;
  capacity?: number | null;
  position?: number;
  /** Defaults to WALL_CLOCK — omit to keep the pre-anchor behaviour. */
  anchor?: VolunteerShiftAnchor;
  /** Defaults to 0. Ignored when `anchor` is WALL_CLOCK. */
  offsetMinutes?: number;
  notes?: string | null;
}

/**
 * Create an ORG-OWNED template. Platform catalogue rows are not created
 * through this input — `orgId` is required and `isPlatform` is not
 * settable here, so no organizer-facing path can mint a catalogue row.
 * Staff pack CRUD writes those through its own repo surface.
 */
export interface CreateRoleTemplateInput {
  orgId: string;
  name: string;
  description?: string | null;
  defaultCapacity?: number | null;
  sortOrder?: number;
  /** Provenance when this row is a fork of a platform role (FR-011). */
  packId?: string | null;
}

export interface UpdateRoleTemplateInput {
  name?: string;
  description?: string | null;
  defaultCapacity?: number | null;
  sortOrder?: number;
}

// ── Event volunteer roles ─────────────────────────────────────────────────

export interface EventVolunteerRoleRecord {
  id: string;
  /** Null = generic (ask-owned) role. Event roles keep this populated. */
  eventId: string | null;
  /** Owning generic ask — set on ask-owned roles and backfilled EVENT asks. */
  askId: string | null;
  templateId: string | null;
  name: string;
  description: string | null;
  capacity: number | null;
  autoApprove: boolean | null;
  /**
   * Owner-editable hours stamped onto `signup.hoursWorked` at check-in for
   * ask-based roles that have no shift to derive a duration from.
   */
  defaultHours: number | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface EventVolunteerRoleWithShiftsRecord extends EventVolunteerRoleRecord {
  shifts: VolunteerShiftRecord[];
}

/**
 * Exactly one of `eventId` / `askId` should be set (validated in core —
 * the repo just carries whichever key arrives).
 */
export interface CreateEventVolunteerRoleInput {
  eventId?: string | null;
  askId?: string | null;
  templateId?: string | null;
  name: string;
  description?: string | null;
  capacity?: number | null;
  autoApprove?: boolean | null;
  defaultHours?: number | null;
  sortOrder?: number;
}

export interface UpdateEventVolunteerRoleInput {
  name?: string;
  description?: string | null;
  capacity?: number | null;
  autoApprove?: boolean | null;
  defaultHours?: number | null;
  sortOrder?: number;
}

// ── Shifts ────────────────────────────────────────────────────────────────

export interface VolunteerShiftRecord {
  id: string;
  roleId: string;
  label: string | null;
  startsAt: Date;
  endsAt: Date;
  capacity: number | null;
  notes: string | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateVolunteerShiftInput {
  roleId: string;
  label?: string | null;
  startsAt: Date;
  endsAt: Date;
  capacity?: number | null;
  notes?: string | null;
  sortOrder?: number;
}

export interface UpdateVolunteerShiftInput {
  label?: string | null;
  startsAt?: Date;
  endsAt?: Date;
  capacity?: number | null;
  notes?: string | null;
  sortOrder?: number;
}

// ── Signups ───────────────────────────────────────────────────────────────

export interface VolunteerSignupRecord {
  id: string;
  /** Null = generic (ask-only) signup; legacy event signups keep it set. */
  eventId: string | null;
  /** Owning generic ask — set on ask signups and backfilled EVENT asks. */
  askId: string | null;
  roleId: string;
  shiftId: string | null;
  /** Group assignment within the ask. Null = the ask's general pool. */
  groupId: string | null;
  humanId: string | null;
  contactEmail: string;
  contactName: string | null;
  contactPhone: string | null;
  /**
   * TCPA opt-in for SMS reminders. Stored true only for a signup a reminder
   * is really sent for (`signupReminderAnchor` in core).
   */
  smsOptIn: boolean;
  status: VolunteerSignupStatus;
  /**
   * Admin override for hours-worked on this signup. `null` means the
   * shift's scheduled duration (`endsAt - startsAt`) is the source of
   * truth — set explicitly when the volunteer worked less or more than
   * scheduled. CSV export surfaces both columns.
   */
  hoursWorked: number | null;
  answers: unknown;
  reviewerHumanId: string | null;
  reviewedAt: Date | null;
  checkedInAt: Date | null;
  /**
   * When the volunteer accepted the waiver (Gap 3 / ask-level waivers).
   * Null when no acceptance is on file for this signup — including all
   * signups made before the container required a waiver (never
   * retro-gated).
   */
  waiverAcceptedAt: Date | null;
  /**
   * Roster convenience flag (`waiverAcceptedAt !== null`): whether a
   * VolunteerWaiverAcceptance row exists for this signup. Powers the
   * owner/coordinator "Waiver accepted" badge (FR-009,
   * ask-level-volunteer-waivers spec). Derived from the acceptance
   * relation's presence at read time, never stored.
   */
  waiverAccepted: boolean;
  notes: string | null;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Event signups set `eventId` (and, post-backfill, `askId`); pure ask
 * signups set `askId` only. The repo passes both through untouched —
 * exactly-one-subject validation happens in core.
 */
export interface CreateVolunteerSignupInput {
  eventId?: string | null;
  askId?: string | null;
  roleId: string;
  shiftId?: string | null;
  groupId?: string | null;
  humanId?: string | null;
  contactEmail: string;
  contactName?: string | null;
  contactPhone?: string | null;
  /** Defaults to `false` if omitted — the dispatcher refuses SMS unless `true`. */
  smsOptIn?: boolean;
  status?: VolunteerSignupStatus;
  answers?: unknown;
  metadata?: unknown;
}

export interface UpdateVolunteerSignupStatusInput {
  status: VolunteerSignupStatus;
  reviewerHumanId?: string | null;
  reviewedAt?: Date | null;
  checkedInAt?: Date | null;
  notes?: string | null;
}

// ── Shift occurrences + claims ────────────────────────────────────────────
// generic-volunteer-shifts-occurrences spec, phase A (FR-001..FR-005).
// Concrete dated slots on STANDING (non-EVENT) ask roles, claimable by
// APPROVED volunteers. Approval stays once-per-person on VolunteerSignup;
// a claim is a lightweight per-date commitment.

/** Mirrors the Prisma `VolunteerOccurrenceStatus` enum. */
export type VolunteerOccurrenceStatus = "SCHEDULED" | "CANCELLED";

/** Mirrors the Prisma `VolunteerOccurrenceClaimStatus` enum. */
export type VolunteerOccurrenceClaimStatus = "CLAIMED" | "WITHDRAWN";

/** Mirrors the Prisma `VolunteerOccurrenceClaimSource` enum. */
export type VolunteerOccurrenceClaimSource = "SELF" | "ASSIGNED";

export interface VolunteerShiftOccurrenceRecord {
  id: string;
  askId: string;
  roleId: string;
  /** Phase B: owning VolunteerShiftPattern. Always null for one-off rows. */
  patternId: string | null;
  startsAt: Date;
  endsAt: Date;
  /** Soft cap per occurrence — claim gate (FOR UPDATE narrowed). */
  capacity: number | null;
  notes: string | null;
  status: VolunteerOccurrenceStatus;
  createdAt: Date;
  updatedAt: Date;
}

/** Occurrence + its active (CLAIMED) claim count, for schedule reads. */
export interface VolunteerShiftOccurrenceWithClaimCountRecord
  extends VolunteerShiftOccurrenceRecord {
  claimedCount: number;
}

export interface CreateVolunteerShiftOccurrenceInput {
  askId: string;
  roleId: string;
  patternId?: string | null;
  startsAt: Date;
  endsAt: Date;
  capacity?: number | null;
  notes?: string | null;
}

/** Partial patch — ask/role/pattern linkage is immutable. */
export interface UpdateVolunteerShiftOccurrenceInput {
  startsAt?: Date;
  endsAt?: Date;
  capacity?: number | null;
  notes?: string | null;
  status?: VolunteerOccurrenceStatus;
}

export interface ListVolunteerOccurrencesOpts {
  roleId?: string;
  status?: VolunteerOccurrenceStatus;
  /** Inclusive lower bound on `startsAt`. */
  from?: Date;
  /** Exclusive upper bound on `startsAt`. */
  to?: Date;
  limit?: number;
}

export interface VolunteerOccurrenceClaimRecord {
  id: string;
  occurrenceId: string;
  signupId: string;
  status: VolunteerOccurrenceClaimStatus;
  source: VolunteerOccurrenceClaimSource;
  checkedInAt: Date | null;
  /** Per-occurrence hours, stamped at claim check-in (2dp). */
  hoursWorked: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateVolunteerOccurrenceClaimInput {
  occurrenceId: string;
  signupId: string;
  status?: VolunteerOccurrenceClaimStatus;
  source?: VolunteerOccurrenceClaimSource;
}

export interface UpdateVolunteerOccurrenceClaimInput {
  status?: VolunteerOccurrenceClaimStatus;
  source?: VolunteerOccurrenceClaimSource;
  checkedInAt?: Date | null;
  hoursWorked?: number | null;
}

/**
 * One roster row for an occurrence: the claim plus the signup's contact
 * identity and group assignment (the fields the owner/coordinator roster
 * needs — never review notes or form answers). `groupId` powers the
 * coordinator's group-scoped PII filter in core.
 */
export interface VolunteerOccurrenceClaimRosterRow
  extends VolunteerOccurrenceClaimRecord {
  contactEmail: string;
  contactName: string | null;
  humanId: string | null;
  groupId: string | null;
  roleId: string;
  signupStatus: VolunteerSignupStatus;
}

/** Mirrors the Prisma `VolunteerReminderKind` enum. */
export type VolunteerReminderKind = "REMINDER_24H" | "REMINDER_1H";

/** Channel a reminder was dispatched over. New entries always lowercase. */
export type VolunteerReminderChannel = "email" | "sms" | "inapp";

/**
 * Hydrated candidate row returned by `findShiftsNeedingReminder`. Carries
 * everything the dispatcher needs to render and send across all channels
 * without further queries — signup contact info, shift window in the
 * event's timezone, role/event labels, and the already-sent channel set.
 */
export interface ShiftReminderCandidate {
  signupId: string;
  humanId: string | null;
  contactEmail: string;
  contactName: string | null;
  contactPhone: string | null;
  smsOptIn: boolean;
  eventId: string;
  eventTitle: string;
  eventSlug: string | null;
  eventTimezone: string | null;
  /**
   * RAW `Event.addressText`. Never render it as-is: core replaces it through
   * the holder-address gate (`gatedRowAddressText`) before a volunteer sees
   * it — no street before the reveal, none for NEVER, the Place's street for
   * a venue that withholds its address.
   */
  addressText: string | null;
  roleName: string;
  shiftLabel: string | null;
  shiftStartsAt: Date;
  shiftEndsAt: Date;
  /** Channels that have already been recorded for this signup + kind. */
  alreadySent: VolunteerReminderChannel[];
}

export interface FindShiftsNeedingReminderInput {
  kind: VolunteerReminderKind;
  /** Inclusive lower bound on `shift.startsAt`. */
  windowStart: Date;
  /** Exclusive upper bound on `shift.startsAt`. */
  windowEnd: Date;
}

export interface RecordShiftNotificationInput {
  signupId: string;
  kind: VolunteerReminderKind;
  channel: VolunteerReminderChannel;
}

/**
 * Window for the start-anchored candidate reads below: the same bands the
 * shift read uses, applied to the event's or the ask's start.
 */
export interface FindStartReminderCandidatesInput {
  kind: VolunteerReminderKind;
  /** Inclusive lower bound on the anchor's start. */
  windowStart: Date;
  /** Exclusive upper bound on the anchor's start. */
  windowEnd: Date;
}

/**
 * Hydrated row returned by `findEventStartReminderCandidates`: an APPROVED
 * event signup on a role with NO shifts, reminded before the event itself
 * starts (volunteer-ask-reminders R7). Same contact and ledger fields as
 * {@link ShiftReminderCandidate}.
 */
export interface EventStartReminderCandidate {
  signupId: string;
  humanId: string | null;
  contactEmail: string;
  contactName: string | null;
  contactPhone: string | null;
  smsOptIn: boolean;
  eventId: string;
  eventTitle: string;
  eventSlug: string | null;
  eventTimezone: string | null;
  /** RAW `Event.addressText`; core gates it exactly as for shift rows. */
  addressText: string | null;
  roleName: string;
  eventStartsAt: Date;
  eventEndsAt: Date;
  /** Channels that have already been recorded for this signup + kind. */
  alreadySent: VolunteerReminderChannel[];
}

/**
 * Hydrated row returned by `findAskStartReminderCandidates`: an APPROVED
 * signup on a non-EVENT ask, reminded before the ask's own start
 * (volunteer-ask-reminders R1). The ask fields are carried so core can
 * re-apply the anchor rule (`signupReminderAnchor`). No address: an ask
 * reminder never names one.
 */
export interface AskStartReminderCandidate {
  signupId: string;
  humanId: string | null;
  contactEmail: string;
  contactName: string | null;
  contactPhone: string | null;
  smsOptIn: boolean;
  askId: string;
  askTitle: string;
  askSubjectType: VolunteerSubjectType;
  askCadence: VolunteerAskCadence;
  askStartsAt: Date;
  askEndsAt: Date | null;
  /**
   * The zone the start renders in: the ask's own `timezone`, else (PLACE
   * asks) the subject place's, else null (rendered with its zone named).
   */
  askTimezone: string | null;
  roleName: string;
  /** Channels that have already been recorded for this signup + kind. */
  alreadySent: VolunteerReminderChannel[];
}

/**
 * Flat row for the per-event hours CSV export. One row per signup
 * regardless of status; the consumer filters/styles. `scheduledHours`
 * is the shift's declared duration in hours; `actualHours` is the
 * admin override when set, else equal to `scheduledHours`. `null`
 * scheduled hours means the signup wasn't tied to a specific shift
 * (role-level signup) — surfaces as a blank cell in the CSV.
 */
export interface HoursReportRow {
  signupId: string;
  contactName: string | null;
  contactEmail: string;
  roleName: string;
  shiftLabel: string | null;
  shiftStartsAt: Date | null;
  shiftEndsAt: Date | null;
  status: VolunteerSignupStatus;
  checkedInAt: Date | null;
  scheduledHours: number | null;
  actualHours: number | null;
  notes: string | null;
  /**
   * When the volunteer accepted the event waiver at signup (Gap 3).
   * Null for signups that predate the waiver gate or events without one.
   */
  waiverAcceptedAt: Date | null;
}

/**
 * Optional date-range filter for `aggregateHoursByVolunteer`. Bounds
 * apply to the signup's "activity instant": the shift's `startsAt`
 * when the signup is tied to a shift, else the signup's `createdAt`
 * (role-level signups have no scheduled time, so creation is the only
 * meaningful timestamp). `from` is inclusive, `to` is exclusive — a
 * calendar-year filter is `{ from: Jan 1, to: Jan 1 (next year) }`.
 */
export interface OrgVolunteerHoursRange {
  from?: Date | null;
  to?: Date | null;
}

/**
 * One distinct volunteer in the org-wide hours aggregate. Grouping key
 * is `humanId` when the signup is linked to an account, else the
 * lowercased `contactEmail` (shadow-only volunteers). A volunteer whose
 * older signups predate account linking can therefore appear twice —
 * once keyed by email, once by humanId.
 *
 * `totalHours` uses the exact same per-signup semantics as
 * `HoursReportRow.actualHours` (`hoursWorked` override when set, else
 * the shift's scheduled duration rounded to 2dp; signups with neither
 * a shift nor an override contribute nothing) so the org total always
 * matches the sum of the per-event exports.
 */
export interface OrgVolunteerHoursRow {
  /** Stable grouping key: `humanId`, or `email:<lowercased contactEmail>`. */
  volunteerKey: string;
  humanId: string | null;
  contactEmail: string;
  contactName: string | null;
  /** Sum of actual hours across all matching signups, 2dp. */
  totalHours: number;
  /** Number of distinct events the volunteer signed up for. */
  eventsCount: number;
  /** Number of matching signups (a volunteer can hold several per event). */
  signupsCount: number;
  /** Most recent shift start (signup `createdAt` for shiftless signups). */
  lastShiftAt: Date;
}

/**
 * Duplicate-signup lookup key: the legacy event-scoped unique
 * `(eventId, roleId, contactEmail)` or the ask-scoped
 * `(askId, roleId, contactEmail)` that generic asks use.
 */
export type VolunteerSignupEmailKey =
  | { eventId: string; roleId: string; contactEmail: string }
  | { askId: string; roleId: string; contactEmail: string };

export interface ListVolunteerSignupsOpts {
  roleId?: string;
  shiftId?: string;
  status?: VolunteerSignupStatus;
  /**
   * Group filter (ask-scoped lists). A string returns ONLY that group's
   * signups; explicit `null` returns only unassigned signups — combined
   * with `status: "APPROVED"` that is the ask's general pool. Omitted =
   * no group filtering.
   */
  groupId?: string | null;
  limit?: number;
  offset?: number;
}

/**
 * Cursor variant of `ListVolunteerSignupsOpts` for the roster keyset reads
 * (`listSignupsByAskCursor`). Same filters, but pagination is a value-based
 * keyset cursor (opaque string minted by the adapter) instead of an offset.
 */
export interface ListVolunteerSignupsCursorOpts {
  roleId?: string;
  shiftId?: string;
  status?: VolunteerSignupStatus;
  /** Same semantics as `ListVolunteerSignupsOpts.groupId`. */
  groupId?: string | null;
  /** Opaque keyset cursor from a previous page's `nextCursor`. */
  cursor?: string | null;
  limit?: number;
}

/** One keyset page of signups: items + the opaque continuation cursor. */
export interface VolunteerSignupCursorPage {
  items: VolunteerSignupRecord[];
  /** Null when this page exhausted the result set. */
  nextCursor: string | null;
}

// ── Volunteer comp-ticket rewards ─────────────────────────────────────────
// See docs/specs/2026-06-29/completed/volunteer-comp-tickets.spec.yaml (+ 2026-07-01
// resolutions: COMP-only, EVENT-subject asks only). A reward is a comp-ticket
// policy attached to an ask (roleId null = whole ask) or a specific role; a
// grant is the per-signup idempotency + audit + revocation unit.

/** Mirrors the Prisma `VolunteerRewardTrigger` enum. */
export type VolunteerRewardTrigger = "ON_APPROVAL" | "ON_CHECK_IN";

/** Mirrors the Prisma `VolunteerRewardGrantStatus` enum. */
export type VolunteerRewardGrantStatus = "GRANTED" | "REDEEMED" | "REVOKED";

export interface VolunteerRewardRecord {
  id: string;
  askId: string;
  /** Null = applies to the whole ask; set = role-specific (takes precedence). */
  roleId: string | null;
  /** The TicketType the comp targets (Order.source=COMP, $0 order). */
  ticketTypeId: string;
  trigger: VolunteerRewardTrigger;
  /** Budget cap: max grants this reward may ever issue. Null = uncapped. */
  maxGrants: number | null;
  /** Budget counter checked against `maxGrants` at grant time (FOR UPDATE). */
  grantsUsed: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Create-or-update payload for the reward attached to (askId, roleId?).
 * `roleId` null / omitted addresses the whole-ask reward; a value addresses
 * the role-specific one. On update, the provided fields are patched.
 */
export interface UpsertVolunteerRewardInput {
  askId: string;
  roleId?: string | null;
  ticketTypeId: string;
  trigger?: VolunteerRewardTrigger;
  maxGrants?: number | null;
  active?: boolean;
}

/**
 * Narrow projection returned by `getRewardForUpdate` — the row is
 * SELECT ... FOR UPDATE-locked inside the ambient tx so the grant use case
 * can serialize its budget check against concurrent triggers.
 */
export interface VolunteerRewardBudgetLock {
  id: string;
  askId: string;
  roleId: string | null;
  ticketTypeId: string;
  trigger: VolunteerRewardTrigger;
  maxGrants: number | null;
  grantsUsed: number;
  active: boolean;
}

export interface VolunteerRewardGrantRecord {
  id: string;
  rewardId: string;
  signupId: string;
  /** Null for shadow profiles pre-claim; the claim flow links it later. */
  humanId: string | null;
  contactEmail: string;
  status: VolunteerRewardGrantStatus;
  /** COMP order (Order.source=COMP, $0) issued for this grant. */
  compOrderId: string | null;
  /** The minted comp Ticket — void/scan tracking hangs off its status. */
  ticketId: string | null;
  /** TicketType.priceCents snapshot at grant time (integer cents, reporting). */
  faceValueCents: number;
  grantedAt: Date;
  redeemedAt: Date | null;
  revokedAt: Date | null;
  revokeReason: string | null;
}

export interface CreateVolunteerRewardGrantInput {
  rewardId: string;
  signupId: string;
  humanId?: string | null;
  contactEmail: string;
  status?: VolunteerRewardGrantStatus;
  compOrderId?: string | null;
  ticketId?: string | null;
  faceValueCents: number;
}

export interface UpdateVolunteerRewardGrantStatusInput {
  status: VolunteerRewardGrantStatus;
  redeemedAt?: Date | null;
  revokedAt?: Date | null;
  revokeReason?: string | null;
}

/** Optional narrowing for the ask reward ledger read. */
export interface ListRewardGrantsByAskOpts {
  status?: VolunteerRewardGrantStatus;
}

/**
 * Coordinator-safe per-signup reward status (FR-006, NFR-003): the BARE
 * grant lifecycle enum for a signup that has a grant — never face value,
 * comp order, budget, or any other money/PII field. `REDEEMED` is derived
 * from the grant being `REDEEMED` OR its linked `Ticket.status === "SCANNED"`
 * (mirrors the owner ledger's redemption derivation), so a scanned comp reads
 * as spent even before `redeemedAt` is stamped. Signups without a grant are
 * simply absent from the result — there is no "none" row.
 */
export interface VolunteerRewardGrantStatusBySignup {
  signupId: string;
  status: VolunteerRewardGrantStatus;
}

/**
 * One ledger row for `listGrantsByAsk`: the grant plus the reward context
 * (roleId + face-target ticket type) and the LIVE ticket status. A
 * `ticketStatus === "SCANNED"` ticket is effectively redeemed even before
 * `redeemedAt` is stamped, so the ledger can reconcile redemption from the
 * ticket itself. `ticketStatus` is null when no comp ticket is linked
 * (pre-mint / revoked-before-issue rows).
 */
export interface VolunteerRewardGrantLedgerRow extends VolunteerRewardGrantRecord {
  /** The owning reward's roleId (null = ask-level reward). */
  rewardRoleId: string | null;
  /** The owning reward's target TicketType. */
  rewardTicketTypeId: string;
  /** Live status of the linked comp Ticket, or null when unlinked. */
  ticketStatus: TicketStatus | null;
}
