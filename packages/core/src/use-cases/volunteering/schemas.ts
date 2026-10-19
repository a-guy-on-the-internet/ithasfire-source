import { z } from "zod";

import {
  plainTextMultilineOptional,
  plainTextMultilineRequired,
  plainTextOptional,
  plainTextRequired,
} from "../../lib/sanitize-plain-text";
import { isValidTimeZone } from "../../lib/venue-local-time";

// ─────────────────────────────────────────────────────────────────────────────
// Volunteering — Zod schemas
// ─────────────────────────────────────────────────────────────────────────────

// ── Role templates ──────────────────────────────────────────────────────────

export const createRoleTemplateInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  orgId: z.string().uuid(),
  name: plainTextRequired(120),
  description: plainTextMultilineOptional(2000).nullish(),
  defaultCapacity: z.number().int().min(1).nullish(),
});

export const updateRoleTemplateInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  id: z.string().uuid(),
  name: plainTextRequired(120).optional(),
  description: plainTextMultilineOptional(2000).nullish(),
  defaultCapacity: z.number().int().min(1).nullish(),
  sortOrder: z.number().int().min(0).optional(),
});

export const archiveRoleTemplateInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  id: z.string().uuid(),
});

export const listRoleTemplatesInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  orgId: z.string().uuid(),
  includeArchived: z.boolean().optional(),
});

// ── Role-template shift presets ─────────────────────────────────────────────
//
// Stored as time-of-day (0..1439 minutes-of-day) plus a day offset from
// the event date. Day offset is bounded so a template can span a long
// festival weekend without allowing absurd values that hint at a bug.

const MAX_TEMPLATE_SHIFTS = 25;
const MINUTES_PER_DAY = 24 * 60; // 1440
const MIN_DAY_OFFSET = -7;
const MAX_DAY_OFFSET = 14;

/**
 * Bound on `offsetMinutes`: ±24 hours (FR-005).
 *
 * The anchor exists to say "measured from THIS show" — load-in three hours
 * before the doors open, cleanup an hour after the last set. Past a day out
 * from the event's own start/end that framing stops being true: it is another
 * day's work, and `startDayOffset` (-7..+14, DST-aware whole calendar days in
 * the venue's zone) is the control that already expresses it. Capping at one
 * day keeps the two controls from becoming two ways of saying the same thing,
 * and keeps a fat-fingered "-18000" (minutes vs seconds) from silently
 * scheduling a shift twelve days early.
 *
 * ±1440 still covers the real long cases — an overnight festival load-in at
 * EVENT_START −20h resolves fine — so nothing legitimate is out of reach.
 */
const MAX_ANCHOR_OFFSET_MINUTES = MINUTES_PER_DAY;

export const volunteerShiftAnchorSchema = z.enum([
  "WALL_CLOCK",
  "EVENT_START",
  "EVENT_END",
]);

const roleTemplateShiftDraftSchemaBase = z.object({
  label: plainTextRequired(120),
  startMinuteOfDay: z
    .number()
    .int()
    .min(0)
    .max(MINUTES_PER_DAY - 1),
  endMinuteOfDay: z
    .number()
    .int()
    .min(0)
    .max(MINUTES_PER_DAY - 1),
  startDayOffset: z
    .number()
    .int()
    .min(MIN_DAY_OFFSET)
    .max(MAX_DAY_OFFSET)
    .optional(),
  endsNextDay: z.boolean().optional(),
  capacity: z.number().int().min(1).nullish(),
  position: z.number().int().min(0).optional(),
  /**
   * What the start is measured from. Omitted = WALL_CLOCK, which ignores
   * `offsetMinutes` and reproduces the pre-anchor behaviour exactly.
   *
   * On an anchored preset `startMinuteOfDay` / `endMinuteOfDay` /
   * `endsNextDay` stop naming a wall clock and only carry the DURATION
   * (`end - start`, plus a day when `endsNextDay`). Both fields are still
   * required and still round-trip, so flipping the anchor back to WALL_CLOCK
   * restores the original times rather than losing them.
   */
  anchor: volunteerShiftAnchorSchema.optional(),
  /**
   * Signed minutes from the anchor; negative = before it. Must be 0 on a
   * WALL_CLOCK preset (enforced below) so there is exactly one representation
   * of "no offset" and a stale value can't come back to life when the anchor
   * is switched.
   */
  offsetMinutes: z
    .number()
    .int()
    .min(-MAX_ANCHOR_OFFSET_MINUTES)
    .max(MAX_ANCHOR_OFFSET_MINUTES)
    .optional(),
  /** Admin-only preset note copied onto the materialized shift. */
  notes: plainTextMultilineOptional(2000).nullish(),
});

export const roleTemplateShiftDraftSchema = roleTemplateShiftDraftSchemaBase
  .refine(
    // When end time-of-day equals start time-of-day, only valid if
    // endsNextDay is true (a 24-hour shift). Otherwise reject.
    (d) => d.endMinuteOfDay !== d.startMinuteOfDay || d.endsNextDay === true,
    {
      message:
        "endMinuteOfDay must differ from startMinuteOfDay (or set endsNextDay for a 24-hour shift)",
      path: ["endMinuteOfDay"],
    },
  )
  .refine(
    // `endsNextDay` is DERIVED, never round-tripped. The only writer in either
    // editor is `parseShiftDraftFields`, which computes `end < start`; the
    // draft shape has no `endsNextDay` field at all, so a stored row with
    // `end > start` AND the flag set (start 10:00, end 20:00, endsNextDay —
    // a 34-hour shift) reads back as a plain 10-hour one and silently loses a
    // day the next time anyone touches the role.
    //
    // Rejecting the shape is the fix rather than teaching the draft to carry
    // the flag: the editors have no >24h control to edit it with
    // (`withShiftDraftDurationMinutes` clamps at 23:59), so a round-tripped
    // `endsNextDay` would be invisible state that goes stale the moment the
    // times change — the same class of bug one level deeper. Closing it here
    // means the seed path and a direct API call cannot create it either.
    //
    // `end === start && endsNextDay` stays legal: that is the documented
    // 24-hour shift the refine above admits.
    (d) =>
      d.endsNextDay !== true || d.endMinuteOfDay <= d.startMinuteOfDay,
    {
      message:
        "endsNextDay may only be set when endMinuteOfDay is at or before startMinuteOfDay (a shift that wraps past midnight)",
      path: ["endsNextDay"],
    },
  )
  .refine(
    // A wall-clock preset has no anchor to offset FROM, so a non-zero value
    // would be silently ignored at resolution time — reject it instead of
    // storing a lie.
    (d) =>
      (d.anchor ?? "WALL_CLOCK") !== "WALL_CLOCK" ||
      (d.offsetMinutes ?? 0) === 0,
    {
      message: "offsetMinutes must be 0 when anchor is WALL_CLOCK",
      path: ["offsetMinutes"],
    },
  );

export const upsertRoleTemplateShiftsInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  templateId: z.string().uuid(),
  shifts: z.array(roleTemplateShiftDraftSchema).max(MAX_TEMPLATE_SHIFTS),
});

export const getRoleTemplateWithShiftsInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  templateId: z.string().uuid(),
});

/**
 * "Customise" — fork a LIVE platform catalogue role into an org-owned copy
 * (FR-011 / FR-012).
 *
 * No `idempotencyKey` field on purpose. FR-012 pins idempotency to
 * (orgId, source template id), and that key is DERIVED server-side: a
 * client-supplied key could differ between two clicks of the same button and
 * would defeat the exact double-submit this guards against.
 *
 * `name` is the collision escape hatch. The fork copies the catalogue role's
 * name by default; when the org already has a template by that name the use
 * case refuses (`TEMPLATE_NAME_TAKEN`) rather than overwriting their row, and
 * the UI re-submits with an explicit `name`.
 */
export const forkPlatformRoleTemplateInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    orgId: z.string().uuid(),
    templateId: z.string().uuid(),
    name: plainTextRequired(120).optional(),
  })
  // `.strict()` so a client sending `idempotencyKey` gets a validation error
  // rather than the silent impression that it did something.
  .strict();

/** LIVE packs with their catalogue roles, for the organizer picker (FR-013). */
export const listVolunteerPacksInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    orgId: z.string().uuid(),
    /** Ranks packs targeting this category first. Ranking only — never a filter. */
    categoryId: z.string().uuid().nullish(),
  })
  .strict();

export type CreateRoleTemplateUseCaseInput = z.infer<
  typeof createRoleTemplateInputSchema
>;
export type UpdateRoleTemplateUseCaseInput = z.infer<
  typeof updateRoleTemplateInputSchema
>;
export type ArchiveRoleTemplateUseCaseInput = z.infer<
  typeof archiveRoleTemplateInputSchema
>;
export type ListRoleTemplatesUseCaseInput = z.infer<
  typeof listRoleTemplatesInputSchema
>;
export type RoleTemplateShiftDraftUseCaseInput = z.infer<
  typeof roleTemplateShiftDraftSchema
>;
export type UpsertRoleTemplateShiftsUseCaseInput = z.infer<
  typeof upsertRoleTemplateShiftsInputSchema
>;
export type GetRoleTemplateWithShiftsUseCaseInput = z.infer<
  typeof getRoleTemplateWithShiftsInputSchema
>;
export type ForkPlatformRoleTemplateUseCaseInput = z.infer<
  typeof forkPlatformRoleTemplateInputSchema
>;
export type ListVolunteerPacksUseCaseInput = z.infer<
  typeof listVolunteerPacksInputSchema
>;

// ── Event volunteer roles ───────────────────────────────────────────────────

export const createEventVolunteerRoleInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  eventId: z.string().uuid(),
  templateId: z.string().uuid().nullish(),
  name: plainTextRequired(120),
  description: plainTextMultilineOptional(2000).nullish(),
  capacity: z.number().int().min(1).nullish(),
  autoApprove: z.boolean().nullish(),
});

export const createFromTemplatesInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  eventId: z.string().uuid(),
  templateIds: z.array(z.string().uuid()).min(1).max(50),
});

export const updateEventVolunteerRoleInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  id: z.string().uuid(),
  name: plainTextRequired(120).optional(),
  description: plainTextMultilineOptional(2000).nullish(),
  capacity: z.number().int().min(1).nullish(),
  autoApprove: z.boolean().nullish(),
  sortOrder: z.number().int().min(0).optional(),
});

export const deleteEventVolunteerRoleInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  id: z.string().uuid(),
});

export const listEventVolunteerRolesInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  eventId: z.string().uuid(),
});

export type CreateEventVolunteerRoleUseCaseInput = z.infer<
  typeof createEventVolunteerRoleInputSchema
>;
export type CreateFromTemplatesUseCaseInput = z.infer<
  typeof createFromTemplatesInputSchema
>;
export type UpdateEventVolunteerRoleUseCaseInput = z.infer<
  typeof updateEventVolunteerRoleInputSchema
>;
export type DeleteEventVolunteerRoleUseCaseInput = z.infer<
  typeof deleteEventVolunteerRoleInputSchema
>;
export type ListEventVolunteerRolesUseCaseInput = z.infer<
  typeof listEventVolunteerRolesInputSchema
>;

// ── Shifts ──────────────────────────────────────────────────────────────────

export const createVolunteerShiftInputSchemaBase = z.object({
  actorHumanId: z.string().uuid(),
  roleId: z.string().uuid(),
  label: plainTextOptional(200).nullish(),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  capacity: z.number().int().min(1).nullish(),
  notes: plainTextMultilineOptional(2000).nullish(),
});

export const createVolunteerShiftInputSchema =
  createVolunteerShiftInputSchemaBase.refine((d) => d.endsAt > d.startsAt, {
    message: "endsAt must be after startsAt",
    path: ["endsAt"],
  });

export const createVolunteerShiftDraftInputSchemaBase =
  createVolunteerShiftInputSchemaBase.omit({
    actorHumanId: true,
    roleId: true,
  });

export const createVolunteerShiftDraftInputSchema =
  createVolunteerShiftDraftInputSchemaBase.refine(
    (d) => d.endsAt > d.startsAt,
    {
      message: "endsAt must be after startsAt",
      path: ["endsAt"],
    },
  );

export const createVolunteerShiftBatchInputSchemaBase = z.object({
  actorHumanId: z.string().uuid(),
  roleId: z.string().uuid(),
  shifts: z.array(createVolunteerShiftDraftInputSchema).min(1).max(25),
});

export const createVolunteerShiftBatchInputSchema =
  createVolunteerShiftBatchInputSchemaBase;

export const updateVolunteerShiftInputSchemaBase = z.object({
  actorHumanId: z.string().uuid(),
  id: z.string().uuid(),
  label: plainTextOptional(200).nullish(),
  startsAt: z.coerce.date().optional(),
  endsAt: z.coerce.date().optional(),
  capacity: z.number().int().min(1).nullish(),
  notes: plainTextMultilineOptional(2000).nullish(),
  sortOrder: z.number().int().min(0).optional(),
});

export const updateVolunteerShiftInputSchema =
  updateVolunteerShiftInputSchemaBase.refine(
    (d) => {
      if (d.startsAt && d.endsAt) return d.endsAt > d.startsAt;
      return true;
    },
    { message: "endsAt must be after startsAt", path: ["endsAt"] },
  );

export const deleteVolunteerShiftInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  id: z.string().uuid(),
});

export const listVolunteerShiftsInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  roleId: z.string().uuid(),
});

export type CreateVolunteerShiftUseCaseInput = z.infer<
  typeof createVolunteerShiftInputSchema
>;
export type CreateVolunteerShiftBatchUseCaseInput = z.infer<
  typeof createVolunteerShiftBatchInputSchema
>;
export type UpdateVolunteerShiftUseCaseInput = z.infer<
  typeof updateVolunteerShiftInputSchema
>;
export type DeleteVolunteerShiftUseCaseInput = z.infer<
  typeof deleteVolunteerShiftInputSchema
>;
export type ListVolunteerShiftsUseCaseInput = z.infer<
  typeof listVolunteerShiftsInputSchema
>;

// ── Signups ─────────────────────────────────────────────────────────────────

/**
 * Kept a plain `z.object` (no `.refine`) so the transport can `.omit()` the
 * server-injected fields. Exactly one of `eventId` / `askId` must be set,
 * and `shiftId` is event-path only — both enforced in the use case
 * (`submitVolunteerSignup`), mirroring how update-volunteer-ask validates
 * its merged window in-use-case for the same reason.
 */
export const submitVolunteerSignupInputSchema = z.object({
  actorHumanId: z.string().uuid().nullish(),
  /** Event-path signup (legacy surface). Mutually exclusive with `askId`. */
  eventId: z.string().uuid().nullish(),
  /** Generic ask-path signup. Mutually exclusive with `eventId`. */
  askId: z.string().uuid().nullish(),
  roleId: z.string().uuid(),
  shiftId: z.string().uuid().nullish(),
  contactEmail: z.string().email().max(320),
  contactName: plainTextOptional(200).nullish(),
  contactPhone: z.string().trim().max(30).nullish(),
  /**
   * TCPA opt-in for SMS shift reminders. False by default. The
   * reminder dispatcher refuses to send SMS without this set true AND
   * a non-empty contactPhone, regardless of org-level settings.
   * Volunteer can withdraw consent by re-submitting (or admin clears
   * the flag manually).
   */
  smsOptIn: z.boolean().optional(),
  answers: z.unknown().optional(),
  /**
   * Affirmative waiver acceptance (Gap 3). Required (`true`) when the
   * event has `volunteerWaiverRequired` AND an assigned waiver template
   * AND the resolved Human has no acceptance on file for the current
   * template version. Ignored otherwise.
   */
  waiverAccepted: z.boolean().optional(),
  /**
   * IP at acceptance time, for the legal record. Server-injected by the
   * transport from the request context — the tRPC procedure omits this
   * field from its client-facing input so clients can never supply it.
   */
  ipAddress: z.string().trim().max(64).nullish(),
  /** Browser user-agent for the legal record. Server-injected; see `ipAddress`. */
  userAgent: z.string().max(1024).nullish(),
});

export const reviewVolunteerSignupInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  signupId: z.string().uuid(),
  decision: z.enum(["APPROVED", "REJECTED"]),
  notes: plainTextMultilineOptional(2000).nullish(),
});

export const reviewVolunteerSignupsBatchInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  signupIds: z.array(z.string().uuid()).min(1).max(100),
  // Same decision domain as the single review — the batch is sugar over it.
  decision: reviewVolunteerSignupInputSchema.shape.decision,
  // One note applied to every signup in the batch (rejection reason).
  notes: plainTextMultilineOptional(2000).nullish(),
});

export const checkInVolunteerInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  signupId: z.string().uuid(),
  scannerDeviceId: z.string().uuid().nullish(),
});

export const withdrawVolunteerSignupInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  signupId: z.string().uuid(),
});

/**
 * Volunteer toggles SMS reminders on their own signup (Gap 6).
 * Consent stays per-signup — matching how it was captured at submit —
 * so there's deliberately no "apply to all my signups" input. Enabling
 * requires a `contactPhone` already on file (enforced in the use case);
 * disabling is always allowed and mirrors a carrier STOP.
 */
export const updateVolunteerContactPrefsInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  signupId: z.string().uuid(),
  smsOptIn: z.boolean(),
});

export const listMyVolunteerSignupsInputSchema = z.object({
  actorHumanId: z.string().uuid(),
});

/**
 * Read model behind the attendee-facing `/my-volunteering` page. Self-read
 * only — there is deliberately NO id parameter, so the actor is the only
 * human whose commitments can ever be read.
 */
export const listMyVolunteerCommitmentsInputSchema = z.object({
  actorHumanId: z.string().uuid(),
});

export const listVolunteerSignupsInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  eventId: z.string().uuid(),
  roleId: z.string().uuid().optional(),
  shiftId: z.string().uuid().optional(),
  status: z
    .enum([
      "PENDING",
      "APPROVED",
      "REJECTED",
      "WITHDRAWN",
      "CHECKED_IN",
      "NO_SHOW",
    ])
    .optional(),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).optional(),
});

export type SubmitVolunteerSignupUseCaseInput = z.infer<
  typeof submitVolunteerSignupInputSchema
>;
export type ReviewVolunteerSignupUseCaseInput = z.infer<
  typeof reviewVolunteerSignupInputSchema
>;
export type ReviewVolunteerSignupsBatchUseCaseInput = z.infer<
  typeof reviewVolunteerSignupsBatchInputSchema
>;
export type CheckInVolunteerUseCaseInput = z.infer<
  typeof checkInVolunteerInputSchema
>;
export type WithdrawVolunteerSignupUseCaseInput = z.infer<
  typeof withdrawVolunteerSignupInputSchema
>;
export type UpdateVolunteerContactPrefsUseCaseInput = z.infer<
  typeof updateVolunteerContactPrefsInputSchema
>;
export type ListMyVolunteerSignupsUseCaseInput = z.infer<
  typeof listMyVolunteerSignupsInputSchema
>;
export type ListMyVolunteerCommitmentsUseCaseInput = z.infer<
  typeof listMyVolunteerCommitmentsInputSchema
>;
export type ListVolunteerSignupsUseCaseInput = z.infer<
  typeof listVolunteerSignupsInputSchema
>;

// ── Generic volunteer asks (generic-volunteering-asks spec) ─────────────────

export const volunteerSubjectTypeSchema = z.enum([
  "PLACE",
  "ORG",
  "HUMAN",
  "EVENT",
]);

export const volunteerAskStatusSchema = z.enum([
  "DRAFT",
  "OPEN",
  "PAUSED",
  "CLOSED",
  "ARCHIVED",
]);

export const volunteerAskCadenceSchema = z.enum([
  "ONE_TIME",
  "ONGOING",
  "RECURRING",
]);

/**
 * IANA zone the organiser states an ask's window in (e.g. "America/Chicago").
 * Same runtime probe as `isValidTimeZone` in venue-local-time, so a zone
 * accepted here can never throw later inside a formatter. Output is the
 * canonical IANA spelling.
 */
export const volunteerAskTimeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((value) => isValidTimeZone(value), { message: "invalid_timezone" })
  // Store the canonical spelling ("america/chicago" → "America/Chicago") so
  // equal zones compare equal and render identically everywhere.
  .transform(
    (value) =>
      new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions()
        .timeZone,
  );

export const createVolunteerAskInputSchemaBase = z.object({
  actorHumanId: z.string().uuid(),
  subjectType: volunteerSubjectTypeSchema,
  subjectId: z.string().uuid(),
  title: plainTextRequired(200),
  description: plainTextMultilineOptional(5000).nullish(),
  cadence: volunteerAskCadenceSchema.optional(),
  startsAt: z.coerce.date().nullish(),
  endsAt: z.coerce.date().nullish(),
  /** Zone the window was typed in; null/absent = not stated. */
  timezone: volunteerAskTimeZoneSchema.nullish(),
  /** Soft cap across the whole ask — UI indicator only. */
  capacity: z.number().int().min(1).nullish(),
  autoApprove: z.boolean().optional(),
  waiverRequired: z.boolean().optional(),
  smsOptInEnabled: z.boolean().optional(),
  /** Application questions (same shape as event application answers). */
  formSchema: z.unknown().optional(),
});

export const createVolunteerAskInputSchema =
  createVolunteerAskInputSchemaBase.refine(
    (d) => !d.startsAt || !d.endsAt || d.endsAt > d.startsAt,
    { message: "endsAt must be after startsAt", path: ["endsAt"] },
  );

/**
 * Patch + status transitions. The subject (type/id) and denormalized orgId
 * are immutable — deliberately absent from this schema. `startsAt`/`endsAt`:
 * `undefined` = untouched, `null` = clear; the effective (merged) window is
 * validated in the use case against the stored ask.
 */
export const updateVolunteerAskInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  askId: z.string().uuid(),
  title: plainTextRequired(200).optional(),
  description: plainTextMultilineOptional(5000).nullish(),
  status: volunteerAskStatusSchema.optional(),
  cadence: volunteerAskCadenceSchema.optional(),
  startsAt: z.coerce.date().nullish(),
  endsAt: z.coerce.date().nullish(),
  /** `undefined` = untouched, `null` = clear. */
  timezone: volunteerAskTimeZoneSchema.nullish(),
  capacity: z.number().int().min(1).nullish(),
  autoApprove: z.boolean().optional(),
  waiverRequired: z.boolean().optional(),
  smsOptInEnabled: z.boolean().optional(),
  formSchema: z.unknown().optional(),
});

export const addVolunteerAskRoleInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  askId: z.string().uuid(),
  name: plainTextRequired(120),
  description: plainTextMultilineOptional(2000).nullish(),
  capacity: z.number().int().min(1).nullish(),
  /**
   * Owner-editable hours stamped onto `signup.hoursWorked` at check-in for
   * ask roles without a shift. Bounds mirror the hoursWorked override
   * (manage-volunteer-hours).
   */
  defaultHours: z.number().min(0).max(99).nullish(),
  templateId: z.string().uuid().nullish(),
});

export const updateVolunteerAskRoleInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  id: z.string().uuid(),
  name: plainTextRequired(120).optional(),
  description: plainTextMultilineOptional(2000).nullish(),
  capacity: z.number().int().min(1).nullish(),
  defaultHours: z.number().min(0).max(99).nullish(),
});

export const createVolunteerGroupInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  askId: z.string().uuid(),
  name: plainTextRequired(120),
  description: plainTextMultilineOptional(2000).nullish(),
  /** Soft cap — UI indicator only. */
  capacity: z.number().int().min(1).nullish(),
});

/**
 * Set / replace / clear the single coordinator on a group. Exactly one of
 * `coordinatorHumanId` / `coordinatorEmail` sets a coordinator; both
 * absent/null clears the assignment.
 */
export const assignGroupCoordinatorInputSchemaBase = z.object({
  actorHumanId: z.string().uuid(),
  groupId: z.string().uuid(),
  coordinatorHumanId: z.string().uuid().nullish(),
  // Trimmed + lowercased BEFORE validation, so " Sam@X.org " resolves to
  // the same account (and the same new-address budget key) as "sam@x.org".
  coordinatorEmail: z.string().trim().toLowerCase().email().max(320).nullish(),
});

export const assignGroupCoordinatorInputSchema =
  assignGroupCoordinatorInputSchemaBase.refine(
    (d) => !(d.coordinatorHumanId && d.coordinatorEmail),
    {
      message:
        "provide either coordinatorHumanId or coordinatorEmail, not both",
      path: ["coordinatorEmail"],
    },
  );

/**
 * Move a signup into / between / out of (null) a group (FR-005).
 * Owner: any move. Coordinator: pool → own group and own group → pool only.
 */
export const assignSignupToGroupInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  signupId: z.string().uuid(),
  /** Target group; `null` releases the signup back to the general pool. */
  groupId: z.string().uuid().nullable(),
});

/**
 * Broadcast audience selector (FR-009). Mirrors the repo's
 * `VolunteerBroadcastScope` shape so the parsed value can be handed to
 * `listBroadcastRecipients` unchanged. POOL = accepted-but-unassigned.
 */
export const volunteerBroadcastScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ALL") }),
  z.object({ kind: z.literal("ROLE"), roleId: z.string().uuid() }),
  z.object({ kind: z.literal("GROUP"), groupId: z.string().uuid() }),
  z.object({ kind: z.literal("POOL") }),
]);

/**
 * One-way roster announcement (FR-009). `broadcastId` is the optional
 * client-supplied idempotency key — a retry with the same id returns the
 * stored ledger row without re-sending. Subject/body caps mirror the
 * ask title (200) and description (5000) limits.
 */
export const broadcastToRosterInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  askId: z.string().uuid(),
  scope: volunteerBroadcastScopeSchema,
  subject: plainTextRequired(200),
  body: plainTextMultilineRequired(5000),
  broadcastId: z.string().uuid().optional(),
});

/** Broadcast ledger read — owner: all; coordinator: own sends + own group. */
export const listAskBroadcastsInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  askId: z.string().uuid(),
});

/** Per-signup .ics download (FR-012). */
export const exportSignupIcsInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  signupId: z.string().uuid(),
});

/** Get-or-mint the actor's own "my volunteering" feed token (FR-012). */
export const getMyVolunteerIcsFeedTokenInputSchema = z.object({
  actorHumanId: z.string().uuid(),
});

/**
 * Rotate the actor's own feed token — unconditional overwrite; every
 * calendar app subscribed to the old URL breaks immediately.
 */
export const rotateMyVolunteerIcsFeedTokenInputSchema = z.object({
  actorHumanId: z.string().uuid(),
});

/**
 * Public, token-authenticated aggregate feed (FR-012). The token is a
 * 32-byte base64url secret (43 chars) — bounds are sanity caps, not a
 * format contract.
 */
export const exportMyVolunteeringIcsInputSchema = z.object({
  feedToken: z.string().min(16).max(200),
});

// ── Roster cursor pagination ────────────────────────────────────────────────
//
// Both roster reads paginate their signup lists with an opaque keyset cursor
// (value-based `<createdAt ISO>|<id>` minted by the adapter; the coordinator
// view prefixes a group id — see list-coordinator-roster). Page-size bounds
// mirror the offset lists: hard max 200 (the old fixed cap), default 50.

export const ROSTER_PAGE_DEFAULT_LIMIT = 50;
export const ROSTER_PAGE_MAX_LIMIT = 200;

/** Sanity cap on the opaque cursor, not a format contract. */
const rosterCursorSchema = z.string().min(1).max(512);

/** Owner view — whole ask: roles, groups, general pool, fill counts. */
export const listAskRosterInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  askId: z.string().uuid(),
  /** Opaque continuation cursor for the general pool. Null/omitted = page 1. */
  cursor: rosterCursorSchema.nullish(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(ROSTER_PAGE_MAX_LIMIT)
    .default(ROSTER_PAGE_DEFAULT_LIMIT),
});

/**
 * Audience slice for the scoped signup list (FR-005 / FR-007). Mirrors
 * `volunteerBroadcastScopeSchema` minus ROLE — role narrowing is a plain
 * filter (`roleId`), not a trust boundary. ALL = the whole ask (owner
 * only); GROUP = one group's members; POOL = unassigned signups
 * (`groupId: null` in the repo read).
 */
export const listAskSignupsScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ALL") }),
  z.object({ kind: z.literal("GROUP"), groupId: z.string().uuid() }),
  z.object({ kind: z.literal("POOL") }),
]);

/**
 * Scoped signup listing for one ask. Owner: any scope (FR-007 — the whole
 * ask, incl. the PENDING review queue). Coordinator: own GROUP or POOL
 * only (FR-005 pool pulls) — enforced in the use case. `status` is a
 * single value (the repo primitive filters one status per read; callers
 * needing several statuses issue parallel queries). On POOL it defaults
 * to APPROVED — the general pool — in the use case.
 */
export const listAskSignupsInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  askId: z.string().uuid(),
  scope: listAskSignupsScopeSchema,
  roleId: z.string().uuid().optional(),
  status: z
    .enum([
      "PENDING",
      "APPROVED",
      "REJECTED",
      "WITHDRAWN",
      "CHECKED_IN",
      "NO_SHOW",
    ])
    .optional(),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).optional(),
});

/** Coordinator view — ONLY the actor's group(s) for the ask (NFR-003). */
export const listCoordinatorRosterInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  askId: z.string().uuid(),
  /**
   * Opaque continuation cursor over the coordinator's groups' members
   * (sequential across groups). Null/omitted = page 1.
   */
  cursor: rosterCursorSchema.nullish(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(ROSTER_PAGE_MAX_LIMIT)
    .default(ROSTER_PAGE_DEFAULT_LIMIT),
});

export type VolunteerBroadcastScopeInput = z.infer<
  typeof volunteerBroadcastScopeSchema
>;
export type BroadcastToRosterUseCaseInput = z.infer<
  typeof broadcastToRosterInputSchema
>;
export type ListAskBroadcastsUseCaseInput = z.infer<
  typeof listAskBroadcastsInputSchema
>;
export type ExportSignupIcsUseCaseInput = z.infer<
  typeof exportSignupIcsInputSchema
>;
export type GetMyVolunteerIcsFeedTokenUseCaseInput = z.infer<
  typeof getMyVolunteerIcsFeedTokenInputSchema
>;
export type RotateMyVolunteerIcsFeedTokenUseCaseInput = z.infer<
  typeof rotateMyVolunteerIcsFeedTokenInputSchema
>;
export type ExportMyVolunteeringIcsUseCaseInput = z.infer<
  typeof exportMyVolunteeringIcsInputSchema
>;
export type AssignSignupToGroupUseCaseInput = z.infer<
  typeof assignSignupToGroupInputSchema
>;
export type ListAskRosterUseCaseInput = z.infer<
  typeof listAskRosterInputSchema
>;
export type ListCoordinatorRosterUseCaseInput = z.infer<
  typeof listCoordinatorRosterInputSchema
>;
export type ListAskSignupsScopeInput = z.infer<
  typeof listAskSignupsScopeSchema
>;
export type ListAskSignupsUseCaseInput = z.infer<
  typeof listAskSignupsInputSchema
>;

export type CreateVolunteerAskUseCaseInput = z.infer<
  typeof createVolunteerAskInputSchema
>;
export type UpdateVolunteerAskUseCaseInput = z.infer<
  typeof updateVolunteerAskInputSchema
>;
export type AddVolunteerAskRoleUseCaseInput = z.infer<
  typeof addVolunteerAskRoleInputSchema
>;
export type UpdateVolunteerAskRoleUseCaseInput = z.infer<
  typeof updateVolunteerAskRoleInputSchema
>;
export type CreateVolunteerGroupUseCaseInput = z.infer<
  typeof createVolunteerGroupInputSchema
>;
export type AssignGroupCoordinatorUseCaseInput = z.infer<
  typeof assignGroupCoordinatorInputSchema
>;

// ── Volunteer scan tokens & check-in resolution ─────────────────────────────

export const mintVolunteerScanTokenInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  signupId: z.string().uuid(),
  kind: z.enum(["short", "print"]).default("short"),
});

export const resolveVolunteerSignupByTokenInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  eventId: z.string().uuid(),
  token: z.string().min(1),
});

export const searchVolunteerSignupsForCheckInInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  eventId: z.string().uuid(),
  query: z.string().trim().min(1).max(200),
  limit: z.number().int().min(1).max(50).default(20),
});

export const getVolunteerContextForTicketScanInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  eventId: z.string().uuid(),
  humanId: z.string().uuid(),
});

export type MintVolunteerScanTokenUseCaseInput = z.infer<
  typeof mintVolunteerScanTokenInputSchema
>;
export type ResolveVolunteerSignupByTokenUseCaseInput = z.infer<
  typeof resolveVolunteerSignupByTokenInputSchema
>;
export type SearchVolunteerSignupsForCheckInUseCaseInput = z.infer<
  typeof searchVolunteerSignupsForCheckInInputSchema
>;
export type GetVolunteerContextForTicketScanUseCaseInput = z.infer<
  typeof getVolunteerContextForTicketScanInputSchema
>;

// ── Org-wide volunteer hours summary ────────────────────────────────────────

/**
 * Cross-event hours aggregate for an org (Gap 7). `from`/`to` bound the
 * activity instant (shift start, falling back to signup `createdAt` for
 * shiftless signups) — `from` inclusive, `to` exclusive. An inverted
 * range is not rejected; it simply matches nothing. Kept as a plain
 * object schema (no `.refine`) so the transport can `.omit()` the
 * actor id.
 */
export const getOrgVolunteerHoursSummaryInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  orgId: z.string().uuid(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  /**
   * When true, only accepted signups (APPROVED | CHECKED_IN) contribute —
   * the recognition / grant-reporting view. Default (false / omitted)
   * includes all statuses so totals reconcile with per-event exports.
   */
  acceptedOnly: z.boolean().optional(),
});

export type GetOrgVolunteerHoursSummaryUseCaseInput = z.infer<
  typeof getOrgVolunteerHoursSummaryInputSchema
>;

// ── Volunteer comp-ticket rewards ───────────────────────────────────────────
//
// See docs/specs/2026-06-29/completed/volunteer-comp-tickets.spec.yaml (+ 2026-07-01
// resolutions: COMP-only — no DISCOUNT; EVENT-subject asks only). A reward is a
// $0 comp ticket granted to a volunteer when their signup hits a trigger.

export const volunteerRewardTriggerSchema = z.enum([
  "ON_APPROVAL",
  "ON_CHECK_IN",
]);

/**
 * Configure the comp reward attached to (askId, roleId?). `roleId` null /
 * omitted addresses the whole-ask reward; a value addresses the role-specific
 * one. `ticketTypeId` must belong to the ask's EVENT subject (enforced in the
 * use case). `maxGrants` is the optional budget cap (null = uncapped).
 */
export const setVolunteerRewardInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  askId: z.string().uuid(),
  roleId: z.string().uuid().nullish(),
  ticketTypeId: z.string().uuid(),
  trigger: volunteerRewardTriggerSchema.optional(),
  maxGrants: z.number().int().min(1).nullish(),
});

/**
 * Grant the comp for a signup that reached the trigger. NOT client-callable —
 * fired system-side by the review / check-in triggers. No actor RBAC: the
 * trigger already authorized the state change that fired it.
 */
export const grantVolunteerRewardInputSchema = z.object({
  signupId: z.string().uuid(),
  rewardId: z.string().uuid(),
  trigger: volunteerRewardTriggerSchema,
});

/**
 * Void an unused grant and return its budget slot. `actorHumanId` is present
 * for manual admin revokes and absent for system-fired ones (withdraw).
 */
export const revokeVolunteerRewardInputSchema = z.object({
  actorHumanId: z.string().uuid().nullish(),
  grantId: z.string().uuid(),
  reason: plainTextRequired(200),
});

/** Owner / finance reward ledger for an ask. */
export const listAskRewardLedgerInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  askId: z.string().uuid(),
});

/**
 * Owner / finance list of the rewards CONFIGURED on an ask (config form +
 * status view). Enumerates every reward including zero-grant and inactive
 * ones — the ledger derives its summary from grants, so a fresh reward would
 * otherwise be invisible.
 */
export const listAskRewardsInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  askId: z.string().uuid(),
});

export type SetVolunteerRewardUseCaseInput = z.infer<
  typeof setVolunteerRewardInputSchema
>;
export type GrantVolunteerRewardUseCaseInput = z.infer<
  typeof grantVolunteerRewardInputSchema
>;
export type RevokeVolunteerRewardUseCaseInput = z.infer<
  typeof revokeVolunteerRewardInputSchema
>;
export type ListAskRewardLedgerUseCaseInput = z.infer<
  typeof listAskRewardLedgerInputSchema
>;
export type ListAskRewardsUseCaseInput = z.infer<
  typeof listAskRewardsInputSchema
>;

// ── Shift occurrences + claims (standing asks) ──────────────────────────────
//
// generic-volunteer-shifts-occurrences spec, phase A (FR-001..FR-005).
// Occurrence windows use the same base/refined split as the event shift
// schemas so the transport can compose on the plain object.

/**
 * Hard cap on one occurrence's window. A real volunteer shift is hours, not
 * days — 24h covers overnight slots while keeping the duration-derived
 * `hoursWorked` far inside the Decimal(5,2) column bound (999.99). Enforced
 * at create (refine below) AND on the merged window at update (in-use-case,
 * since the patch schema can carry one bound alone).
 */
export const VOLUNTEER_OCCURRENCE_MAX_WINDOW_MS = 24 * 60 * 60 * 1000;

export const createShiftOccurrenceInputSchemaBase = z.object({
  actorHumanId: z.string().uuid(),
  askId: z.string().uuid(),
  roleId: z.string().uuid(),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  capacity: z.number().int().min(1).nullish(),
  notes: plainTextMultilineOptional(2000).nullish(),
});

export const createShiftOccurrenceInputSchema =
  createShiftOccurrenceInputSchemaBase
    .refine((d) => d.endsAt > d.startsAt, {
      message: "endsAt must be after startsAt",
      path: ["endsAt"],
    })
    .refine(
      (d) =>
        d.endsAt.getTime() - d.startsAt.getTime() <=
        VOLUNTEER_OCCURRENCE_MAX_WINDOW_MS,
      { message: "window_too_long", path: ["endsAt"] },
    );

/**
 * Partial time patch: when only one bound arrives, the use case validates
 * the MERGED window against the stored row (same in-use-case pattern as
 * update-volunteer-ask's window).
 */
export const updateShiftOccurrenceInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  occurrenceId: z.string().uuid(),
  startsAt: z.coerce.date().optional(),
  endsAt: z.coerce.date().optional(),
  capacity: z.number().int().min(1).nullish(),
  notes: plainTextMultilineOptional(2000).nullish(),
});

export const cancelShiftOccurrenceInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  occurrenceId: z.string().uuid(),
});

export const listAskOccurrencesInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  askId: z.string().uuid(),
  roleId: z.string().uuid().optional(),
  /** Omitted = SCHEDULED and CANCELLED both (owner sees the full ledger). */
  status: z.enum(["SCHEDULED", "CANCELLED"]).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

export const claimOccurrenceInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  occurrenceId: z.string().uuid(),
});

export const withdrawOccurrenceClaimInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  claimId: z.string().uuid(),
});

export const assignOccurrenceClaimInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  occurrenceId: z.string().uuid(),
  signupId: z.string().uuid(),
});

export const checkInOccurrenceClaimInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  claimId: z.string().uuid(),
  /** Override the duration-derived hours (0 allowed = "showed, sent home"). */
  hoursOverride: z.number().min(0).max(999.99).nullish(),
});

export const listOccurrenceRosterInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  occurrenceId: z.string().uuid(),
});

export const getPublicAskScheduleInputSchema = z
  .object({
    askId: z.string().uuid(),
  })
  .strict();

export type CreateShiftOccurrenceUseCaseInput = z.infer<
  typeof createShiftOccurrenceInputSchema
>;
export type UpdateShiftOccurrenceUseCaseInput = z.infer<
  typeof updateShiftOccurrenceInputSchema
>;
export type CancelShiftOccurrenceUseCaseInput = z.infer<
  typeof cancelShiftOccurrenceInputSchema
>;
export type ListAskOccurrencesUseCaseInput = z.infer<
  typeof listAskOccurrencesInputSchema
>;
export type ClaimOccurrenceUseCaseInput = z.infer<
  typeof claimOccurrenceInputSchema
>;
export type WithdrawOccurrenceClaimUseCaseInput = z.infer<
  typeof withdrawOccurrenceClaimInputSchema
>;
export type AssignOccurrenceClaimUseCaseInput = z.infer<
  typeof assignOccurrenceClaimInputSchema
>;
export type CheckInOccurrenceClaimUseCaseInput = z.infer<
  typeof checkInOccurrenceClaimInputSchema
>;
export type ListOccurrenceRosterUseCaseInput = z.infer<
  typeof listOccurrenceRosterInputSchema
>;
export type GetPublicAskScheduleUseCaseInput = z.infer<
  typeof getPublicAskScheduleInputSchema
>;
