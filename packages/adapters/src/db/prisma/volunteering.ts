import { Prisma } from "@prisma/client";

import { fail } from "@th/errors";

import {
  resolveWithheldOwners,
  withEventOwnerNotWithheld,
  type WithheldOwners,
} from "./banned-owner";
import type { VolunteerRepo } from "@th/ports/repos/volunteering";
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
  VolunteerSubjectType,
  VolunteerAskStatus,
  VolunteerAskRecord,
  CreateVolunteerAskInput,
  UpdateVolunteerAskInput,
  VolunteerGroupRecord,
  VolunteerGroupWithRosterInfoRecord,
  CreateVolunteerGroupInput,
  UpdateVolunteerGroupInput,
  VolunteerBroadcastScopeType,
  VolunteerBroadcastRecord,
  CreateVolunteerBroadcastInput,
  VolunteerFeedSignupRecord,
  VolunteerCommitmentRecord,
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
  TicketStatus,
  VolunteerShiftOccurrenceRecord,
  CreateVolunteerShiftOccurrenceInput,
  UpdateVolunteerShiftOccurrenceInput,
  ListVolunteerOccurrencesOpts,
  VolunteerOccurrenceClaimRecord,
  CreateVolunteerOccurrenceClaimInput,
  UpdateVolunteerOccurrenceClaimInput,
  VolunteerOccurrenceClaimRosterRow,
} from "@th/types";
// The ONE hours-crediting rule, shared with the use cases (see the module
// doc for why it lives in @th/types rather than @th/core/lib).
import { creditedHours, scheduledHoursBetween } from "@th/types/volunteer-hours";
import {
  buildOffsetPaginatedResult,
  sanitizeOffsetPagination,
} from "@th/ports/pagination";

import type { PrismaClientOrTx } from "./types";

// ── Select objects ──────────────────────────────────────────────────────────

const ASK_SELECT = {
  id: true,
  subjectType: true,
  subjectId: true,
  orgId: true,
  title: true,
  description: true,
  status: true,
  cadence: true,
  startsAt: true,
  endsAt: true,
  timezone: true,
  capacity: true,
  autoApprove: true,
  waiverRequired: true,
  waiverTemplateId: true,
  smsOptInEnabled: true,
  formSchema: true,
  createdAt: true,
  updatedAt: true,
} as const;

const GROUP_SELECT = {
  id: true,
  askId: true,
  name: true,
  description: true,
  capacity: true,
  coordinatorHumanId: true,
  createdAt: true,
  updatedAt: true,
} as const;

const BROADCAST_SELECT = {
  id: true,
  askId: true,
  senderHumanId: true,
  scopeType: true,
  scopeId: true,
  subject: true,
  body: true,
  recipientCount: true,
  createdAt: true,
} as const;

const ROLE_TEMPLATE_SELECT = {
  id: true,
  orgId: true,
  name: true,
  description: true,
  defaultCapacity: true,
  sortOrder: true,
  archived: true,
  // Carried on EVERY template read: callers cannot tell a read-only
  // catalogue row from an org's own row without them.
  isPlatform: true,
  packId: true,
  createdAt: true,
  updatedAt: true,
} as const;

const VOLUNTEER_PACK_SELECT = {
  id: true,
  key: true,
  name: true,
  blurb: true,
  status: true,
  targetCategoryIds: true,
  rankFirst: true,
  sortOrder: true,
  curatedByHumanId: true,
  createdAt: true,
  updatedAt: true,
} as const;

const ROLE_TEMPLATE_SHIFT_SELECT = {
  id: true,
  templateId: true,
  label: true,
  startMinuteOfDay: true,
  endMinuteOfDay: true,
  startDayOffset: true,
  endsNextDay: true,
  capacity: true,
  position: true,
  anchor: true,
  offsetMinutes: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * "This row is a LIVE catalogue row." Platform rows are identified by BOTH
 * `isPlatform` and a null `orgId` so a mis-shaped row (flag set with an
 * orgId, or orgId null without the flag) is invisible rather than
 * ambiguously visible, and by a LIVE pack so DRAFT packs never leak.
 */
const LIVE_PLATFORM_TEMPLATE_WHERE = {
  isPlatform: true,
  orgId: null,
  pack: { is: { status: "LIVE" as const } },
} as const;

const EVENT_ROLE_SELECT = {
  id: true,
  eventId: true,
  askId: true,
  templateId: true,
  name: true,
  description: true,
  capacity: true,
  autoApprove: true,
  defaultHours: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
} as const;

const SHIFT_SELECT = {
  id: true,
  roleId: true,
  label: true,
  startsAt: true,
  endsAt: true,
  capacity: true,
  notes: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
} as const;

const SIGNUP_SELECT = {
  id: true,
  eventId: true,
  askId: true,
  roleId: true,
  shiftId: true,
  groupId: true,
  humanId: true,
  contactEmail: true,
  contactName: true,
  contactPhone: true,
  smsOptIn: true,
  status: true,
  hoursWorked: true,
  answers: true,
  reviewerHumanId: true,
  reviewedAt: true,
  checkedInAt: true,
  // 1:1 relation — single joined read, powers the admin "waiver ✓" chip.
  waiverAcceptance: { select: { acceptedAt: true } },
  notes: true,
  metadata: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * ONE projection behind BOTH volunteer-signup reads keyed by human:
 * `listUpcomingSignupsForFeed` (.ics feed) and `listCommitmentsByHuman`
 * (the `/my-volunteering` page). They ask different `where`s of the same
 * shape, so the select and its mapper (`mapCommitment`) are shared — a
 * hand-copied second projection drifts silently.
 *
 * `ask` is joined on BOTH paths (not just the ask path) so a shift-bearing
 * signup on an ask-owned role — legal: `EventVolunteerRole.eventId` is
 * nullable — still has a title to show. `event` is likewise joined on the
 * ask path, which the PAGE wants (an ask-path row on an EVENT-subject ask
 * is still linkable) but the FEED must not gain: `toFeedRecord` nulls
 * those three event fields back out on ask-path rows so the .ics output is
 * byte-identical to what it was before this projection was shared. That is
 * NOT a theoretical concern — see `toFeedRecord` for the reachable case.
 */
const HUMAN_SIGNUP_SELECT = {
  id: true,
  status: true,
  eventId: true,
  askId: true,
  hoursWorked: true,
  checkedInAt: true,
  createdAt: true,
  event: {
    select: { title: true, slug: true, timezone: true, addressText: true },
  },
  // `cadence` rides along for `VolunteerCommitmentRecord.cadence`. It is
  // page-only: `toFeedRecord` does not carry it, so the .ics output is
  // unchanged by its presence in the projection.
  // `timezone` is the zone the ask's window was stated in; it fills
  // `eventTimezone` on ask-path rows (see `mapCommitment`).
  ask: {
    select: {
      title: true,
      cadence: true,
      startsAt: true,
      endsAt: true,
      timezone: true,
      subjectType: true,
    },
  },
  role: {
    select: { name: true, _count: { select: { shifts: true } } },
  },
  shift: { select: { label: true, startsAt: true, endsAt: true } },
  // Text-reminder facts (`reminderBasis`); the phone is reduced to a boolean
  // in the mapper and never returned.
  shiftId: true,
  smsOptIn: true,
  contactPhone: true,
} as const;

/**
 * The OCCURRENCE half of the `/my-volunteering` read: one volunteer's claim
 * on one dated slot of a standing ask. Page-only — the .ics feed never
 * reads it (see `listCommitmentsByHuman` and the guard in `toFeedRecord`).
 *
 * Window, role and cadence come off the OCCURRENCE and its ask, never the
 * parent signup's ask window, which is the whole reason this row type
 * exists. The parent signup is joined only for the two things a claim
 * cannot know on its own: whose commitment it is (`status`, for the rows
 * where a claim was never checked in) and when they applied.
 *
 * No `event` join: occurrences live only on non-EVENT asks
 * (`resolveOccurrenceContext` rejects EVENT-subject asks), so there is no
 * event to link and the row's href resolves via `askId`.
 */
const HUMAN_CLAIM_SELECT = {
  id: true,
  status: true,
  checkedInAt: true,
  hoursWorked: true,
  createdAt: true,
  occurrence: {
    select: {
      id: true,
      askId: true,
      startsAt: true,
      endsAt: true,
      status: true,
      role: { select: { name: true } },
      ask: {
        select: {
          title: true,
          cadence: true,
          timezone: true,
          subjectType: true,
          startsAt: true,
        },
      },
    },
  },
  signup: {
    select: {
      id: true,
      status: true,
      eventId: true,
      shiftId: true,
      smsOptIn: true,
      contactPhone: true,
      role: { select: { _count: { select: { shifts: true } } } },
    },
  },
} as const;

/**
 * Ceiling on the SIGNUP half of `listCommitmentsByHuman`. Matches the
 * roster keyset read's `SIGNUP_CURSOR_MAX_LIMIT` (200) — the file's
 * existing answer to "how many signup rows may one query return". The page
 * is unpaginated, so this is a truncation point, not a page size: see the
 * port doc for which rows are dropped and why the DB-level `orderBy` that
 * pairs with it is `createdAt` DESC rather than the caller-facing sort.
 */
export const COMMITMENTS_MAX_ROWS = 200;

/**
 * Ceiling on EACH occurrence-claim bucket (upcoming, past) of
 * `listCommitmentsByHuman`.
 *
 * ── Why claims are capped SEPARATELY, and in two buckets ─────────────────
 *
 * A standing volunteer holds ONE signup and accumulates one claim per week
 * forever, so claims are the row type that multiplies. Unioning them into
 * the signup query and capping the total would let three years of Tuesday
 * nights evict every event signup a volunteer holds — the cap would stop
 * meaning "drop the oldest history" and start meaning "drop whatever lost".
 * Each source therefore carries its own bound.
 *
 * Within claims the split is by the caller's `now`, because a SINGLE
 * ordering cannot protect upcoming rows: `startsAt` ASC truncates away the
 * future, and `startsAt` DESC truncates away the SOONEST future (keeping
 * the furthest-out dates — the worst possible answer). Two bounded queries
 * — upcoming ASC, past DESC — make the guarantee exact rather than
 * probable: truncation can only ever drop the FURTHEST-future slot beyond
 * the 100th, or the OLDEST past one.
 *
 * 100, not 200: at one slot a week that is ~2 years of history per bucket,
 * and it holds the whole unpaginated payload to
 * `COMMITMENTS_MAX_ROWS + 2 × this` = 400 rows.
 */
export const COMMITMENT_CLAIM_MAX_ROWS = 100;

const OCCURRENCE_SELECT = {
  id: true,
  askId: true,
  roleId: true,
  patternId: true,
  startsAt: true,
  endsAt: true,
  capacity: true,
  notes: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const;

const OCCURRENCE_CLAIM_SELECT = {
  id: true,
  occurrenceId: true,
  signupId: true,
  status: true,
  source: true,
  checkedInAt: true,
  hoursWorked: true,
  createdAt: true,
  updatedAt: true,
} as const;

const REWARD_SELECT = {
  id: true,
  askId: true,
  roleId: true,
  ticketTypeId: true,
  trigger: true,
  maxGrants: true,
  grantsUsed: true,
  active: true,
  createdAt: true,
  updatedAt: true,
} as const;

const GRANT_SELECT = {
  id: true,
  rewardId: true,
  signupId: true,
  humanId: true,
  contactEmail: true,
  status: true,
  compOrderId: true,
  ticketId: true,
  faceValueCents: true,
  grantedAt: true,
  redeemedAt: true,
  revokedAt: true,
  revokeReason: true,
} as const;

// ── Mappers ─────────────────────────────────────────────────────────────────

const mapAsk = (row: any): VolunteerAskRecord => ({
  id: row.id,
  subjectType: row.subjectType,
  subjectId: row.subjectId,
  orgId: row.orgId ?? null,
  title: row.title,
  description: row.description ?? null,
  status: row.status,
  cadence: row.cadence,
  startsAt: row.startsAt ?? null,
  endsAt: row.endsAt ?? null,
  timezone: row.timezone ?? null,
  capacity: row.capacity ?? null,
  autoApprove: row.autoApprove,
  waiverRequired: row.waiverRequired,
  waiverTemplateId: row.waiverTemplateId ?? null,
  smsOptInEnabled: row.smsOptInEnabled,
  formSchema: row.formSchema,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const mapGroup = (row: any): VolunteerGroupRecord => ({
  id: row.id,
  askId: row.askId,
  name: row.name,
  description: row.description ?? null,
  capacity: row.capacity ?? null,
  coordinatorHumanId: row.coordinatorHumanId ?? null,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const mapBroadcast = (row: any): VolunteerBroadcastRecord => ({
  id: row.id,
  askId: row.askId,
  senderHumanId: row.senderHumanId,
  scopeType: row.scopeType as VolunteerBroadcastScopeType,
  scopeId: row.scopeId ?? null,
  subject: row.subject,
  body: row.body,
  recipientCount: row.recipientCount,
  createdAt: row.createdAt,
});

const mapTemplate = (row: any): RoleTemplateRecord => ({
  id: row.id,
  orgId: row.orgId ?? null,
  name: row.name,
  description: row.description ?? null,
  defaultCapacity: row.defaultCapacity ?? null,
  sortOrder: row.sortOrder,
  archived: row.archived,
  isPlatform: row.isPlatform,
  packId: row.packId ?? null,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const mapTemplateShift = (row: any): RoleTemplateShiftRecord => ({
  id: row.id,
  templateId: row.templateId,
  label: row.label,
  startMinuteOfDay: row.startMinuteOfDay,
  endMinuteOfDay: row.endMinuteOfDay,
  startDayOffset: row.startDayOffset,
  endsNextDay: row.endsNextDay,
  capacity: row.capacity ?? null,
  position: row.position,
  anchor: row.anchor,
  offsetMinutes: row.offsetMinutes,
  notes: row.notes ?? null,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const mapPack = (row: any): VolunteerPackRecord => ({
  id: row.id,
  key: row.key,
  name: row.name,
  blurb: row.blurb ?? null,
  status: row.status,
  targetCategoryIds: row.targetCategoryIds ?? [],
  rankFirst: row.rankFirst,
  sortOrder: row.sortOrder,
  curatedByHumanId: row.curatedByHumanId ?? null,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const mapPackWithRoles = (row: any): VolunteerPackWithRolesRecord => ({
  ...mapPack(row),
  roles: (row.roles ?? []).map((role: any) => ({
    ...mapTemplate(role),
    shifts: (role.shifts ?? []).map(mapTemplateShift),
  })),
});

const mapRole = (row: any): EventVolunteerRoleRecord => ({
  id: row.id,
  eventId: row.eventId ?? null,
  askId: row.askId ?? null,
  templateId: row.templateId ?? null,
  name: row.name,
  description: row.description ?? null,
  capacity: row.capacity ?? null,
  autoApprove: row.autoApprove ?? null,
  defaultHours: decToNumber(row.defaultHours),
  sortOrder: row.sortOrder,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const mapShift = (row: any): VolunteerShiftRecord => ({
  id: row.id,
  roleId: row.roleId,
  label: row.label ?? null,
  startsAt: row.startsAt,
  endsAt: row.endsAt,
  capacity: row.capacity ?? null,
  notes: row.notes ?? null,
  sortOrder: row.sortOrder,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const mapRoleWithShifts = (row: any): EventVolunteerRoleWithShiftsRecord => ({
  ...mapRole(row),
  shifts: (row.shifts ?? []).map(mapShift),
});

// Prisma's `Decimal` arrives as a `Decimal` instance — convert to a
// plain number for the port boundary. `hoursWorked` is bounded to
// Decimal(5,2) at the column level so the JS-number coercion is safe.
const decToNumber = (v: unknown): number | null => {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v);
  if (typeof (v as { toNumber?: () => number }).toNumber === "function") {
    return (v as { toNumber: () => number }).toNumber();
  }
  return null;
};

const mapSignup = (row: any): VolunteerSignupRecord => ({
  id: row.id,
  eventId: row.eventId ?? null,
  askId: row.askId ?? null,
  roleId: row.roleId,
  shiftId: row.shiftId ?? null,
  groupId: row.groupId ?? null,
  humanId: row.humanId ?? null,
  contactEmail: row.contactEmail,
  contactName: row.contactName ?? null,
  contactPhone: row.contactPhone ?? null,
  smsOptIn: row.smsOptIn ?? false,
  status: row.status,
  hoursWorked: decToNumber(row.hoursWorked),
  answers: row.answers,
  reviewerHumanId: row.reviewerHumanId ?? null,
  reviewedAt: row.reviewedAt ?? null,
  checkedInAt: row.checkedInAt ?? null,
  waiverAcceptedAt: row.waiverAcceptance?.acceptedAt ?? null,
  // Roster badge flag (FR-009): presence of the 1:1 acceptance relation.
  waiverAccepted: row.waiverAcceptance != null,
  notes: row.notes ?? null,
  metadata: row.metadata,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/**
 * `HUMAN_SIGNUP_SELECT` row → the superset commitment record. Shared by the
 * .ics feed and the `/my-volunteering` page (the feed narrows via
 * `toFeedRecord`).
 *
 * Path/source resolution, in order:
 *  - shift present → `EVENT_SHIFT`; window from the shift, title from the
 *    event (falling back to the ask for an ask-owned role's shift).
 *  - no shift, ask present → `ASK_WINDOW`; window and title from the ask.
 *    `startsAt` is null when the ask has none — the windowless case.
 *  - neither → `EVENT_SHIFT` with a null window: a shiftless event signup
 *    (an ask-less one only exists if the A1 askId backfill missed it).
 */
const mapCommitment = (row: any): VolunteerCommitmentRecord => {
  const shift = row.shift ?? null;
  const ask = row.ask ?? null;
  const event = row.event ?? null;
  const isAskPath = !shift && ask != null;
  const override = decToNumber(row.hoursWorked);

  // `hoursCredited` uses the ONE shared rule (`creditedHours`), so this
  // page agrees with the organizer's hours export and the org aggregate
  // about the same signup.
  //
  // ── CARVE-OUT: never derive hours from an ASK window ──────────────────
  // The rule derives from the SHIFT's duration. On an ask-path row the
  // only window available is the ASK's, which legitimately spans months
  // (a standing "help out this season" ask) — feeding that to
  // `creditedHours` would credit the volunteer with thousands of hours on
  // a statement they submit for school service credit or grant reporting.
  // So the ask path gets the override ALONE and is null without one.
  // Do not "simplify" this to a single unconditional `creditedHours(...)`
  // call; a test pins a multi-month ask window at null.
  const hoursCredited = isAskPath
    ? (override ?? null)
    : creditedHours(override, shift?.startsAt, shift?.endsAt);

  return {
    signupId: row.id,
    // Signup rows are never occurrence rows — that is what these two nulls
    // mean, and `occurrenceId` is the discriminator callers key off.
    claimId: null,
    occurrenceId: null,
    status: row.status,
    source: isAskPath ? "ASK_WINDOW" : "EVENT_SHIFT",
    title: isAskPath
      ? ask.title
      : (event?.title ?? ask?.title ?? row.role.name),
    roleName: row.role.name,
    shiftLabel: shift?.label ?? null,
    startsAt: shift ? shift.startsAt : (ask?.startsAt ?? null),
    endsAt: shift ? shift.endsAt : (ask?.endsAt ?? null),
    eventId: row.eventId ?? null,
    eventSlug: event?.slug ?? null,
    // Ask path: the window is the ASK's, so it renders in the zone the
    // organiser stated it in, falling back to the event's for an older
    // zoneless ask. Shift path: the event's zone, as before.
    eventTimezone: isAskPath
      ? (ask.timezone ?? event?.timezone ?? null)
      : (event?.timezone ?? null),
    addressText: event?.addressText ?? null,
    askId: row.askId ?? null,
    hoursWorked: override,
    hoursCredited,
    checkedInAt: row.checkedInAt ?? null,
    createdAt: row.createdAt,
    cadence: ask?.cadence ?? null,
    smsOptIn: row.smsOptIn === true,
    hasContactPhone: (row.contactPhone ?? "").trim().length > 0,
    reminderBasis: {
      shiftId: row.shiftId ?? null,
      roleHasShifts: (row.role?._count?.shifts ?? 0) > 0,
      ask: ask
        ? {
            subjectType: ask.subjectType,
            cadence: ask.cadence,
            startsAt: ask.startsAt ?? null,
          }
        : null,
    },
  };
};

/**
 * `HUMAN_CLAIM_SELECT` row → one commitment record for one CLAIMED dated
 * slot on a standing ask. Page-only; see `listCommitmentsByHuman`.
 *
 * ── Status: the CLAIM's state, not the parent's ──────────────────────────
 *
 * `VolunteerCommitmentRecord.status` speaks `VolunteerSignupStatus`, so a
 * claim's state is expressed in that vocabulary:
 *
 *   claim.checkedInAt set          → CHECKED_IN  (this slot was worked)
 *   parent CHECKED_IN, claim not   → APPROVED    (see below)
 *   otherwise                      → the parent's status
 *
 * The middle line is the load-bearing one. `checkInVolunteer` stamps
 * CHECKED_IN on the SIGNUP (and `role.defaultHours` with it) when an owner
 * checks a volunteer in at the ask level — a fact about one occasion, not
 * about every Tuesday they have claimed. Inheriting it would mark future
 * slots CHECKED_IN, and CHECKED_IN is the gate every hours surface counts
 * on (`isCreditableShift` on the page, and the printable statement handed
 * to a school registrar), so each unworked claim would be billed at its
 * full duration. Reporting APPROVED states exactly what is true: they are
 * on the schedule for that date.
 *
 * A parent that has since gone REJECTED / WITHDRAWN / NO_SHOW DOES carry
 * through — the volunteer needs to see they are off the roster.
 */
const mapOccurrenceCommitment = (row: any): VolunteerCommitmentRecord => {
  const occurrence = row.occurrence;
  const ask = occurrence.ask;
  const signup = row.signup;
  const override = decToNumber(row.hoursWorked);
  const checkedInAt = row.checkedInAt ?? null;

  const parentStatus = signup.status;
  const status = checkedInAt
    ? "CHECKED_IN"
    : parentStatus === "CHECKED_IN"
      ? "APPROVED"
      : parentStatus;

  return {
    signupId: signup.id,
    claimId: row.id,
    occurrenceId: occurrence.id,
    status,
    // Ask PATH (title, link and ask id are the ask's) with an OCCURRENCE
    // window. `occurrenceId` is what tells the two apart — see the record
    // doc; `source` was deliberately not widened.
    source: "ASK_WINDOW",
    title: ask.title,
    roleName: occurrence.role.name,
    // `VolunteerShiftOccurrence` has `notes` (admin-only) but no label.
    shiftLabel: null,
    startsAt: occurrence.startsAt,
    endsAt: occurrence.endsAt,
    // Occurrences exist only on non-EVENT asks, so there is no event to
    // join; `eventId` rides through from the parent purely so a
    // hand-crafted row cannot silently claim to be event-less.
    eventId: signup.eventId ?? null,
    eventSlug: null,
    // The occurrence's dated slot belongs to its ask, so it renders in the
    // zone the ask states. Null on a zoneless (older) ask.
    eventTimezone: ask.timezone ?? null,
    addressText: null,
    askId: occurrence.askId,
    // The CLAIM's per-occurrence override (`checkInOccurrenceClaim`), never
    // the parent signup's — claim hours are additive to signup hours, not a
    // copy of them.
    hoursWorked: override,
    // ── The window here is a SHIFT window, so deriving hours is legal ────
    // Contrast `mapCommitment`'s ask-path carve-out: an ASK window can span
    // months and is never converted to hours (the ~2208-hour failure mode).
    // An occurrence is a bounded dated slot — `updateShiftOccurrence` caps
    // new windows at 24h — which is exactly what `creditedHours` is
    // documented to accept. Pass `occurrence.startsAt/endsAt` and NOTHING
    // else: reaching for `ask.startsAt/endsAt` here would resurrect that
    // bug on the row type most likely to end up on a service statement.
    hoursCredited: creditedHours(
      override,
      occurrence.startsAt,
      occurrence.endsAt,
    ),
    checkedInAt,
    // The CLAIM's creation — when this dated commitment was made. The
    // parent signup's date belongs to the parent row.
    createdAt: row.createdAt,
    cadence: ask.cadence ?? null,
    // The PARENT signup's opt-in and anchor facts: the toggle is per signup.
    smsOptIn: signup.smsOptIn === true,
    hasContactPhone: (signup.contactPhone ?? "").trim().length > 0,
    reminderBasis: {
      shiftId: signup.shiftId ?? null,
      roleHasShifts: (signup.role?._count?.shifts ?? 0) > 0,
      ask: {
        subjectType: ask.subjectType,
        cadence: ask.cadence,
        startsAt: ask.startsAt ?? null,
      },
    },
  };
};

/**
 * Commitment → .ics feed row: drops the three page-only fields
 * (`hoursWorked` / `checkedInAt` / `createdAt`) and the windowless rows
 * (`startsAt: null`), which a calendar entry can't carry.
 *
 * ALSO re-nulls `eventSlug` / `eventTimezone` / `addressText` on ask-path
 * rows. Before this projection was shared the feed's ask-path query simply
 * didn't join the event and hard-coded those three to null; `mapCommitment`
 * now joins it because the PAGE wants them. Keeping the enrichment here
 * would silently add `LOCATION` and `URL` to VEVENTs in calendars people
 * are already subscribed to — an unrequested change to a live surface, and
 * a REACHABLE one:
 *
 *   `volunteerSubjectTypeSchema` includes "EVENT" and
 *   `updateVolunteerAskInputSchema` accepts `startsAt`, while
 *   `updateVolunteerAsk` never inspects `subjectType` — so an EVENT-subject
 *   ask WITH a window is API-reachable even though the web UI gates it out.
 *   `resolveOrCreateEventAsk` then adopts that windowed ask and later
 *   event-path signups stamp its `askId`, so a shiftless APPROVED signup on
 *   that event satisfies the feed's ask-path `where` verbatim AND carries an
 *   `eventId`.
 *
 * If we want that enrichment in the feed it ships as its own reviewed
 * change, not as a side effect of a page read model.
 *
 * ALSO drops occurrence rows outright. The feed's two queries read
 * `volunteerSignup` and cannot produce one, so this is belt-and-braces —
 * but it is the SAME class of leak as the event-field enrichment above
 * (a page-only row type silently appearing in calendars people are already
 * subscribed to), and that one was reachable. Standing-shift occurrences in
 * the .ics feed ship as their own reviewed change.
 */
const toFeedRecord = (
  c: VolunteerCommitmentRecord,
): VolunteerFeedSignupRecord | null => {
  if (c.startsAt === null) return null;
  if (c.occurrenceId !== null) return null;
  const isAskPath = c.source === "ASK_WINDOW";
  return {
    signupId: c.signupId,
    status: c.status,
    source: c.source,
    title: c.title,
    roleName: c.roleName,
    shiftLabel: c.shiftLabel,
    startsAt: c.startsAt,
    endsAt: c.endsAt,
    eventId: c.eventId,
    eventSlug: isAskPath ? null : c.eventSlug,
    eventTimezone: isAskPath ? null : c.eventTimezone,
    addressText: isAskPath ? null : c.addressText,
    askId: c.askId,
  };
};

const mapOccurrence = (row: any): VolunteerShiftOccurrenceRecord => ({
  id: row.id,
  askId: row.askId,
  roleId: row.roleId,
  patternId: row.patternId ?? null,
  startsAt: row.startsAt,
  endsAt: row.endsAt,
  capacity: row.capacity ?? null,
  notes: row.notes ?? null,
  status: row.status,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const mapOccurrenceClaim = (row: any): VolunteerOccurrenceClaimRecord => ({
  id: row.id,
  occurrenceId: row.occurrenceId,
  signupId: row.signupId,
  status: row.status,
  source: row.source,
  checkedInAt: row.checkedInAt ?? null,
  hoursWorked: decToNumber(row.hoursWorked),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const mapReward = (row: any): VolunteerRewardRecord => ({
  id: row.id,
  askId: row.askId,
  roleId: row.roleId ?? null,
  ticketTypeId: row.ticketTypeId,
  trigger: row.trigger as VolunteerRewardTrigger,
  maxGrants: row.maxGrants ?? null,
  grantsUsed: row.grantsUsed,
  active: row.active,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const mapGrant = (row: any): VolunteerRewardGrantRecord => ({
  id: row.id,
  rewardId: row.rewardId,
  signupId: row.signupId,
  humanId: row.humanId ?? null,
  contactEmail: row.contactEmail,
  status: row.status as VolunteerRewardGrantStatus,
  compOrderId: row.compOrderId ?? null,
  ticketId: row.ticketId ?? null,
  faceValueCents: row.faceValueCents,
  grantedAt: row.grantedAt,
  redeemedAt: row.redeemedAt ?? null,
  revokedAt: row.revokedAt ?? null,
  revokeReason: row.revokeReason ?? null,
});

// ── Grouped signup counts ───────────────────────────────────────────────────

// Status sets behind the grouped counts. "Active" includes the pending pool
// (admin-facing totals); "accepted" is seat-occupying only (capacity math,
// public occupancy).
const ACTIVE_SIGNUP_STATUSES = ["PENDING", "APPROVED", "CHECKED_IN"] as const;
const ACCEPTED_SIGNUP_STATUSES = ["APPROVED", "CHECKED_IN"] as const;

async function countSignupsByRole(
  p: PrismaClientOrTx,
  where: Prisma.VolunteerSignupWhereInput,
): Promise<Record<string, number>> {
  const groups = await p.volunteerSignup.groupBy({
    by: ["roleId"],
    where,
    _count: true,
  });
  const result: Record<string, number> = {};
  for (const g of groups) {
    result[g.roleId] = g._count;
  }
  return result;
}

async function countSignupsByShift(
  p: PrismaClientOrTx,
  where: Prisma.VolunteerSignupWhereInput,
): Promise<Record<string, number>> {
  const groups = await p.volunteerSignup.groupBy({
    by: ["shiftId"],
    where: { ...where, shiftId: { not: null } },
    _count: true,
  });
  const result: Record<string, number> = {};
  for (const g of groups) {
    if (g.shiftId) result[g.shiftId] = g._count;
  }
  return result;
}

/**
 * Shared paginated signup listing behind `listSignups` (event scope) and
 * `listSignupsByAsk` (ask scope). `groupId` is the roster primitive: a
 * string narrows to EXACTLY that group's rows (cross-group PII scoping in
 * core relies on this), explicit `null` narrows to unassigned rows —
 * `{ groupId: null, status: "APPROVED" }` is an ask's general pool.
 */
async function listSignupsWhere(
  p: PrismaClientOrTx,
  scope: { eventId: string } | { askId: string },
  opts?: ListVolunteerSignupsOpts,
) {
  const { limit, offset } = sanitizeOffsetPagination({
    limit: opts?.limit,
    offset: opts?.offset,
  });

  const where: any = { ...scope };
  if (opts?.roleId) where.roleId = opts.roleId;
  if (opts?.shiftId) where.shiftId = opts.shiftId;
  if (opts?.status) where.status = opts.status;
  if (opts?.groupId !== undefined) where.groupId = opts.groupId;

  const [rows, total] = await Promise.all([
    p.volunteerSignup.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: offset,
      take: limit,
      select: SIGNUP_SELECT,
    }),
    p.volunteerSignup.count({ where }),
  ]);

  return buildOffsetPaginatedResult({
    items: rows.map(mapSignup),
    total,
    limit,
    offset,
  });
}

// ── Keyset-cursor signup listing (roster pagination) ────────────────────────

/** Roster keyset page-size bounds: default 50, hard max 200. */
const SIGNUP_CURSOR_DEFAULT_LIMIT = 50;
const SIGNUP_CURSOR_MAX_LIMIT = 200;

/**
 * Value-based keyset cursor for `listSignupsByAskCursor`:
 * `<createdAt ISO>|<signup id>`. Value-based (not a Prisma row-cursor) so
 * pagination keeps working when the boundary row is deleted, withdrawn, or
 * reassigned to a group mid-scroll — mirrors `encodeSavedEventsCursor`
 * (event-saves.ts), this repo's established keyset precedent. Opaque at the
 * port boundary.
 */
export function encodeVolunteerSignupCursor(createdAt: Date, id: string): string {
  return `${createdAt.toISOString()}|${id}`;
}

/**
 * Defensive decode: a malformed cursor returns `null`, which the list treats
 * as "no cursor" (restart from the first page). Never 500s, never silently
 * hides rows — worst case the client re-sees page 1.
 */
export function decodeVolunteerSignupCursor(
  cursor: string,
): { createdAt: Date; id: string } | null {
  const sep = cursor.indexOf("|");
  if (sep <= 0 || sep === cursor.length - 1) {
    return null;
  }

  const createdAt = new Date(cursor.slice(0, sep));
  if (Number.isNaN(createdAt.getTime())) {
    return null;
  }

  return { createdAt, id: cursor.slice(sep + 1) };
}

/**
 * Keyset variant of `listSignupsWhere` for the roster reads. Same filters
 * (roleId / shiftId / status / groupId with the explicit-null pool
 * semantics), but ordered on the compound key (`createdAt` desc, `id` desc)
 * — `createdAt` alone is not unique, so the id tiebreak is what guarantees
 * no row is skipped or duplicated across pages. Fetches limit+1 rows to
 * decide `nextCursor` without a count query.
 */
async function listSignupsCursorWhere(
  p: PrismaClientOrTx,
  scope: { askId: string },
  opts?: ListVolunteerSignupsCursorOpts,
) {
  const limit = Math.min(
    Math.max(opts?.limit ?? SIGNUP_CURSOR_DEFAULT_LIMIT, 1),
    SIGNUP_CURSOR_MAX_LIMIT,
  );
  const decoded = opts?.cursor
    ? decodeVolunteerSignupCursor(opts.cursor)
    : null;

  const where: any = { ...scope };
  if (opts?.roleId) where.roleId = opts.roleId;
  if (opts?.shiftId) where.shiftId = opts.shiftId;
  if (opts?.status) where.status = opts.status;
  if (opts?.groupId !== undefined) where.groupId = opts.groupId;
  if (decoded) {
    // Strictly-after-the-boundary in (createdAt desc, id desc) order.
    where.OR = [
      { createdAt: { lt: decoded.createdAt } },
      { createdAt: decoded.createdAt, id: { lt: decoded.id } },
    ];
  }

  const rows = await p.volunteerSignup.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: SIGNUP_SELECT,
  });

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const items = pageRows.map(mapSignup);
  const last = items[items.length - 1];

  return {
    items,
    nextCursor:
      hasMore && last ? encodeVolunteerSignupCursor(last.createdAt, last.id) : null,
  };
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Single source of the ask-create column mapping, shared by `createAsk`
 * and `createAskIfAbsent` so the two inserts can never drift apart.
 */
function buildAskCreateData(input: CreateVolunteerAskInput) {
  return {
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    orgId: input.orgId ?? null,
    title: input.title,
    description: input.description ?? null,
    status: input.status ?? ("DRAFT" as const),
    cadence: input.cadence ?? ("ONE_TIME" as const),
    startsAt: input.startsAt ?? null,
    endsAt: input.endsAt ?? null,
    timezone: input.timezone ?? null,
    capacity: input.capacity ?? null,
    autoApprove: input.autoApprove ?? false,
    waiverRequired: input.waiverRequired ?? false,
    smsOptInEnabled: input.smsOptInEnabled ?? false,
    formSchema: (input.formSchema as any) ?? {},
  };
}

/**
 * An event a volunteer reminder may still go out for: PUBLISHED only. Not
 * `isEventPubliclyReadable`, which keeps a previously-live CANCELLED /
 * ARCHIVED event readable for its history page.
 */
const STILL_ON_EVENT_WHERE = { status: "PUBLISHED" } as const;

/**
 * An ask a start reminder may go out for (volunteer-ask-reminders R1, R6):
 * not an EVENT ask (its event roles ride the event), ONE_TIME with a start,
 * OPEN, PAUSED or CLOSED (not DRAFT, ARCHIVED), and an owner that is not
 * withheld. The owner rule is `isAskOwnerWithheld`'s for ORG and HUMAN asks;
 * PLACE asks are never withheld there either. Core re-applies the
 * cadence/start half through `signupReminderAnchor`.
 */
function askStillRemindableWhere(
  w: WithheldOwners,
): Prisma.VolunteerAskWhereInput {
  const withheld: Prisma.VolunteerAskWhereInput[] = [];
  if (w.orgIds.length > 0) {
    withheld.push({ subjectType: "ORG", subjectId: { in: [...w.orgIds] } });
  }
  if (w.humanIds.length > 0) {
    withheld.push({
      subjectType: "HUMAN",
      subjectId: { in: [...w.humanIds] },
    });
  }
  return {
    subjectType: { in: ["PLACE", "ORG", "HUMAN"] },
    cadence: "ONE_TIME",
    startsAt: { not: null },
    status: { in: ["OPEN", "PAUSED", "CLOSED"] },
    ...(withheld.length > 0 ? { NOT: withheld } : {}),
  };
}

export function makeVolunteeringRepo(p: PrismaClientOrTx): VolunteerRepo {
  return {
    // ── Generic asks ──────────────────────────────────────────────────

    async createAsk(input: CreateVolunteerAskInput) {
      try {
        const row = await p.volunteerAsk.create({
          data: buildAskCreateData(input),
          select: ASK_SELECT,
        });
        return mapAsk(row);
      } catch (error) {
        // P2002 on create can only come from the raw partial unique index
        // "VolunteerAsk_event_subject_key" (one EVENT-subject ask per event
        // — SQL-only, see the 20260701180000 migration): `id` is a fresh
        // uuid and VolunteerAsk has no other unique. Map the race loser to
        // the same domain error the use-case pre-check throws (same
        // convention as booking-requests' duplicate_open_request).
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          throw {
            code: "duplicate_event_ask",
            message: "duplicate_event_ask",
            cause: error,
          } as const;
        }
        throw error;
      }
    },

    async createAskIfAbsent(input: CreateVolunteerAskInput) {
      // `createMany({ skipDuplicates: true })` compiles to
      // INSERT ... ON CONFLICT DO NOTHING, which keeps the surrounding
      // interactive transaction healthy when the raw partial unique index
      // "VolunteerAsk_event_subject_key" fires — unlike `createAsk`, whose
      // P2002 aborts the Postgres tx (25P02) and poisons any recovery
      // re-read. Postgres infers arbiter indexes (including partial ones)
      // for DO NOTHING without a conflict target, so the partial index is
      // honored. Callers re-read the winner via `listAsksBySubject`.
      await p.volunteerAsk.createMany({
        data: [buildAskCreateData(input)],
        skipDuplicates: true,
      });
    },

    async updateAsk(id: string, input: UpdateVolunteerAskInput) {
      const row = await p.volunteerAsk.update({
        where: { id },
        data: {
          ...(input.title !== undefined && { title: input.title }),
          ...(input.description !== undefined && {
            description: input.description,
          }),
          ...(input.status !== undefined && { status: input.status }),
          ...(input.cadence !== undefined && { cadence: input.cadence }),
          ...(input.startsAt !== undefined && { startsAt: input.startsAt }),
          ...(input.endsAt !== undefined && { endsAt: input.endsAt }),
          ...(input.timezone !== undefined && { timezone: input.timezone }),
          ...(input.capacity !== undefined && { capacity: input.capacity }),
          ...(input.autoApprove !== undefined && {
            autoApprove: input.autoApprove,
          }),
          ...(input.waiverRequired !== undefined && {
            waiverRequired: input.waiverRequired,
          }),
          ...(input.smsOptInEnabled !== undefined && {
            smsOptInEnabled: input.smsOptInEnabled,
          }),
          ...(input.formSchema !== undefined && {
            formSchema: input.formSchema as any,
          }),
        },
        select: ASK_SELECT,
      });
      return mapAsk(row);
    },

    async setAskWaiverTemplate(input: {
      askId: string;
      waiverTemplateId: string | null;
    }) {
      const row = await p.volunteerAsk.update({
        where: { id: input.askId },
        data: { waiverTemplateId: input.waiverTemplateId },
        select: ASK_SELECT,
      });
      return mapAsk(row);
    },

    async getAsk(id: string) {
      const row = await p.volunteerAsk.findUnique({
        where: { id },
        select: ASK_SELECT,
      });
      return row ? mapAsk(row) : null;
    },

    async listAskOwnersByIds(askIds: string[]) {
      if (askIds.length === 0) return [];
      const rows = await p.volunteerAsk.findMany({
        where: { id: { in: askIds } },
        select: { id: true, subjectType: true, subjectId: true },
      });
      // EVENT asks point at an Event id: one batched read for their owners.
      const eventIds = [
        ...new Set(
          rows.filter((r) => r.subjectType === "EVENT").map((r) => r.subjectId),
        ),
      ];
      const events =
        eventIds.length > 0
          ? await p.event.findMany({
              where: { id: { in: eventIds } },
              select: { id: true, humanId: true, orgId: true },
            })
          : [];
      const ownerByEventId = new Map(events.map((e) => [e.id, e]));
      return rows.map((r) => {
        const base = {
          id: r.id,
          subjectType: r.subjectType,
          subjectId: r.subjectId,
        };
        if (r.subjectType !== "EVENT") return base;
        const ev = ownerByEventId.get(r.subjectId);
        return {
          ...base,
          eventOwner: { humanId: ev?.humanId ?? null, orgId: ev?.orgId ?? null },
        };
      });
    },

    async listAsksBySubject(
      subjectType: VolunteerSubjectType,
      subjectId: string,
    ) {
      const rows = await p.volunteerAsk.findMany({
        where: { subjectType, subjectId },
        orderBy: { createdAt: "desc" },
        select: ASK_SELECT,
      });
      return rows.map(mapAsk);
    },

    async listAsksByOrg(orgId: string, opts?: { status?: VolunteerAskStatus }) {
      const rows = await p.volunteerAsk.findMany({
        // EVENT-subject asks are excluded on purpose: this read backs ONLY the
        // org's standing ("Asks") dashboard, and every volunteering-enabled
        // event lazily backfills a `subjectType: "EVENT"` ask on the same
        // `orgId`. Those are managed on the per-event volunteer page, not here,
        // so surfacing them would pollute the standing list with one phantom
        // row per event. Standing subjects (ORG/PLACE/HUMAN) still appear.
        where: {
          orgId,
          subjectType: { not: "EVENT" },
          ...(opts?.status ? { status: opts.status } : {}),
        },
        orderBy: { createdAt: "desc" },
        select: ASK_SELECT,
      });
      return rows.map(mapAsk);
    },

    // ── Volunteer groups ──────────────────────────────────────────────

    async createGroup(input: CreateVolunteerGroupInput) {
      try {
        const row = await p.volunteerGroup.create({
          data: {
            askId: input.askId,
            name: input.name,
            description: input.description ?? null,
            capacity: input.capacity ?? null,
          },
          select: GROUP_SELECT,
        });
        return mapGroup(row);
      } catch (error) {
        // P2002 on create can only come from `@@unique([askId, name])` —
        // `id` is a fresh uuid and VolunteerGroup has no other unique. Map
        // it to a domain conflict (same convention as createAsk above).
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          throw {
            code: "duplicate_group_name",
            message: "duplicate_group_name",
            cause: error,
          } as const;
        }
        throw error;
      }
    },

    async updateGroup(id: string, input: UpdateVolunteerGroupInput) {
      const row = await p.volunteerGroup.update({
        where: { id },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.description !== undefined && {
            description: input.description,
          }),
          ...(input.capacity !== undefined && { capacity: input.capacity }),
        },
        select: GROUP_SELECT,
      });
      return mapGroup(row);
    },

    async getGroup(id: string) {
      const row = await p.volunteerGroup.findUnique({
        where: { id },
        select: GROUP_SELECT,
      });
      return row ? mapGroup(row) : null;
    },

    async listGroupsByAsk(askId: string) {
      const rows = await p.volunteerGroup.findMany({
        where: { askId },
        orderBy: { createdAt: "asc" },
        select: {
          ...GROUP_SELECT,
          // Accepted members only — matches the fill-count semantics of
          // countAcceptedByRole (PENDING never occupies a roster seat).
          _count: {
            select: {
              members: {
                where: { status: { in: [...ACCEPTED_SIGNUP_STATUSES] } },
              },
            },
          },
          // Name only — never the linked AuthUser's email (see
          // VolunteerGroupCoordinatorInfo).
          coordinator: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      });
      return rows.map(
        (row): VolunteerGroupWithRosterInfoRecord => ({
          ...mapGroup(row),
          memberCount: row._count.members,
          coordinator: row.coordinator
            ? {
                humanId: row.coordinator.id,
                name: row.coordinator.name ?? null,
              }
            : null,
        }),
      );
    },

    async setGroupCoordinator(
      groupId: string,
      coordinatorHumanId: string | null,
    ) {
      const row = await p.volunteerGroup.update({
        where: { id: groupId },
        data: { coordinatorHumanId },
        select: GROUP_SELECT,
      });
      return mapGroup(row);
    },

    async setGroupCoordinatorIfCurrent(
      groupId: string,
      expected: string | null,
      next: string | null,
    ) {
      // updateMany re-evaluates the WHERE after waiting on a concurrent
      // writer's row lock, so the loser of a race matches 0 rows.
      const { count } = await p.volunteerGroup.updateMany({
        where: { id: groupId, coordinatorHumanId: expected },
        data: { coordinatorHumanId: next },
      });
      if (count === 0) return null;
      const row = await p.volunteerGroup.findUnique({
        where: { id: groupId },
        select: GROUP_SELECT,
      });
      return row ? mapGroup(row) : null;
    },

    async deleteGroup(id: string) {
      // Members fall back to the general pool via the FK's SetNull.
      await p.volunteerGroup.delete({ where: { id } });
    },

    // ── Volunteer packs ───────────────────────────────────────────────
    //
    // PLATFORM-ONLY, all of it. Packs are catalogue metadata; nothing here
    // can reach an org's rows. Reads that organizers can trigger go through
    // `listLivePacksWithRoles` (LIVE-only); the status-blind reads below are
    // STAFF-only by contract and their callers gate on STAFF_TECH.

    async createPack(input: CreateVolunteerPackInput) {
      try {
        const row = await p.volunteerPack.create({
          data: {
            key: input.key,
            name: input.name,
            blurb: input.blurb ?? null,
            ...(input.status !== undefined && { status: input.status }),
            targetCategoryIds: input.targetCategoryIds ?? [],
            rankFirst: input.rankFirst ?? false,
            sortOrder: input.sortOrder ?? 0,
            curatedByHumanId: input.curatedByHumanId ?? null,
          },
          select: VOLUNTEER_PACK_SELECT,
        });
        return mapPack(row);
      } catch (error) {
        // P2002 on create can only be `VolunteerPack_key_key` — `id` is a
        // fresh uuid and the model has no other unique. The upsert use case
        // pre-reads by key, so this is the race loser; map it to the domain
        // code. `fail()` rather than a bare object literal: an `AppError` is
        // a real `Error`, so Sentry gets a stack and the Prisma error rides
        // along as `cause`.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          throw fail("VOLUNTEER_PACK_KEY_TAKEN", { cause: error });
        }
        throw error;
      }
    },

    async updatePack(id: string, input: UpdateVolunteerPackInput) {
      const row = await p.volunteerPack.update({
        where: { id },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.blurb !== undefined && { blurb: input.blurb }),
          ...(input.status !== undefined && { status: input.status }),
          ...(input.targetCategoryIds !== undefined && {
            targetCategoryIds: input.targetCategoryIds,
          }),
          ...(input.rankFirst !== undefined && { rankFirst: input.rankFirst }),
          ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
          ...(input.curatedByHumanId !== undefined && {
            curatedByHumanId: input.curatedByHumanId,
          }),
        },
        select: VOLUNTEER_PACK_SELECT,
      });
      return mapPack(row);
    },

    async getPack(id: string) {
      const row = await p.volunteerPack.findUnique({
        where: { id },
        select: VOLUNTEER_PACK_SELECT,
      });
      return row ? mapPack(row) : null;
    },

    async getPackByKey(key: string) {
      const row = await p.volunteerPack.findUnique({
        where: { key },
        select: VOLUNTEER_PACK_SELECT,
      });
      return row ? mapPack(row) : null;
    },

    /**
     * STATUS-BLIND by default — the staff catalogue list. Organizer-facing
     * callers must pass `status: "LIVE"`.
     *
     * The two counts come from grouped aggregates over the SAME `packId`
     * column, split on `isPlatform`: catalogue rows the pack owns vs
     * org-owned forks descended from it. Three queries total regardless of
     * pack count — no N+1.
     */
    async listPacks(opts?: { status?: VolunteerPackStatus }) {
      const rows = await p.volunteerPack.findMany({
        where: { ...(opts?.status ? { status: opts.status } : {}) },
        orderBy: [
          { rankFirst: "desc" },
          { sortOrder: "asc" },
          { name: "asc" },
        ],
        select: VOLUNTEER_PACK_SELECT,
      });
      if (rows.length === 0) return [];

      const packIds = rows.map((row) => row.id);
      const [platformCounts, forkCounts] = await Promise.all([
        p.volunteerRoleTemplate.groupBy({
          by: ["packId"],
          where: { packId: { in: packIds }, isPlatform: true },
          _count: { _all: true },
        }),
        p.volunteerRoleTemplate.groupBy({
          by: ["packId"],
          where: { packId: { in: packIds }, isPlatform: false },
          _count: { _all: true },
        }),
      ]);

      const byPack = (
        groups: Array<{ packId: string | null; _count: { _all: number } }>,
      ): Map<string, number> => {
        const map = new Map<string, number>();
        for (const group of groups) {
          if (group.packId) map.set(group.packId, group._count._all);
        }
        return map;
      };
      const platformByPack = byPack(platformCounts);
      const forkByPack = byPack(forkCounts);

      return rows.map(
        (row): VolunteerPackWithCountsRecord => ({
          ...mapPack(row),
          roleCount: platformByPack.get(row.id) ?? 0,
          forkCount: forkByPack.get(row.id) ?? 0,
        }),
      );
    },

    /**
     * Pack row ONLY. Its catalogue roles must already be deleted — the
     * `VolunteerRoleTemplate_platform_pack_check` CHECK turns the FK's
     * SET NULL of a surviving platform row into a violation, so this raises
     * instead of orphaning them. Org-owned forks SET NULL and survive.
     */
    async deletePack(id: string) {
      await p.volunteerPack.delete({ where: { id } });
    },

    /** LIVE ONLY — the organizer picker read. DRAFT packs cannot come back. */
    async listLivePacksWithRoles() {
      const rows = await p.volunteerPack.findMany({
        where: { status: "LIVE" },
        orderBy: [
          { rankFirst: "desc" },
          { sortOrder: "asc" },
          { name: "asc" },
        ],
        select: {
          ...VOLUNTEER_PACK_SELECT,
          roles: {
            // Catalogue rows only: an org's fork carries the same `packId`
            // as provenance and must never surface in another org's picker.
            where: { isPlatform: true, archived: false },
            orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
            select: {
              ...ROLE_TEMPLATE_SELECT,
              shifts: {
                orderBy: [{ position: "asc" }, { createdAt: "asc" }],
                select: ROLE_TEMPLATE_SHIFT_SELECT,
              },
            },
          },
        },
      });
      return rows.map(mapPackWithRoles);
    },

    /**
     * STATUS-BLIND single-pack read — the staff preview (FR-016). Authorizes
     * on STAFF_TECH in the use case, never on pack status. Do NOT reuse this
     * from an organizer-facing path.
     */
    async getPackWithRoles(id: string) {
      const row = await p.volunteerPack.findUnique({
        where: { id },
        select: {
          ...VOLUNTEER_PACK_SELECT,
          roles: {
            where: { isPlatform: true },
            orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
            select: {
              ...ROLE_TEMPLATE_SELECT,
              shifts: {
                orderBy: [{ position: "asc" }, { createdAt: "asc" }],
                select: ROLE_TEMPLATE_SHIFT_SELECT,
              },
            },
          },
        },
      });
      return row ? mapPackWithRoles(row) : null;
    },

    // ── Platform (catalogue) role templates ───────────────────────────

    /** PLATFORM-ONLY write: `orgId` NULL + `isPlatform` true, both fixed here. */
    async createPlatformRoleTemplate(input: CreatePlatformRoleTemplateInput) {
      try {
        const row = await p.volunteerRoleTemplate.create({
          data: {
            orgId: null,
            isPlatform: true,
            packId: input.packId,
            name: input.name,
            description: input.description ?? null,
            defaultCapacity: input.defaultCapacity ?? null,
            sortOrder: input.sortOrder ?? 0,
          },
          select: ROLE_TEMPLATE_SELECT,
        });
        return mapTemplate(row);
      } catch (error) {
        // P2002 here can only be the partial unique
        // `VolunteerRoleTemplate_platform_pack_name_key`: two staff upserting
        // the same pack concurrently, both adding "Door". `upsertVolunteerPack`
        // reconciles by name against a read taken earlier in the transaction,
        // so the loser lands here. Untranslated it surfaced as an opaque 500;
        // TEMPLATE_NAME_TAKEN is the code the org-side name collision already
        // uses and maps to CONFLICT.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          throw fail("TEMPLATE_NAME_TAKEN", { cause: error });
        }
        throw error;
      }
    },

    /**
     * PLATFORM-ONLY delete. `isPlatform: true` is pinned in the where clause,
     * so an org row's id passed here is a no-op rather than data loss.
     */
    async deletePlatformRoleTemplates(ids: string[]) {
      if (ids.length === 0) return 0;
      const result = await p.volunteerRoleTemplate.deleteMany({
        where: { id: { in: ids }, isPlatform: true },
      });
      return result.count;
    },

    /**
     * PLATFORM-ONLY delete scoped to one pack. Org-owned forks carry the same
     * `packId` and are excluded by `isPlatform: false` — they survive the
     * pack and keep the provenance until the FK's SET NULL clears it.
     */
    async deletePlatformRoleTemplatesByPack(packId: string) {
      const result = await p.volunteerRoleTemplate.deleteMany({
        where: { packId, isPlatform: true },
      });
      return result.count;
    },

    async countPlatformRoleTemplatesByPack(packId: string) {
      return p.volunteerRoleTemplate.count({
        where: { packId, isPlatform: true },
      });
    },

    // ── Role templates ────────────────────────────────────────────────
    //
    // Tenancy note: this table holds ORG rows (orgId set, isPlatform false)
    // and PLATFORM catalogue rows (orgId NULL, isPlatform true). Each query
    // below states which it means; `orgId` being nullable makes "not org
    // B's" a different test from "not null".

    /** ORG-ONLY write. `orgId` is required, `isPlatform` is not settable. */
    async createRoleTemplate(input: CreateRoleTemplateInput) {
      try {
        const row = await p.volunteerRoleTemplate.create({
          data: {
            orgId: input.orgId,
            name: input.name,
            description: input.description ?? null,
            defaultCapacity: input.defaultCapacity ?? null,
            sortOrder: input.sortOrder ?? 0,
            packId: input.packId ?? null,
          },
          select: ROLE_TEMPLATE_SELECT,
        });
        return mapTemplate(row);
      } catch (error) {
        // P2002 here can only be `@@unique([orgId, name])`: the id is a fresh
        // uuid, and the partial catalogue index is `WHERE "orgId" IS NULL`
        // while this write always carries an orgId. So the mapping is precise.
        //
        // It is reachable by a RACE, not by ordinary use. Both writers through
        // this method (`createRoleTemplate` and the "Customise" fork) precheck
        // the name inside their transaction, so the loser of "org admin A forks
        // catalogue 'Door' while admin B saves a hand-made 'Door' in another
        // tab" gets here with both prechecks passed. Untranslated, that raw
        // PrismaClientKnownRequestError escaped as an opaque 500 instead of the
        // TEMPLATE_NAME_TAKEN / CONFLICT the UI already recovers from with its
        // rename dialog. Mirrors `createPlatformRoleTemplate` above.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          throw fail("TEMPLATE_NAME_TAKEN", { cause: error });
        }
        throw error;
      }
    },

    /**
     * ID-SCOPED write, no tenancy filter — the caller has already proven the
     * row is org-owned and theirs (mutating use cases reject `isPlatform`
     * rows before any membership check). Never call this with an unvalidated
     * id.
     */
    async updateRoleTemplate(id: string, input: UpdateRoleTemplateInput) {
      const row = await p.volunteerRoleTemplate.update({
        where: { id },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.description !== undefined && {
            description: input.description,
          }),
          ...(input.defaultCapacity !== undefined && {
            defaultCapacity: input.defaultCapacity,
          }),
          ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
        },
        select: ROLE_TEMPLATE_SELECT,
      });
      return mapTemplate(row);
    },

    /** ID-SCOPED write — same contract as `updateRoleTemplate` above. */
    async archiveRoleTemplate(id: string) {
      await p.volunteerRoleTemplate.update({
        where: { id },
        data: { archived: true },
      });
    },

    /**
     * ORG-ONLY by default; BOTH when `includePlatform` is set.
     *
     * The org branch is a plain `orgId` equality, which platform rows can
     * never satisfy (their orgId is NULL) — deliberately NOT also filtering
     * `isPlatform: false`, so this stays exactly aligned with the
     * `@@unique([orgId, name])` the name-collision prechecks are testing
     * against.
     *
     * The platform branch requires a LIVE pack, so a DRAFT pack's roles are
     * unreachable from every organizer-facing path. One query, no N+1
     * (NFR-003).
     */
    async listRoleTemplates(
      orgId: string,
      opts?: { includeArchived?: boolean; includePlatform?: boolean },
    ) {
      const rows = await p.volunteerRoleTemplate.findMany({
        where: {
          ...(opts?.includeArchived ? {} : { archived: false }),
          ...(opts?.includePlatform
            ? { OR: [{ orgId }, LIVE_PLATFORM_TEMPLATE_WHERE] }
            : { orgId }),
        },
        // Org rows first, then catalogue rows, each in curation order —
        // deterministic across the union.
        orderBy: [
          { isPlatform: "asc" },
          { sortOrder: "asc" },
          { name: "asc" },
        ],
        select: ROLE_TEMPLATE_SELECT,
      });
      return rows.map(mapTemplate);
    },

    /**
     * ID-SCOPED read with NO tenancy filter — returns platform rows and any
     * org's rows alike. Callers must apply their own rule; prefer
     * `getRoleTemplateUsableBy` for anything org-scoped.
     */
    async getRoleTemplate(id: string) {
      const row = await p.volunteerRoleTemplate.findUnique({
        where: { id },
        select: ROLE_TEMPLATE_SELECT,
      });
      return row ? mapTemplate(row) : null;
    },

    /**
     * BOTH, tenancy-filtered: the org's own row OR a LIVE catalogue row.
     * A different org's row and a DRAFT pack's role both return null, so the
     * caller's 404 never confirms the row exists. `orgId: null` (an ask with
     * no owning org) narrows to LIVE catalogue rows only — it must never
     * degrade to "any row".
     */
    async getRoleTemplateUsableBy(id: string, orgId: string | null) {
      const row = await p.volunteerRoleTemplate.findFirst({
        where: {
          id,
          OR:
            orgId === null
              ? [LIVE_PLATFORM_TEMPLATE_WHERE]
              : [{ orgId }, LIVE_PLATFORM_TEMPLATE_WHERE],
        },
        select: ROLE_TEMPLATE_SELECT,
      });
      return row ? mapTemplate(row) : null;
    },

    // ── Role-template shift presets ──────────────────────────────────────
    //
    // Shifts carry no tenancy of their own: they are TEMPLATE-SCOPED and
    // serve org and platform templates alike (there is no second shift
    // model). Whoever resolved the template id owns the tenancy decision;
    // these methods never widen it.

    async upsertRoleTemplateShifts(
      templateId: string,
      shifts: RoleTemplateShiftDraft[],
    ) {
      // Replace-set semantics: simpler than per-row diffing and matches
      // what the template editor wants (users reorder/add/delete freely
      // in one session). Atomicity is the caller's responsibility — wrap
      // in `repos.tx()` if you can't tolerate a brief half-empty state.
      await p.volunteerRoleTemplateShift.deleteMany({
        where: { templateId },
      });

      if (shifts.length === 0) {
        return [];
      }

      await p.volunteerRoleTemplateShift.createMany({
        data: shifts.map((shift, index) => ({
          templateId,
          label: shift.label,
          startMinuteOfDay: shift.startMinuteOfDay,
          endMinuteOfDay: shift.endMinuteOfDay,
          startDayOffset: shift.startDayOffset ?? 0,
          endsNextDay: shift.endsNextDay ?? false,
          capacity: shift.capacity ?? null,
          position: shift.position ?? index,
          // Defaults reproduce the pre-anchor behaviour exactly: a draft
          // that omits these is a wall-clock preset, as every existing row
          // is.
          anchor: shift.anchor ?? "WALL_CLOCK",
          offsetMinutes: shift.offsetMinutes ?? 0,
          notes: shift.notes ?? null,
        })),
      });

      const rows = await p.volunteerRoleTemplateShift.findMany({
        where: { templateId },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
        select: ROLE_TEMPLATE_SHIFT_SELECT,
      });
      return rows.map(mapTemplateShift);
    },

    async listRoleTemplateShifts(templateId: string) {
      const rows = await p.volunteerRoleTemplateShift.findMany({
        where: { templateId },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
        select: ROLE_TEMPLATE_SHIFT_SELECT,
      });
      return rows.map(mapTemplateShift);
    },

    /**
     * ID-SCOPED read with no tenancy filter (same contract as
     * `getRoleTemplate`) — returns platform rows too. The organizer-facing
     * caller rejects them; the staff preview path will want them.
     */
    async getRoleTemplateWithShifts(id: string) {
      const row = await p.volunteerRoleTemplate.findUnique({
        where: { id },
        select: {
          ...ROLE_TEMPLATE_SELECT,
          shifts: {
            orderBy: [{ position: "asc" }, { createdAt: "asc" }],
            select: ROLE_TEMPLATE_SHIFT_SELECT,
          },
        },
      });
      if (!row) return null;
      const result: RoleTemplateWithShiftsRecord = {
        ...mapTemplate(row),
        shifts: (row.shifts ?? []).map(mapTemplateShift),
      };
      return result;
    },

    async listRoleTemplateShiftsByTemplateIds(templateIds: string[]) {
      if (templateIds.length === 0) return {};
      const rows = await p.volunteerRoleTemplateShift.findMany({
        where: { templateId: { in: templateIds } },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
        select: ROLE_TEMPLATE_SHIFT_SELECT,
      });

      const byTemplate: Record<string, RoleTemplateShiftRecord[]> = {};
      for (const row of rows) {
        const mapped = mapTemplateShift(row);
        if (!byTemplate[mapped.templateId]) {
          byTemplate[mapped.templateId] = [];
        }
        byTemplate[mapped.templateId]!.push(mapped);
      }
      return byTemplate;
    },

    // ── Event volunteer roles ─────────────────────────────────────────

    async createEventRole(input: CreateEventVolunteerRoleInput) {
      try {
        const row = await p.eventVolunteerRole.create({
          data: {
            // Exactly one of eventId/askId — validated in core, carried here.
            eventId: input.eventId ?? null,
            askId: input.askId ?? null,
            templateId: input.templateId ?? null,
            name: input.name,
            description: input.description ?? null,
            capacity: input.capacity ?? null,
            autoApprove: input.autoApprove ?? null,
            defaultHours: input.defaultHours ?? null,
            sortOrder: input.sortOrder ?? 0,
          },
          select: EVENT_ROLE_SELECT,
        });
        return mapRole(row);
      } catch (error) {
        // P2002 here means a duplicate role name within the owner —
        // `@@unique([eventId, name])` (legacy event roles) or
        // `@@unique([askId, name])` (ask-owned roles). One domain code
        // covers both since exactly one owner is set per row (same
        // convention as createAsk above).
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          throw {
            code: "duplicate_role_name",
            message: "duplicate_role_name",
            cause: error,
          } as const;
        }
        throw error;
      }
    },

    async updateEventRole(id: string, input: UpdateEventVolunteerRoleInput) {
      const row = await p.eventVolunteerRole.update({
        where: { id },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.description !== undefined && {
            description: input.description,
          }),
          ...(input.capacity !== undefined && { capacity: input.capacity }),
          ...(input.autoApprove !== undefined && {
            autoApprove: input.autoApprove,
          }),
          ...(input.defaultHours !== undefined && {
            defaultHours: input.defaultHours,
          }),
          ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
        },
        select: EVENT_ROLE_SELECT,
      });
      return mapRole(row);
    },

    async deleteEventRole(id: string) {
      await p.eventVolunteerRole.delete({ where: { id } });
    },

    async listEventRoles(eventId: string) {
      const rows = await p.eventVolunteerRole.findMany({
        where: { eventId },
        orderBy: { sortOrder: "asc" },
        select: {
          ...EVENT_ROLE_SELECT,
          shifts: { select: SHIFT_SELECT, orderBy: { sortOrder: "asc" } },
        },
      });
      return rows.map(mapRoleWithShifts);
    },

    async listRolesByAsk(askId: string) {
      const rows = await p.eventVolunteerRole.findMany({
        where: { askId },
        orderBy: { sortOrder: "asc" },
        select: {
          ...EVENT_ROLE_SELECT,
          // Ask-owned roles never carry shifts (v1 scheduling is the ask's
          // window only), but backfilled EVENT-ask roles do — keep the
          // shape identical to listEventRoles.
          shifts: { select: SHIFT_SELECT, orderBy: { sortOrder: "asc" } },
        },
      });
      return rows.map(mapRoleWithShifts);
    },

    async getEventRole(id: string) {
      const row = await p.eventVolunteerRole.findUnique({
        where: { id },
        select: {
          ...EVENT_ROLE_SELECT,
          shifts: { select: SHIFT_SELECT, orderBy: { sortOrder: "asc" } },
        },
      });
      return row ? mapRoleWithShifts(row) : null;
    },

    // ── Shifts ────────────────────────────────────────────────────────

    async createShift(input: CreateVolunteerShiftInput) {
      const row = await p.eventVolunteerShift.create({
        data: {
          roleId: input.roleId,
          label: input.label ?? null,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          capacity: input.capacity ?? null,
          notes: input.notes ?? null,
          sortOrder: input.sortOrder ?? 0,
        },
        select: SHIFT_SELECT,
      });
      return mapShift(row);
    },

    async getShift(id: string) {
      const row = await p.eventVolunteerShift.findUnique({
        where: { id },
        select: SHIFT_SELECT,
      });
      return row ? mapShift(row) : null;
    },

    async updateShift(id: string, input: UpdateVolunteerShiftInput) {
      const row = await p.eventVolunteerShift.update({
        where: { id },
        data: {
          ...(input.label !== undefined && { label: input.label }),
          ...(input.startsAt !== undefined && { startsAt: input.startsAt }),
          ...(input.endsAt !== undefined && { endsAt: input.endsAt }),
          ...(input.capacity !== undefined && { capacity: input.capacity }),
          ...(input.notes !== undefined && { notes: input.notes }),
          ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
        },
        select: SHIFT_SELECT,
      });
      return mapShift(row);
    },

    async deleteShift(id: string) {
      await p.eventVolunteerShift.delete({ where: { id } });
    },

    async listShifts(roleId: string) {
      const rows = await p.eventVolunteerShift.findMany({
        where: { roleId },
        orderBy: { sortOrder: "asc" },
        select: SHIFT_SELECT,
      });
      return rows.map(mapShift);
    },

    // ── Signups ───────────────────────────────────────────────────────

    async createSignup(input: CreateVolunteerSignupInput) {
      const row = await p.volunteerSignup.create({
        data: {
          eventId: input.eventId ?? null,
          askId: input.askId ?? null,
          roleId: input.roleId,
          shiftId: input.shiftId ?? null,
          groupId: input.groupId ?? null,
          humanId: input.humanId ?? null,
          contactEmail: input.contactEmail,
          contactName: input.contactName ?? null,
          contactPhone: input.contactPhone ?? null,
          smsOptIn: input.smsOptIn === true,
          status: input.status ?? "PENDING",
          answers: (input.answers as any) ?? {},
          metadata: (input.metadata as any) ?? {},
        },
        select: SIGNUP_SELECT,
      });
      return mapSignup(row);
    },

    async updateSignupStatus(
      id: string,
      input: UpdateVolunteerSignupStatusInput,
    ) {
      const row = await p.volunteerSignup.update({
        where: { id },
        data: {
          status: input.status,
          ...(input.reviewerHumanId !== undefined && {
            reviewerHumanId: input.reviewerHumanId,
          }),
          ...(input.reviewedAt !== undefined && {
            reviewedAt: input.reviewedAt,
          }),
          ...(input.checkedInAt !== undefined && {
            checkedInAt: input.checkedInAt,
          }),
          ...(input.notes !== undefined && { notes: input.notes }),
        },
        select: SIGNUP_SELECT,
      });
      return mapSignup(row);
    },

    async updateSignupContactPrefs(
      id: string,
      input: { smsOptIn: boolean; contactPhone?: string },
    ) {
      const row = await p.volunteerSignup.update({
        where: { id },
        data: {
          smsOptIn: input.smsOptIn,
          ...(input.contactPhone !== undefined && {
            contactPhone: input.contactPhone,
          }),
        },
        select: SIGNUP_SELECT,
      });
      return mapSignup(row);
    },

    async getSignup(id: string) {
      const row = await p.volunteerSignup.findUnique({
        where: { id },
        select: SIGNUP_SELECT,
      });
      return row ? mapSignup(row) : null;
    },

    async getSignupByEmail(key) {
      const row = await p.volunteerSignup.findUnique({
        where:
          "askId" in key
            ? {
                askId_roleId_contactEmail: {
                  askId: key.askId,
                  roleId: key.roleId,
                  contactEmail: key.contactEmail,
                },
              }
            : {
                eventId_roleId_contactEmail: {
                  eventId: key.eventId,
                  roleId: key.roleId,
                  contactEmail: key.contactEmail,
                },
              },
        select: SIGNUP_SELECT,
      });
      return row ? mapSignup(row) : null;
    },

    async listSignups(eventId: string, opts?: ListVolunteerSignupsOpts) {
      return listSignupsWhere(p, { eventId }, opts);
    },

    async listSignupsByAsk(askId: string, opts?: ListVolunteerSignupsOpts) {
      return listSignupsWhere(p, { askId }, opts);
    },

    async listSignupsByAskCursor(
      askId: string,
      opts?: ListVolunteerSignupsCursorOpts,
    ) {
      return listSignupsCursorWhere(p, { askId }, opts);
    },

    async assignSignupToGroup(signupId: string, groupId: string | null) {
      const row = await p.volunteerSignup.update({
        where: { id: signupId },
        data: { groupId },
        select: SIGNUP_SELECT,
      });
      return mapSignup(row);
    },

    async listSignupsByHuman(humanId: string) {
      const rows = await p.volunteerSignup.findMany({
        where: { humanId },
        orderBy: { createdAt: "desc" },
        select: SIGNUP_SELECT,
      });
      return rows.map(mapSignup);
    },

    async clearSmsOptInByPhone(phoneE164: string) {
      const res = await p.volunteerSignup.updateMany({
        where: { contactPhone: phoneE164, smsOptIn: true },
        data: { smsOptIn: false },
      });
      return res.count;
    },

    async countByRole(eventId: string) {
      return countSignupsByRole(p, {
        eventId,
        status: { in: [...ACTIVE_SIGNUP_STATUSES] },
      });
    },

    async countByShift(roleId: string) {
      return countSignupsByShift(p, {
        roleId,
        status: { in: [...ACTIVE_SIGNUP_STATUSES] },
      });
    },

    async countByShiftForEvent(eventId: string) {
      return countSignupsByShift(p, {
        eventId,
        status: { in: [...ACTIVE_SIGNUP_STATUSES] },
      });
    },

    async countAcceptedOccupancy(target) {
      // Lock the parent row first so concurrent approvals serialize on the
      // same shift/role — the lock is held until the surrounding interactive
      // transaction commits, so the count below can't be invalidated by a
      // racing approve. Tables have no @@map, so the quoted model names are
      // the physical table names.
      if ("shiftId" in target) {
        await p.$queryRaw`SELECT id FROM "EventVolunteerShift" WHERE id = ${target.shiftId} FOR UPDATE`;
        return p.volunteerSignup.count({
          where: {
            shiftId: target.shiftId,
            status: { in: [...ACCEPTED_SIGNUP_STATUSES] },
          },
        });
      }
      await p.$queryRaw`SELECT id FROM "EventVolunteerRole" WHERE id = ${target.roleId} FOR UPDATE`;
      // Role capacity caps the whole role, so shifted signups count too —
      // no shiftId filter here.
      return p.volunteerSignup.count({
        where: {
          roleId: target.roleId,
          status: { in: [...ACCEPTED_SIGNUP_STATUSES] },
        },
      });
    },

    async countPendingSignups(target) {
      // Informational read for the spot-opened notification — no FOR UPDATE
      // lock, unlike countAcceptedOccupancy: nothing downstream gates on
      // this number, so a racing approve/withdraw at worst skews the count
      // in an advisory email.
      if ("shiftId" in target) {
        return p.volunteerSignup.count({
          where: { shiftId: target.shiftId, status: "PENDING" },
        });
      }
      // Role-level mirrors countAcceptedOccupancy's role branch: shifted
      // pending signups count too — any of them could claim a freed
      // shiftless seat on the role.
      return p.volunteerSignup.count({
        where: { roleId: target.roleId, status: "PENDING" },
      });
    },

    async countAcceptedByRole(eventId: string) {
      return countSignupsByRole(p, {
        eventId,
        status: { in: [...ACCEPTED_SIGNUP_STATUSES] },
      });
    },

    async countAcceptedByShiftForEvent(eventId: string) {
      return countSignupsByShift(p, {
        eventId,
        status: { in: [...ACCEPTED_SIGNUP_STATUSES] },
      });
    },

    async countByEventsAndStatus(eventIds: string[]) {
      if (eventIds.length === 0) return {};
      const groups = await p.volunteerSignup.groupBy({
        by: ["eventId", "status"],
        where: { eventId: { in: eventIds } },
        _count: true,
      });
      const result: Record<string, Partial<Record<string, number>>> = {};
      for (const g of groups) {
        if (!g.eventId) continue;
        const bucket = result[g.eventId] ?? {};
        bucket[g.status] = g._count;
        result[g.eventId] = bucket;
      }
      return result as Record<
        string,
        Partial<Record<import("@th/types").VolunteerSignupStatus, number>>
      >;
    },

    // ── Shift occurrences + claims (standing asks, phase A) ───────────

    async createOccurrence(input: CreateVolunteerShiftOccurrenceInput) {
      const row = await p.volunteerShiftOccurrence.create({
        data: {
          askId: input.askId,
          roleId: input.roleId,
          patternId: input.patternId ?? null,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          capacity: input.capacity ?? null,
          notes: input.notes ?? null,
        },
        select: OCCURRENCE_SELECT,
      });
      return mapOccurrence(row);
    },

    async getOccurrence(id: string) {
      const row = await p.volunteerShiftOccurrence.findUnique({
        where: { id },
        select: OCCURRENCE_SELECT,
      });
      return row ? mapOccurrence(row) : null;
    },

    async getOccurrenceForUpdate(id: string) {
      // Lock first (blocks behind any concurrent cancel/edit/claim holding
      // the row), THEN re-read: the second read observes whatever the lock
      // holder committed, so the returned status/capacity are never stale.
      // No @@map, so the quoted model name is the physical table name.
      await p.$queryRaw`SELECT id FROM "VolunteerShiftOccurrence" WHERE id = ${id} FOR UPDATE`;
      const row = await p.volunteerShiftOccurrence.findUnique({
        where: { id },
        select: OCCURRENCE_SELECT,
      });
      return row ? mapOccurrence(row) : null;
    },

    async updateOccurrence(
      id: string,
      input: UpdateVolunteerShiftOccurrenceInput,
    ) {
      const row = await p.volunteerShiftOccurrence.update({
        where: { id },
        data: {
          ...(input.startsAt !== undefined && { startsAt: input.startsAt }),
          ...(input.endsAt !== undefined && { endsAt: input.endsAt }),
          ...(input.capacity !== undefined && { capacity: input.capacity }),
          ...(input.notes !== undefined && { notes: input.notes }),
          ...(input.status !== undefined && { status: input.status }),
        },
        select: OCCURRENCE_SELECT,
      });
      return mapOccurrence(row);
    },

    async listOccurrencesByAsk(
      askId: string,
      opts?: ListVolunteerOccurrencesOpts,
    ) {
      const rows = await p.volunteerShiftOccurrence.findMany({
        where: {
          askId,
          ...(opts?.roleId && { roleId: opts.roleId }),
          ...(opts?.status && { status: opts.status }),
          ...((opts?.from || opts?.to) && {
            startsAt: {
              ...(opts.from && { gte: opts.from }),
              ...(opts.to && { lt: opts.to }),
            },
          }),
        },
        orderBy: [{ startsAt: "asc" }, { id: "asc" }],
        ...(opts?.limit != null && { take: opts.limit }),
        select: {
          ...OCCURRENCE_SELECT,
          // Active-claim count joined in the same query set (no N+1) —
          // powers the public open-slot math and the owner schedule tab.
          _count: {
            select: { claims: { where: { status: "CLAIMED" } } },
          },
        },
      });
      return rows.map((row) => ({
        ...mapOccurrence(row),
        claimedCount: row._count.claims,
      }));
    },

    async countActiveOccurrenceClaims(occurrenceId: string) {
      // Lock the occurrence row first so concurrent claims serialize — the
      // lock is held until the surrounding interactive transaction commits,
      // so the count below can't be invalidated by a racing claim (mirrors
      // countAcceptedOccupancy). No @@map, so the quoted model name is the
      // physical table name.
      await p.$queryRaw`SELECT id FROM "VolunteerShiftOccurrence" WHERE id = ${occurrenceId} FOR UPDATE`;
      return p.volunteerOccurrenceClaim.count({
        where: { occurrenceId, status: "CLAIMED" },
      });
    },

    async createOccurrenceClaim(input: CreateVolunteerOccurrenceClaimInput) {
      try {
        const row = await p.volunteerOccurrenceClaim.create({
          data: {
            occurrenceId: input.occurrenceId,
            signupId: input.signupId,
            status: input.status ?? "CLAIMED",
            source: input.source ?? "SELF",
          },
          select: OCCURRENCE_CLAIM_SELECT,
        });
        return mapOccurrenceClaim(row);
      } catch (error) {
        // P2002 can only come from @@unique([occurrenceId, signupId]) —
        // map the race loser to the domain code (same convention as
        // duplicate_event_ask). Callers inside an interactive tx must treat
        // this as a full-tx failure (25P02) the client retries.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          throw {
            code: "duplicate_claim",
            message: "duplicate_claim",
            cause: error,
          } as const;
        }
        throw error;
      }
    },

    async getOccurrenceClaim(id: string) {
      const row = await p.volunteerOccurrenceClaim.findUnique({
        where: { id },
        select: OCCURRENCE_CLAIM_SELECT,
      });
      return row ? mapOccurrenceClaim(row) : null;
    },

    async getClaimByOccurrenceAndSignup(
      occurrenceId: string,
      signupId: string,
    ) {
      const row = await p.volunteerOccurrenceClaim.findUnique({
        where: { occurrenceId_signupId: { occurrenceId, signupId } },
        select: OCCURRENCE_CLAIM_SELECT,
      });
      return row ? mapOccurrenceClaim(row) : null;
    },

    async updateOccurrenceClaim(
      id: string,
      input: UpdateVolunteerOccurrenceClaimInput,
    ) {
      const row = await p.volunteerOccurrenceClaim.update({
        where: { id },
        data: {
          ...(input.status !== undefined && { status: input.status }),
          ...(input.source !== undefined && { source: input.source }),
          ...(input.checkedInAt !== undefined && {
            checkedInAt: input.checkedInAt,
          }),
          ...(input.hoursWorked !== undefined && {
            hoursWorked: input.hoursWorked,
          }),
        },
        select: OCCURRENCE_CLAIM_SELECT,
      });
      return mapOccurrenceClaim(row);
    },

    async listClaimsByOccurrence(occurrenceId: string) {
      const rows = await p.volunteerOccurrenceClaim.findMany({
        where: { occurrenceId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          ...OCCURRENCE_CLAIM_SELECT,
          // Roster identity only — deliberately NOT the full signup select
          // (no answers, phone, review notes) per NFR-003.
          signup: {
            select: {
              contactEmail: true,
              contactName: true,
              humanId: true,
              groupId: true,
              roleId: true,
              status: true,
            },
          },
        },
      });
      return rows.map(
        (row): VolunteerOccurrenceClaimRosterRow => ({
          ...mapOccurrenceClaim(row),
          contactEmail: row.signup.contactEmail,
          contactName: row.signup.contactName ?? null,
          humanId: row.signup.humanId ?? null,
          groupId: row.signup.groupId ?? null,
          roleId: row.signup.roleId,
          signupStatus: row.signup.status,
        }),
      );
    },

    async withdrawFutureClaimsBySignup(signupId: string, from: Date) {
      const res = await p.volunteerOccurrenceClaim.updateMany({
        where: {
          signupId,
          status: "CLAIMED",
          occurrence: { startsAt: { gte: from } },
        },
        data: { status: "WITHDRAWN" },
      });
      return res.count;
    },

    // ── Shift reminders ───────────────────────────────────────────────

    async findShiftsNeedingReminder({ kind, windowStart, windowEnd }) {
      // Remind only for events that are still on (STILL_ON_EVENT_WHERE)
      // whose owner is not withheld (banned), via the same fragment the
      // public reads use. COMPLETED is excluded: usually past, and
      // completeEvent has no date check.
      const withheld = await resolveWithheldOwners(p);
      const rows = await p.volunteerSignup.findMany({
        where: {
          status: "APPROVED",
          shift: { startsAt: { gte: windowStart, lt: windowEnd } },
          event: withEventOwnerNotWithheld(STILL_ON_EVENT_WHERE, withheld),
        },
        select: {
          id: true,
          humanId: true,
          contactEmail: true,
          contactName: true,
          contactPhone: true,
          smsOptIn: true,
          event: {
            select: {
              id: true,
              title: true,
              slug: true,
              timezone: true,
              addressText: true,
            },
          },
          role: { select: { name: true } },
          shift: { select: { label: true, startsAt: true, endsAt: true } },
          notifications: {
            where: { kind },
            select: { channel: true },
          },
        },
      });

      return rows
        // Shift-bearing signups always belong to an event, so `event` can't
        // actually be null here — but the column is nullable now that asks
        // exist, so narrow for the type (same treatment as `shift` above,
        // which the where clause already guarantees).
        .filter((r) => r.shift && r.event)
        .map((r) => ({
          signupId: r.id,
          humanId: r.humanId ?? null,
          contactEmail: r.contactEmail,
          contactName: r.contactName ?? null,
          contactPhone: r.contactPhone ?? null,
          smsOptIn: r.smsOptIn ?? false,
          eventId: r.event!.id,
          eventTitle: r.event!.title,
          eventSlug: r.event!.slug ?? null,
          eventTimezone: r.event!.timezone ?? null,
          addressText: r.event!.addressText ?? null,
          roleName: r.role.name,
          shiftLabel: r.shift!.label ?? null,
          shiftStartsAt: r.shift!.startsAt,
          shiftEndsAt: r.shift!.endsAt,
          alreadySent: r.notifications.map(
            (n) => n.channel as import("@th/types").VolunteerReminderChannel,
          ),
        }));
    },

    async findEventIdsStillOn(eventIds) {
      if (eventIds.length === 0) return [];
      const withheld = await resolveWithheldOwners(p);
      const rows = await p.event.findMany({
        where: withEventOwnerNotWithheld(
          { ...STILL_ON_EVENT_WHERE, id: { in: eventIds } },
          withheld,
        ),
        select: { id: true },
      });
      return rows.map((r) => r.id);
    },

    async findEventStartReminderCandidates({ kind, windowStart, windowEnd }) {
      // A signup on an event role with NO shifts is reminded by the event's
      // own start (R7, `signupReminderAnchor`). A shiftless signup on a role
      // that has shifts (role-level, or its shift deleted: `shiftId` is SET
      // NULL) is not: its time is a shift, not the event's start. Same
      // still-on and withheld-owner gate as the shift read above.
      const withheld = await resolveWithheldOwners(p);
      const rows = await p.volunteerSignup.findMany({
        where: {
          status: "APPROVED",
          shiftId: null,
          role: { shifts: { none: {} } },
          event: withEventOwnerNotWithheld(
            {
              ...STILL_ON_EVENT_WHERE,
              startsAt: { gte: windowStart, lt: windowEnd },
            },
            withheld,
          ),
        },
        select: {
          id: true,
          humanId: true,
          contactEmail: true,
          contactName: true,
          contactPhone: true,
          smsOptIn: true,
          event: {
            select: {
              id: true,
              title: true,
              slug: true,
              timezone: true,
              addressText: true,
              startsAt: true,
              endsAt: true,
            },
          },
          role: { select: { name: true } },
          notifications: {
            where: { kind },
            select: { channel: true },
          },
        },
      });

      return rows
        // The where clause guarantees the event; narrow the nullable column.
        .filter((r) => r.event)
        .map((r) => ({
          signupId: r.id,
          humanId: r.humanId ?? null,
          contactEmail: r.contactEmail,
          contactName: r.contactName ?? null,
          contactPhone: r.contactPhone ?? null,
          smsOptIn: r.smsOptIn ?? false,
          eventId: r.event!.id,
          eventTitle: r.event!.title,
          eventSlug: r.event!.slug ?? null,
          eventTimezone: r.event!.timezone ?? null,
          addressText: r.event!.addressText ?? null,
          roleName: r.role.name,
          eventStartsAt: r.event!.startsAt,
          eventEndsAt: r.event!.endsAt,
          alreadySent: r.notifications.map(
            (n) => n.channel as import("@th/types").VolunteerReminderChannel,
          ),
        }));
    },

    async findAskStartReminderCandidates({ kind, windowStart, windowEnd }) {
      // Ask-path signups only (no event, no shift): an EVENT ask's event
      // signups are reminded through the event above.
      const withheld = await resolveWithheldOwners(p);
      const rows = await p.volunteerSignup.findMany({
        where: {
          status: "APPROVED",
          eventId: null,
          shiftId: null,
          ask: {
            AND: [
              askStillRemindableWhere(withheld),
              { startsAt: { gte: windowStart, lt: windowEnd } },
            ],
          },
        },
        select: {
          id: true,
          humanId: true,
          contactEmail: true,
          contactName: true,
          contactPhone: true,
          smsOptIn: true,
          ask: {
            select: {
              id: true,
              title: true,
              subjectType: true,
              subjectId: true,
              cadence: true,
              startsAt: true,
              endsAt: true,
              timezone: true,
            },
          },
          role: { select: { name: true } },
          notifications: {
            where: { kind },
            select: { channel: true },
          },
        },
      });
      const withAsk = rows.filter((r) => r.ask && r.ask.startsAt);

      // An ask saved before its zone was asked for renders in its place's
      // zone when it has one (PLACE asks); one batched read, only when needed.
      const placeIds = [
        ...new Set(
          withAsk
            .filter((r) => !r.ask!.timezone && r.ask!.subjectType === "PLACE")
            .map((r) => r.ask!.subjectId),
        ),
      ];
      const placeZones = new Map<string, string>();
      if (placeIds.length > 0) {
        const places = await p.place.findMany({
          where: { id: { in: placeIds } },
          select: { id: true, timezone: true },
        });
        for (const place of places) {
          if (place.timezone) placeZones.set(place.id, place.timezone);
        }
      }

      return withAsk.map((r) => {
        const ask = r.ask!;
        return {
          signupId: r.id,
          humanId: r.humanId ?? null,
          contactEmail: r.contactEmail,
          contactName: r.contactName ?? null,
          contactPhone: r.contactPhone ?? null,
          smsOptIn: r.smsOptIn ?? false,
          askId: ask.id,
          askTitle: ask.title,
          askSubjectType: ask.subjectType,
          askCadence: ask.cadence,
          askStartsAt: ask.startsAt!,
          askEndsAt: ask.endsAt ?? null,
          askTimezone:
            ask.timezone ??
            (ask.subjectType === "PLACE"
              ? (placeZones.get(ask.subjectId) ?? null)
              : null),
          roleName: r.role.name,
          alreadySent: r.notifications.map(
            (n) => n.channel as import("@th/types").VolunteerReminderChannel,
          ),
        };
      });
    },

    async findAskIdsStillRemindable(askIds) {
      if (askIds.length === 0) return [];
      const withheld = await resolveWithheldOwners(p);
      const rows = await p.volunteerAsk.findMany({
        where: {
          AND: [askStillRemindableWhere(withheld), { id: { in: askIds } }],
        },
        select: { id: true },
      });
      return rows.map((r) => r.id);
    },

    async recordShiftNotification({ signupId, kind, channel }) {
      // `createMany` with `skipDuplicates` does an atomic insert + ON
      // CONFLICT DO NOTHING under the hood. Returns the count of rows
      // actually inserted, so 1 = first send, 0 = already sent.
      const result = await p.volunteerShiftNotification.createMany({
        data: [{ signupId, kind, channel }],
        skipDuplicates: true,
      });
      return result.count === 1;
    },

    async deleteShiftNotification({ signupId, kind, channel }) {
      // `deleteMany` instead of `delete` so we don't throw if the row
      // doesn't exist (concurrent rollback, partial state, etc.).
      await p.volunteerShiftNotification.deleteMany({
        where: { signupId, kind, channel },
      });
    },

    // ── Hours tracking ────────────────────────────────────────────────

    async updateSignupHoursWorked({ id, hoursWorked }) {
      const row = await p.volunteerSignup.update({
        where: { id },
        data: { hoursWorked },
        select: SIGNUP_SELECT,
      });
      return mapSignup(row);
    },

    async listSignupsForHoursReport(eventId: string) {
      const rows = await p.volunteerSignup.findMany({
        where: { eventId },
        orderBy: [{ role: { sortOrder: "asc" } }, { contactName: "asc" }],
        select: {
          id: true,
          contactName: true,
          contactEmail: true,
          status: true,
          checkedInAt: true,
          hoursWorked: true,
          notes: true,
          role: { select: { name: true } },
          shift: { select: { label: true, startsAt: true, endsAt: true } },
          // 1:1 signup → acceptance relation; selecting it here keeps the
          // export a single query (no N+1).
          waiverAcceptance: { select: { acceptedAt: true } },
        },
      });

      return rows.map((r): import("@th/types").HoursReportRow => {
        // Both columns come from the ONE shared rule (@th/types/volunteer-
        // hours) rather than a local duration calculation — same helper the
        // /my-volunteering read model uses, so the volunteer's page and the
        // organizer's export can never disagree about the same signup.
        // Behaviour is identical to the inline version this replaced:
        // scheduled duration at 2dp, override winning when set.
        const override = decToNumber(r.hoursWorked);
        return {
          signupId: r.id,
          contactName: r.contactName ?? null,
          contactEmail: r.contactEmail,
          roleName: r.role.name,
          shiftLabel: r.shift?.label ?? null,
          shiftStartsAt: r.shift?.startsAt ?? null,
          shiftEndsAt: r.shift?.endsAt ?? null,
          status: r.status,
          checkedInAt: r.checkedInAt ?? null,
          scheduledHours: scheduledHoursBetween(
            r.shift?.startsAt,
            r.shift?.endsAt,
          ),
          actualHours: creditedHours(
            override,
            r.shift?.startsAt,
            r.shift?.endsAt,
          ),
          notes: r.notes ?? null,
          waiverAcceptedAt: r.waiverAcceptance?.acceptedAt ?? null,
        };
      });
    },

    async aggregateHoursByVolunteer(orgId, range, opts) {
      // One grouped query across every signup of every event the org
      // owns — no N+1. Prisma `groupBy` can't express the
      // `hoursWorked ?? scheduled-duration` COALESCE, so this drops to
      // parameterized raw SQL (tagged template — user input is never
      // string-interpolated). None of the volunteer models nor `Event`
      // carry an `@@map`, so the quoted model names are the physical
      // table names (same assumption as `countAcceptedOccupancy`).
      //
      // Per-signup hours mirror `listSignupsForHoursReport` exactly:
      // the override wins, else the shift's scheduled duration rounded
      // to 2dp *per row* (rounding before SUM keeps the org total equal
      // to the sum of per-event export rows). Shiftless signups without
      // an override contribute NULL — SUM skips them — but still count
      // toward eventsCount/signupsCount.
      //
      // SOURCE OF TRUTH FOR THIS RULE IS `creditedHours`
      // (packages/types/src/volunteer-hours.ts), which every JS caller —
      // the hours export above and the /my-volunteering read model —
      // shares. This path CANNOT call it: Prisma `groupBy` can't express
      // the COALESCE, so the rule is hand-written in the SQL below
      // (`COALESCE(vs."hoursWorked", ROUND(EXTRACT(EPOCH …)/3600, 2))`).
      // The two are a matched pair — change one, change the other in the
      // same commit, or the org aggregate silently stops reconciling with
      // the per-event exports it is defined to equal.
      //
      // Grouping key: humanId when linked, else the lowercased contact
      // email (signups are not email-normalized at submit time, so a
      // shadow volunteer using "Jo@x.com" and "jo@x.com" across events
      // still folds into one row).
      //
      // Range bounds apply to the activity instant — shift start, or
      // signup createdAt for shiftless signups. `from` inclusive, `to`
      // exclusive.
      const fromFilter =
        range?.from != null
          ? Prisma.sql`AND COALESCE(s."startsAt", vs."createdAt") >= ${range.from}`
          : Prisma.empty;
      const toFilter =
        range?.to != null
          ? Prisma.sql`AND COALESCE(s."startsAt", vs."createdAt") < ${range.to}`
          : Prisma.empty;
      // acceptedOnly (recognition / grant view): keep only APPROVED |
      // CHECKED_IN signups. The status column is a Postgres enum and the
      // bound parameters arrive as text, so compare on the text projection —
      // `enum = text` has no operator, `enum::text IN (text, …)` does.
      const statusFilter = opts?.acceptedOnly
        ? Prisma.sql`AND vs."status"::text IN (${Prisma.join([...ACCEPTED_SIGNUP_STATUSES])})`
        : Prisma.empty;

      const rows = await p.$queryRaw<
        Array<{
          volunteerKey: string;
          humanId: string | null;
          contactEmail: string;
          contactName: string | null;
          totalHours: unknown; // numeric → Prisma Decimal
          eventsCount: number;
          signupsCount: number;
          lastShiftAt: Date;
        }>
      >(Prisma.sql`
        SELECT
          COALESCE(vs."humanId", 'email:' || LOWER(vs."contactEmail")) AS "volunteerKey",
          MAX(vs."humanId") AS "humanId",
          MAX(vs."contactEmail") AS "contactEmail",
          MAX(vs."contactName") AS "contactName",
          COALESCE(SUM(
            COALESCE(
              vs."hoursWorked",
              ROUND((EXTRACT(EPOCH FROM (s."endsAt" - s."startsAt")) / 3600)::numeric, 2)
            )
          ), 0) AS "totalHours",
          COUNT(DISTINCT vs."eventId")::int AS "eventsCount",
          COUNT(*)::int AS "signupsCount",
          MAX(COALESCE(s."startsAt", vs."createdAt")) AS "lastShiftAt"
        FROM "VolunteerSignup" vs
        JOIN "Event" e ON e."id" = vs."eventId"
        LEFT JOIN "EventVolunteerShift" s ON s."id" = vs."shiftId"
        WHERE e."orgId" = ${orgId}
        ${fromFilter}
        ${toFilter}
        ${statusFilter}
        GROUP BY 1
        ORDER BY "totalHours" DESC, "lastShiftAt" DESC, "volunteerKey" ASC
      `);

      return rows.map((r) => ({
        volunteerKey: r.volunteerKey,
        humanId: r.humanId ?? null,
        contactEmail: r.contactEmail,
        contactName: r.contactName ?? null,
        totalHours: decToNumber(r.totalHours) ?? 0,
        eventsCount: r.eventsCount,
        signupsCount: r.signupsCount,
        lastShiftAt: r.lastShiftAt,
      }));
    },

    // ── Roster broadcasts ─────────────────────────────────────────────

    async createBroadcast(input: CreateVolunteerBroadcastInput) {
      try {
        const row = await p.volunteerBroadcast.create({
          data: {
            ...(input.id ? { id: input.id } : {}),
            askId: input.askId,
            senderHumanId: input.senderHumanId,
            scopeType: input.scopeType,
            scopeId: input.scopeId ?? null,
            subject: input.subject,
            body: input.body,
            recipientCount: input.recipientCount,
          },
          select: BROADCAST_SELECT,
        });
        return mapBroadcast(row);
      } catch (error) {
        // P2002 can only come from the pk when the caller supplied `id`
        // (VolunteerBroadcast has no other unique): a concurrent retry
        // lost the create race. Map it to a domain conflict (same
        // convention as duplicate_event_ask on createAsk). Inside an
        // interactive tx the P2002 has already aborted the tx (25P02) —
        // callers must fail the whole tx and let the client retry; the
        // retry then short-circuits on the getBroadcast pre-read.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          throw {
            code: "duplicate_broadcast",
            message: "duplicate_broadcast",
            cause: error,
          } as const;
        }
        throw error;
      }
    },

    async getBroadcast(id: string) {
      const row = await p.volunteerBroadcast.findUnique({
        where: { id },
        select: BROADCAST_SELECT,
      });
      return row ? mapBroadcast(row) : null;
    },

    async listBroadcastsByAsk(askId: string) {
      const rows = await p.volunteerBroadcast.findMany({
        where: { askId },
        orderBy: { createdAt: "desc" },
        select: BROADCAST_SELECT,
      });
      return rows.map(mapBroadcast);
    },

    async listBroadcastRecipients(askId, scope) {
      // Accepted signups only (APPROVED | CHECKED_IN) — a broadcast is a
      // roster announcement, so the pending pool never receives it. POOL
      // means accepted-but-unassigned (groupId null).
      const rows = await p.volunteerSignup.findMany({
        where: {
          askId,
          status: { in: [...ACCEPTED_SIGNUP_STATUSES] },
          ...(scope.kind === "ROLE" ? { roleId: scope.roleId } : {}),
          ...(scope.kind === "GROUP" ? { groupId: scope.groupId } : {}),
          ...(scope.kind === "POOL" ? { groupId: null } : {}),
        },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          humanId: true,
          contactEmail: true,
          contactName: true,
        },
      });
      return rows.map((r) => ({
        signupId: r.id,
        humanId: r.humanId ?? null,
        contactEmail: r.contactEmail,
        contactName: r.contactName ?? null,
      }));
    },

    // ── "My volunteering" .ics feed ───────────────────────────────────

    async setVolunteerIcsFeedToken(humanId: string, token: string) {
      // Set-if-absent (port contract): only fill a NULL column, so a
      // concurrent first-subscribe race can never overwrite the token
      // the winner already handed out as a calendar URL. Zero rows
      // updated = lost the race (or no such human) — caller re-reads.
      const result = await p.human.updateMany({
        where: { id: humanId, volunteerIcsFeedToken: null },
        data: { volunteerIcsFeedToken: token },
      });
      return result.count > 0;
    },

    async replaceVolunteerIcsFeedToken(humanId: string, token: string) {
      // UNCONDITIONAL overwrite (port contract) — the rotation primitive.
      // No `volunteerIcsFeedToken: null` guard here, unlike the
      // set-if-absent mint above: rotation exists to clobber a leaked
      // token. Zero rows updated = no such human — caller 404s.
      const result = await p.human.updateMany({
        where: { id: humanId },
        data: { volunteerIcsFeedToken: token },
      });
      return result.count > 0;
    },

    async getVolunteerIcsFeedToken(humanId: string) {
      const row = await p.human.findUnique({
        where: { id: humanId },
        select: { volunteerIcsFeedToken: true },
      });
      return row?.volunteerIcsFeedToken ?? null;
    },

    async findHumanIdByIcsFeedToken(token: string) {
      const row = await p.human.findUnique({
        where: { volunteerIcsFeedToken: token },
        select: { id: true },
      });
      return row?.id ?? null;
    },

    async listUpcomingSignupsForFeed(humanId: string, from: Date) {
      // Two shapes, two queries (merged + sorted in memory — feeds are
      // small): event-path rows derive their window from the shift and
      // join the event for title/venue (same joins as
      // findShiftsNeedingReminder); ask-path rows use the ask's own
      // startsAt/endsAt window and title. Windowless signups (shiftless
      // event rows, asks without startsAt) are excluded — a calendar
      // entry needs a start. Projection/mapping is shared with
      // listCommitmentsByHuman via HUMAN_SIGNUP_SELECT + mapCommitment;
      // toFeedRecord drops the page-only fields and the windowless rows.
      const [shiftRows, askRows] = await Promise.all([
        p.volunteerSignup.findMany({
          where: {
            humanId,
            status: { in: [...ACCEPTED_SIGNUP_STATUSES] },
            shift: { startsAt: { gte: from } },
          },
          select: HUMAN_SIGNUP_SELECT,
        }),
        p.volunteerSignup.findMany({
          where: {
            humanId,
            status: { in: [...ACCEPTED_SIGNUP_STATUSES] },
            shiftId: null,
            askId: { not: null },
            ask: { startsAt: { gte: from } },
          },
          select: HUMAN_SIGNUP_SELECT,
        }),
      ]);

      // No `r.shift && r.event` narrowing filter any more: mapCommitment
      // falls back to the ask's title when a shift-bearing signup has no
      // event, so such a row is mapped rather than silently dropped.
      // Confirmed no-op — the signup-level invariant
      // `if (input.shiftId && !input.eventId) throw shift_id_requires_event_id`
      // (core volunteer-signups.ts, submitVolunteerSignup) is exactly what
      // the dropped filter was re-testing, so shift-bearing rows always
      // carry an eventId. A silent drop is still the wrong failure mode
      // for a calendar.
      const items = [...shiftRows, ...askRows]
        .map(mapCommitment)
        .map(toFeedRecord)
        .filter((r): r is VolunteerFeedSignupRecord => r !== null);

      return items.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
    },

    // ── "My volunteering" page ────────────────────────────────────────

    async listCommitmentsByHuman(humanId: string, now: Date) {
      // THREE bounded queries, merged and sorted in memory. Their bounds do
      // not compete: see COMMITMENT_CLAIM_MAX_ROWS for why claims cannot
      // share the signup cap, and why they are split by `now`.
      //
      // (1) SIGNUPS — the page wants every signup this human holds, so
      // there is nothing to filter: no status filter, no `from` bound, and
      // windowless rows stay in with startsAt null. Shift-bearing and
      // shiftless rows share the projection, so a single `where: { humanId }`
      // covers both paths exactly once.
      //
      // BOUNDED: `take` caps the read at COMMITMENTS_MAX_ROWS. The
      // DB-level `orderBy` is NOT the caller-facing sort — it exists so
      // that truncation drops the OLDEST-CREATED signups (the deep history
      // tail). Ordering by anything else (or omitting it, which leaves the
      // order arbitrary) would make truncation arbitrary too. This half is
      // UNCHANGED by the occurrence phase — see the port doc for the exact,
      // narrower guarantee it can actually make.
      //
      // (2)+(3) OCCURRENCE CLAIMS — one row per CLAIMED claim on a
      // SCHEDULED occurrence, split at `now` so each bucket can be ordered
      // in the direction that makes its truncation harmless: upcoming ASC
      // (drop the furthest-out), past DESC (drop the oldest). An upcoming
      // slot therefore cannot be truncated away by history, which is the
      // property the single-query version could not offer.
      //
      // WITHDRAWN claims and CANCELLED occurrences are both excluded here,
      // in SQL. Cancellation is NOT silent: `cancelShiftOccurrence` fans a
      // notification (account-linked) or an email (shadow) out to every
      // claimant, keyed per claim, and deliberately leaves the claim rows
      // CLAIMED so history is preserved. Surfacing the row instead would
      // mean asserting "the organizer cancelled this" through
      // `VolunteerSignupStatus`, and none of its six values says that:
      // WITHDRAWN blames the volunteer for a decision they did not make,
      // NO_SHOW libels them. A seventh value is a contract change for a
      // later phase, not something to smuggle in via a read model.
      const claimWhere = {
        status: "CLAIMED",
        signup: { humanId },
      } as const;
      const [rows, upcomingClaims, pastClaims] = await Promise.all([
        p.volunteerSignup.findMany({
          where: { humanId },
          orderBy: { createdAt: "desc" },
          take: COMMITMENTS_MAX_ROWS,
          select: HUMAN_SIGNUP_SELECT,
        }),
        p.volunteerOccurrenceClaim.findMany({
          where: {
            ...claimWhere,
            occurrence: { status: "SCHEDULED", startsAt: { gte: now } },
          },
          orderBy: { occurrence: { startsAt: "asc" } },
          take: COMMITMENT_CLAIM_MAX_ROWS,
          select: HUMAN_CLAIM_SELECT,
        }),
        p.volunteerOccurrenceClaim.findMany({
          where: {
            ...claimWhere,
            occurrence: { status: "SCHEDULED", startsAt: { lt: now } },
          },
          orderBy: { occurrence: { startsAt: "desc" } },
          take: COMMITMENT_CLAIM_MAX_ROWS,
          select: HUMAN_CLAIM_SELECT,
        }),
      ]);

      const occurrenceRows = [...upcomingClaims, ...pastClaims].map(
        mapOccurrenceCommitment,
      );

      // ── De-duplication ────────────────────────────────────────────────
      // A claim's parent signup is always an ask-path row, and on an
      // open-ended standing ask it renders as "No set shift time". Left in
      // beside the volunteer's actual claimed dates it is a phantom: the
      // same commitment, stated twice, once wrongly. So a signup that
      // produced occurrence rows here does not also emit its bare row.
      //
      // Keyed off the rows we ACTUALLY EMITTED, not off "has any claim", so
      // the two ways a claim can fail to become a row — a CANCELLED
      // occurrence, or truncation at COMMITMENT_CLAIM_MAX_ROWS — can never
      // suppress a parent we did not replace. Suppression must not be able
      // to leave a volunteer with nothing.
      //
      // "Bare" is the operative word, and it is checked: a parent carrying
      // its OWN check-in or hours override is not a duplicate of anything.
      // `checkInVolunteer` stamps `role.defaultHours` onto the signup at
      // ask-level check-in, and those hours exist nowhere else in this
      // result — dropping that row would quietly delete credited hours from
      // a volunteer's service statement, the same failure the
      // `hoursCredited` work exists to prevent, just in the other direction.
      const replacedSignupIds = new Set(occurrenceRows.map((r) => r.signupId));
      const signupRows = rows
        .map(mapCommitment)
        .filter(
          (c) =>
            !replacedSignupIds.has(c.signupId) ||
            c.checkedInAt !== null ||
            c.hoursWorked !== null,
        );

      // startsAt ASC NULLS LAST, then createdAt DESC. Sorted in memory
      // rather than in SQL because the row kinds take their window from
      // three different relations (shift, ask, occurrence) — there is no
      // single orderable column, and they arrive from three queries. Safe
      // to do in memory precisely because every one of them is bounded.
      return [...signupRows, ...occurrenceRows].sort((a, b) => {
        if (a.startsAt && b.startsAt) {
          const delta = a.startsAt.getTime() - b.startsAt.getTime();
          if (delta !== 0) return delta;
        } else if (a.startsAt) {
          return -1;
        } else if (b.startsAt) {
          return 1;
        }
        return b.createdAt.getTime() - a.createdAt.getTime();
      });
    },

    // ── Comp-ticket rewards ───────────────────────────────────────────

    async upsertReward(input: UpsertVolunteerRewardInput) {
      const roleId = input.roleId ?? null;
      // Compound-unique lookup: findUnique can't take a null in the
      // (askId, roleId) key (Postgres treats NULLs as distinct anyway —
      // that's what the partial index guards), so resolve via findFirst.
      const existing = await p.volunteerReward.findFirst({
        where: { askId: input.askId, roleId },
        select: { id: true },
      });

      if (existing) {
        const row = await p.volunteerReward.update({
          where: { id: existing.id },
          data: {
            ticketTypeId: input.ticketTypeId,
            ...(input.trigger !== undefined && { trigger: input.trigger }),
            ...(input.maxGrants !== undefined && {
              maxGrants: input.maxGrants,
            }),
            ...(input.active !== undefined && { active: input.active }),
          },
          select: REWARD_SELECT,
        });
        return mapReward(row);
      }

      try {
        const row = await p.volunteerReward.create({
          data: {
            askId: input.askId,
            roleId,
            ticketTypeId: input.ticketTypeId,
            trigger: input.trigger ?? "ON_CHECK_IN",
            maxGrants: input.maxGrants ?? null,
            active: input.active ?? true,
          },
          select: REWARD_SELECT,
        });
        return mapReward(row);
      } catch (error) {
        // P2002 on create can come from either uniqueness guard: the
        // `@@unique([askId, roleId])` (role-specific) or the raw partial
        // index "VolunteerReward_ask_level_key" (roleId IS NULL, ask-level).
        // Both mean a concurrent upsert won the create race — map to the
        // domain conflict (same convention as duplicate_event_ask).
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          throw {
            code: "duplicate_reward",
            message: "duplicate_reward",
            cause: error,
          } as const;
        }
        throw error;
      }
    },

    async getReward(rewardId: string) {
      const row = await p.volunteerReward.findUnique({
        where: { id: rewardId },
        select: REWARD_SELECT,
      });
      return row ? mapReward(row) : null;
    },

    async listRewardsByAsk(askId: string) {
      // Full reward CONFIG for the ask: ask-level + every role-level reward,
      // inactive included, so the config form / complete ledger can show a
      // configured-but-zero-grant reward. Oldest first (ask-level typically
      // leads its role rewards).
      const rows = await p.volunteerReward.findMany({
        where: { askId },
        orderBy: { createdAt: "asc" },
        select: REWARD_SELECT,
      });
      return rows.map(mapReward);
    },

    async getRewardForSignup(askId: string, roleId: string) {
      // Role-specific active reward wins over the ask-level one; inactive
      // rewards are never returned.
      const roleReward = await p.volunteerReward.findFirst({
        where: { askId, roleId, active: true },
        select: REWARD_SELECT,
      });
      if (roleReward) return mapReward(roleReward);

      const askReward = await p.volunteerReward.findFirst({
        where: { askId, roleId: null, active: true },
        select: REWARD_SELECT,
      });
      return askReward ? mapReward(askReward) : null;
    },

    async getRewardForUpdate(rewardId: string) {
      // Budget serialization point: lock the reward row until the ambient
      // interactive tx commits, so a concurrent grant's own
      // getRewardForUpdate blocks behind this one and the budget check +
      // increment can't race (mirrors countAcceptedOccupancy's FOR UPDATE).
      // VolunteerReward has no @@map, so the quoted name is the table name.
      const rows = await p.$queryRaw<
        Array<{
          id: string;
          askId: string;
          roleId: string | null;
          ticketTypeId: string;
          trigger: string;
          maxGrants: number | null;
          grantsUsed: number;
          active: boolean;
        }>
      >`SELECT "id", "askId", "roleId", "ticketTypeId", "trigger", "maxGrants", "grantsUsed", "active" FROM "VolunteerReward" WHERE "id" = ${rewardId} FOR UPDATE`;
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        askId: row.askId,
        roleId: row.roleId ?? null,
        ticketTypeId: row.ticketTypeId,
        trigger: row.trigger as VolunteerRewardTrigger,
        maxGrants: row.maxGrants ?? null,
        grantsUsed: row.grantsUsed,
        active: row.active,
      } satisfies VolunteerRewardBudgetLock;
    },

    async incrementGrantsUsed(rewardId: string) {
      await p.volunteerReward.update({
        where: { id: rewardId },
        data: { grantsUsed: { increment: 1 } },
      });
    },

    async decrementGrantsUsed(rewardId: string) {
      // Guarded floor: GREATEST(...,0) so a double-revoke or out-of-order
      // call can never drive the counter negative. Raw (Prisma has no
      // GREATEST expression); @updatedAt isn't applied to raw writes, so
      // bump updatedAt explicitly.
      await p.$executeRaw`UPDATE "VolunteerReward" SET "grantsUsed" = GREATEST("grantsUsed" - 1, 0), "updatedAt" = now() WHERE "id" = ${rewardId}`;
    },

    async createGrant(input: CreateVolunteerRewardGrantInput) {
      try {
        const row = await p.volunteerRewardGrant.create({
          data: {
            rewardId: input.rewardId,
            signupId: input.signupId,
            humanId: input.humanId ?? null,
            contactEmail: input.contactEmail,
            status: input.status ?? "GRANTED",
            compOrderId: input.compOrderId ?? null,
            ticketId: input.ticketId ?? null,
            faceValueCents: input.faceValueCents,
          },
          select: GRANT_SELECT,
        });
        return mapGrant(row);
      } catch (error) {
        // P2002 can only come from `@@unique([rewardId, signupId])` (the
        // idempotency anchor) — `id` is a fresh uuid. A double-fired trigger
        // maps to the domain conflict (same convention as duplicate_event_ask).
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          throw {
            code: "duplicate_grant",
            message: "duplicate_grant",
            cause: error,
          } as const;
        }
        throw error;
      }
    },

    async getGrant(grantId: string) {
      const row = await p.volunteerRewardGrant.findUnique({
        where: { id: grantId },
        select: GRANT_SELECT,
      });
      return row ? mapGrant(row) : null;
    },

    async getGrantByRewardAndSignup(rewardId: string, signupId: string) {
      const row = await p.volunteerRewardGrant.findUnique({
        where: { rewardId_signupId: { rewardId, signupId } },
        select: GRANT_SELECT,
      });
      return row ? mapGrant(row) : null;
    },

    async listGrantsBySignup(signupId: string) {
      const rows = await p.volunteerRewardGrant.findMany({
        where: { signupId },
        orderBy: { grantedAt: "desc" },
        select: GRANT_SELECT,
      });
      return rows.map(mapGrant);
    },

    async listRewardGrantStatusesBySignupIds(
      signupIds: string[],
    ): Promise<VolunteerRewardGrantStatusBySignup[]> {
      if (signupIds.length === 0) return [];
      // Coordinator-safe projection: bare status + the linked ticket status
      // for the SCANNED→REDEEMED derivation. NO faceValueCents / compOrderId /
      // budget selected — a coordinator must never see money (NFR-003).
      const rows = await p.volunteerRewardGrant.findMany({
        where: { signupId: { in: signupIds } },
        select: {
          signupId: true,
          status: true,
          ticket: { select: { status: true } },
        },
      });
      // A signup should carry at most one applicable grant, but if multiple
      // exist the meaningful live one wins: REDEEMED > GRANTED > REVOKED.
      const PRIORITY: Record<VolunteerRewardGrantStatus, number> = {
        REDEEMED: 3,
        GRANTED: 2,
        REVOKED: 1,
      };
      const best = new Map<string, VolunteerRewardGrantStatus>();
      for (const r of rows) {
        const ticketStatus =
          (r.ticket?.status as TicketStatus | undefined) ?? null;
        // Mirror the owner-side effectiveRewardStatus exactly: a REVOKED grant
        // wins (it's void), otherwise a scanned/redeemed comp reads REDEEMED.
        // The REVOKED+SCANNED combination is unreachable today — revoke only
        // voids un-scanned comps — but keeping the order identical means the
        // owner ledger and coordinator roster can never disagree.
        const effective: VolunteerRewardGrantStatus =
          r.status === "REVOKED"
            ? "REVOKED"
            : r.status === "REDEEMED" || ticketStatus === "SCANNED"
              ? "REDEEMED"
              : (r.status as VolunteerRewardGrantStatus);
        const prev = best.get(r.signupId);
        if (prev === undefined || PRIORITY[effective] > PRIORITY[prev]) {
          best.set(r.signupId, effective);
        }
      }
      return [...best.entries()].map(([signupId, status]) => ({
        signupId,
        status,
      }));
    },

    async listGrantsByAsk(askId: string, opts?: ListRewardGrantsByAskOpts) {
      // Ledger read: join each grant to its reward (filter by askId, carry
      // role + target ticket type) and to the live comp Ticket for its
      // status — a SCANNED ticket is effectively redeemed even before
      // redeemedAt is stamped.
      const rows = await p.volunteerRewardGrant.findMany({
        where: {
          reward: { askId },
          ...(opts?.status ? { status: opts.status } : {}),
        },
        orderBy: { grantedAt: "desc" },
        select: {
          ...GRANT_SELECT,
          reward: { select: { roleId: true, ticketTypeId: true } },
          ticket: { select: { status: true } },
        },
      });
      return rows.map(
        (r): VolunteerRewardGrantLedgerRow => ({
          ...mapGrant(r),
          rewardRoleId: r.reward.roleId ?? null,
          rewardTicketTypeId: r.reward.ticketTypeId,
          ticketStatus: (r.ticket?.status as TicketStatus | undefined) ?? null,
        }),
      );
    },

    async updateGrantStatus(
      grantId: string,
      patch: UpdateVolunteerRewardGrantStatusInput,
    ) {
      const row = await p.volunteerRewardGrant.update({
        where: { id: grantId },
        data: {
          status: patch.status,
          ...(patch.redeemedAt !== undefined && {
            redeemedAt: patch.redeemedAt,
          }),
          ...(patch.revokedAt !== undefined && { revokedAt: patch.revokedAt }),
          ...(patch.revokeReason !== undefined && {
            revokeReason: patch.revokeReason,
          }),
        },
        select: GRANT_SELECT,
      });
      return mapGrant(row);
    },
  };
}
