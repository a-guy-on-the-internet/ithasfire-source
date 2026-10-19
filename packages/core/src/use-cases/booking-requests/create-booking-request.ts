import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { RateLimitPort, RateLimitResult } from "@th/ports/rate-limit";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  CreateBookingRequestActInput,
  CreateBookingRequestRecordInput,
  ToVenueBookingRequestRecord,
} from "@th/ports/repos/booking-requests";
import type {
  CalendarRow,
  CalendarWithSpacesRow,
} from "@th/ports/repos/calendars";
import type { PerformerOwnerType } from "@th/ports/repos/performer-profiles";
import type { PlaceRecord } from "@th/ports/repos/places";

import {
  BOOKING_SET_LENGTH_PRESETS,
  BOOKING_FEE_AMOUNT_MAX_CENTS,
  BOOKING_FEE_DEFAULT_CURRENCY,
  BOOKING_TAG_MAX_COUNT,
  BOOKING_TAG_MAX_LENGTH,
  DAY_MS,
} from "./constants";
import { parseInput } from "../../lib/io";
import {
  plainTextOptional,
  sanitizePlainText,
} from "../../lib/sanitize-plain-text";
import { isPerformerEnabled } from "../../lib/performer-mode";
import { ORG_EDIT_ROLES, requireOwnerAccess } from "../../lib/rbac";
import { resolveTimeZone, toLocalParts } from "../../lib/venue-local-time";
import { toPerformerOwnerType } from "../performers/set-performer-mode";
import { isClaimedPlace } from "../places/_shared/claim-eligibility";
import { assertBookingStandardsMet } from "../booking-standards/enforce-booking-standards";
import { fail } from "@th/errors";

import { findUnavailableBookingDates } from "./_shared/validate-booking-dates";
import { appendBookingSystemEntry } from "./messages/_shared/system-entries";
import {
  bookingActNameSchema,
  bookingPitchFieldsSchema,
  FEE_ASK_REFINE_PARAMS,
  hasConsistentFeeAsk,
} from "./_shared/pitch-schema";
import {
  isPerformerStatsEligible,
  toVerifiedStatsSnapshot,
} from "../../lib/performer-stats";
import type { VerifiedStatsSnapshot } from "@th/types/repos/human-stats";
import type { NotifyBookingRequestReceivedFn } from "./notify-booking-request-received";
import type { NotifyBookingLineupInvitedFn } from "./notify-booking-lineup-invited";
import {
  BOOKING_BILL_ACT_NAME_MAX_LENGTH,
  bookingBillSchema,
  type BookingBillInput,
} from "./_shared/bill-schema";
import {
  resolveTaggableGroups,
  resolveTaggableHumans,
} from "./_shared/taggable-humans";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Booking requests auto-EXPIRE this many days after creation (FR-003). */
export const BOOKING_REQUEST_TTL_DAYS = 14;

/** `purpose` column bound (VarChar(200)). */
export const BOOKING_PURPOSE_MAX_LENGTH = 200;

/**
 * Longest RENT/USE window a single request may ask for. Not a product rule
 * (the spec says "one date per booking; a run concept is wanted, not here")
 * — an input bound, like `.max()` on a string, so a crafted payload cannot
 * ask for a room until 2099 and have it land in the venue's inbox as a
 * legitimate ask.
 */
export const BOOKING_WINDOW_MAX_DAYS = 31;

/**
 * A RENT/USE window may start this far in the past and still be accepted —
 * clock skew and "the meeting starts in ten minutes" slack, not a policy.
 * Anything older is a request for a room that is already gone.
 */
export const BOOKING_WINDOW_PAST_GRACE_MS = 60 * 60 * 1000;

/** Sanity bound on `expectedAttendance` (the pitch's `expectedDraw` uses 1e6). */
const EXPECTED_ATTENDANCE_MAX = 1_000_000;

/**
 * Tag budget (lineup-booking-requests v2, FR-007): how many acts one SENDER
 * pair may tag onto bills per rolling day — people and, since v3 L17, groups
 * alike: a tagged group's invite reaches every editor of it. Tag spam — blasting invites at
 * well-known artists for clout — is the spec's named risk; every tag is a
 * notification to someone who did not ask for it, so the sender's reach is
 * what gets capped.
 */
export const BOOKING_LINEUP_TAG_DAILY_MAX = 30;
export const BOOKING_LINEUP_TAG_DAILY_WINDOW_SECONDS = 24 * 60 * 60;

/**
 * Rate-limit bucket for the tag budget, keyed by the SENDER pair (stored
 * vocabulary: "human" | "organization") — not the actor: an org's budget is
 * the org's, whichever member presses send. Known looseness (deferred): a
 * human with edit roles in N orgs can therefore tag 30 × (N + 1) per day.
 */
export function bookingLineupTagBudgetKey(
  ownerType: PerformerOwnerType,
  ownerId: string,
): string {
  return `bookingRequests:lineupTags:${ownerType}:${ownerId}:daily`;
}

// Re-exported for back-compat. These live in a dependency-free leaf module
// (`./constants`) so the web client can import them without pulling this
// module's `sanitize-html`/zod schema graph into the public-page bundle.
export {
  BOOKING_SET_LENGTH_PRESETS,
  BOOKING_FEE_AMOUNT_MAX_CENTS,
  BOOKING_FEE_DEFAULT_CURRENCY,
};

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pre-refine base object. The transport router derives its input from this
 * (`.omit({ actorHumanId: true })` — `.omit()` can't be applied after the
 * cross-field `.refine()` below), so the field list lives in one place. The use
 * case re-validates the full schema (refine included).
 *
 * The pitch-field rules (message, dates, fee ask, typed links, …) live in the
 * shared `bookingPitchFieldsSchema` fragment, reused verbatim by the anonymous
 * embed inquiry (`embeds/create-booking-inquiry.ts`).
 */
/**
 * One triage tag (venue-hierarchy FR-008): sanitized (house helper) BEFORE
 * the length cap. Empty-after-sanitize values are allowed HERE and dropped by
 * `normalizeBookingTags` below — rejecting them would make a stray "  " in a
 * tag chip fail the whole submission.
 */
const bookingTagSchema = z
  .string()
  .transform((value) => sanitizePlainText(value).trim())
  .pipe(z.string().max(BOOKING_TAG_MAX_LENGTH));

/**
 * Drop empties + dedupe (first occurrence wins), truncating at the count cap.
 * The schema's `.max(BOOKING_TAG_MAX_COUNT)` already bounds the RAW array, so
 * post-schema the truncation can never actually bind (dropping only shrinks
 * the list) — it is a defensive bound for non-schema callers, not the
 * enforcement point.
 */
export function normalizeBookingTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const tag of tags) {
    if (tag.length === 0 || seen.has(tag)) continue;
    seen.add(tag);
    cleaned.push(tag);
    if (cleaned.length >= BOOKING_TAG_MAX_COUNT) break;
  }
  return cleaned;
}

/** What the request asks the venue for (venue-confirmation spec). */
export const bookingIntentSchema = z.enum(["PERFORM", "RENT", "USE"]);
export type BookingIntentInput = z.infer<typeof bookingIntentSchema>;

export const createBookingRequestBaseSchema = bookingPitchFieldsSchema
  .extend({
    actorHumanId: z.uuid(),
    performerOwnerType: z.enum(["human", "org"]),
    performerOwnerId: z.uuid(),
    placeId: z.uuid(),
    /**
     * Named-calendar routing (venue-hierarchy FR-008). Optional: when absent
     * the request routes to the place's DEFAULT calendar; when present it
     * must belong to the SAME place (asserted before any write — a
     * cross-place id surfaces as CALENDAR_NOT_FOUND).
     */
    calendarId: z.uuid().optional(),
    /** Triage labels (FR-008) — sanitized per-tag, capped, empties dropped. */
    tags: z.array(bookingTagSchema).max(BOOKING_TAG_MAX_COUNT).optional(),
    // ── Expanded pitch fields (2026-07-11) ──────────────────────────────────
    actName: bookingActNameSchema.optional(),
    contactPhone: z
      .string()
      .trim()
      .regex(/^[+0-9 ()\-.]{5,30}$/)
      .optional(),
    /**
     * Opt-in to attach a server-sourced verified-stats snapshot to this pitch
     * (FR-009). Only honored for HUMAN senders that meet the eligibility
     * threshold; the snapshot itself is built server-side from HumanStats and
     * never trusts any client-supplied number.
     */
    includeVerifiedStats: z.boolean().optional(),
    // ── Intent + the room + the window (venue-confirmation spec) ────────────
    /**
     * PERFORM (today's pitch, the default) | RENT | USE. Picks the FORM
     * VARIANT: PERFORM keeps `message` + `preferredDates` required (the
     * cross-field refine below); RENT/USE require a window and a one-line
     * `purpose`, and `message` / `preferredDates` become optional (derived
     * from the purpose / window when absent, so every reader of those
     * columns keeps its non-empty guarantee).
     */
    intent: bookingIntentSchema.default("PERFORM"),
    /**
     * The room. OPTIONAL for every intent (owner ruling 2026-09-22 — see
     * `refineIntentShape`). When supplied it must be one of the ROUTED
     * calendar's ACTIVE spaces — asserted against the place's own calendar
     * list, so a foreign space id is indistinguishable from an unknown one.
     */
    spaceId: z.uuid().optional(),
    /** RENT/USE window (instants). `requestedEndsAt` must be after the start. */
    requestedStartsAt: z.coerce.date().optional(),
    requestedEndsAt: z.coerce.date().optional(),
    /** "What is it" — one line, sanitized BEFORE the length cap. */
    purpose: plainTextOptional(BOOKING_PURPOSE_MAX_LENGTH).optional(),
    expectedAttendance: z
      .number()
      .int()
      .min(1)
      .max(EXPECTED_ATTENDANCE_MAX)
      .optional(),
    /**
     * The bill (lineup-booking-requests v2, FR-002): `includeSelf` puts the
     * SENDER's own act on it; `acts` are tagged platform acts (a person, or
     * since v3 L17 a group) and free-text acts, in order, each with a role
     * (v3 L13). PERFORM only — RENT/USE with a bill is BILL_NOT_ALLOWED (a
     * typed refusal in the use case, not a schema issue). An empty bill is
     * legal (v3 L12).
     *
     * OMITTED = the pre-bill contract, unchanged: the sender pitches as the
     * act (`includeSelf: true`, no other acts). Every client that predates
     * the bill keeps working and every new PERFORM request still gets its
     * SELF row.
     */
    bill: bookingBillSchema.optional(),
    // NOTE — `visibilityHint` (public | private, for the eventual event) is
    // NOT accepted in v1. The request row has no column for it and no
    // structured message-adjacent field to park it in (tags are venue-side
    // triage labels; verifiedStatsSnapshot is the stats blob), so it was
    // dropped rather than smuggled into free text. The event's visibility is
    // set on the event when it is minted.
  })
  .extend({
    // Loosened from the pitch fragment for the RENT/USE variants — the rule
    // that they are REQUIRED for PERFORM moves into `refineIntentShape`, so
    // the PERFORM contract is unchanged.
    message: bookingPitchFieldsSchema.shape.message.optional(),
    preferredDates: bookingPitchFieldsSchema.shape.preferredDates.optional(),
  })
  .strict();

type IntentShape = {
  intent: BookingIntentInput;
  message?: string;
  preferredDates?: string[];
  spaceId?: string;
  requestedStartsAt?: Date;
  requestedEndsAt?: Date;
  purpose?: string;
};

/**
 * Per-intent shape (spec "Intents & who asks"): PERFORM is today's pitch;
 * RENT/USE are calendar → window → purpose. Pure-shape failures land here as
 * `invalid_input` issues; the repo-dependent checks (calendar accepts the
 * intent, a supplied space is on the calendar) live in the use case.
 *
 * NO SPACE IS REQUIRED, for any intent (owner ruling 2026-09-22, extending
 * the 2026-08-31 holds ruling documented atop
 * apps/web/src/components/bookings/HoldDatePicker.tsx). A RENT/USE request
 * routes to a CALENDAR and a WINDOW; nothing downstream reads a room off the
 * request, and the accept/mint path already mints spacelessly rather than
 * refusing. The room is chosen later, at accept/confirm, on the draft event,
 * where it is real. A `spaceId` stays LEGAL and is still checked against the
 * routed calendar when one IS supplied — it simply is not demanded.
 */
function refineIntentShape(value: IntentShape, ctx: z.RefinementCtx): void {
  if (value.intent === "PERFORM") {
    if (value.message === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "message_required_for_perform",
        path: ["message"],
      });
    }
    if (value.preferredDates === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "preferred_dates_required_for_perform",
        path: ["preferredDates"],
      });
    }
    return;
  }

  // RENT | USE
  if (value.purpose === undefined || value.purpose.length === 0) {
    ctx.addIssue({
      code: "custom",
      message: "purpose_required_for_intent",
      path: ["purpose"],
    });
  }
  if (value.requestedStartsAt === undefined) {
    ctx.addIssue({
      code: "custom",
      message: "window_required_for_intent",
      path: ["requestedStartsAt"],
    });
  }
  if (value.requestedEndsAt === undefined) {
    ctx.addIssue({
      code: "custom",
      message: "window_required_for_intent",
      path: ["requestedEndsAt"],
    });
  }
  if (value.requestedStartsAt && value.requestedEndsAt) {
    const span =
      value.requestedEndsAt.getTime() - value.requestedStartsAt.getTime();
    if (span <= 0) {
      ctx.addIssue({
        code: "custom",
        message: "window_end_before_start",
        path: ["requestedEndsAt"],
      });
    } else if (span > BOOKING_WINDOW_MAX_DAYS * DAY_MS) {
      ctx.addIssue({
        code: "custom",
        message: "window_too_long",
        path: ["requestedEndsAt"],
      });
    }
  }
}

export const createBookingRequestInputSchema = createBookingRequestBaseSchema
  .refine(hasConsistentFeeAsk, FEE_ASK_REFINE_PARAMS)
  .superRefine(refineIntentShape);

export const createBookingRequestOutputSchema = z
  .object({
    bookingRequestId: z.uuid(),
  })
  .strict();

/**
 * What transport puts on the wire. Identical to the output since the claim
 * invite intent went with parking (amendment 2026-09-25); kept as its own
 * export so transport and clients keep one name for the wire shape.
 */
export const createBookingRequestWireOutputSchema = createBookingRequestOutputSchema;

export type CreateBookingRequestInput = z.infer<
  typeof createBookingRequestInputSchema
>;
export type CreateBookingRequestOutput = z.infer<
  typeof createBookingRequestOutputSchema
>;
export type CreateBookingRequestWireOutput = z.infer<
  typeof createBookingRequestWireOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type CreateBookingRequestDeps = {
  repos: Pick<
    Repos,
    | "tx"
    | "bookingRequests"
    | "performerProfiles"
    | "places"
    | "humans"
    | "humanStats"
    | "authz"
    | "audit"
    | "events"
    // Consumed inside the create tx to open the booking timeline.
    | "bookingRequestMessages"
    // Calendar routing (venue-hierarchy FR-008), the calendar-scoped
    // availability gate (FR-007), and the intent / space checks
    // (venue-confirmation spec) — `placeAvailability` is no longer touched.
    | "calendars"
    // Taggable check for the bill's TAGGED acts (a PUBLIC human page; an
    // ACTIVE group, v3 L17) — read only when the bill tags someone.
    | "entityPages"
    | "organizations"
    // The venue's booking standards for the routed calendar (venue-booking-
    // standards spec, FR-006) — read once, before any write.
    | "bookingStandards"
  >;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Optional tag budget (FR-007, see BOOKING_LINEUP_TAG_DAILY_MAX). Consumed
   * INSIDE the use case, last before the write, so a request that fails any
   * gate never burns the sender's budget. Absent = no budget (tests and
   * composition roots that have not threaded one); fails OPEN when the
   * limiter itself throws.
   */
  rateLimit?: Pick<RateLimitPort, "consume"> | null;
  /**
   * Optional post-commit "you're on a bill" fan-out (FR-003), composed by the
   * transport around `notifyBookingLineupInvited`. Called once per request
   * with every TAGGED human, AFTER the transaction committed; a deliberate
   * swallow — a throwing notifier never fails the submission.
   */
  notifyBookingLineupInvited?: NotifyBookingLineupInvitedFn;
  /**
   * Optional post-commit venue notification (booking-request-embed-button
   * FR-008): in-app + email + push to the place's owners via
   * `notifyBookingRequestReceived`, composed by the transport/composition
   * layer. Optional so existing callers/tests keep working; when present it
   * runs AFTER the transaction committed and is a deliberate swallow
   * (NFR-004) — a throwing notifier never fails the submission.
   */
  notifyBookingRequestReceived?: NotifyBookingRequestReceivedFn;
  /**
   * Best-effort reporter for the notification swallow branch (ReporterPort
   * convention) — without it a broken notifier would be invisible in prod.
   * Also the standards read's degrade branch (a failed read fails OPEN).
   */
  reportError?: ReporterPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Anyone with an account (a Human, or an Org they hold edit roles in) asks a
 * venue for a room (spec FR-001; intents per docs/specs/2026-08-27).
 *
 * Checks, in order:
 * 0. The bill (lineup v2, FR-002) — RENT/USE carry none (BILL_NOT_ALLOWED);
 *    no tag is a duplicate or the sender themselves (ACT_NOT_TAGGABLE). No
 *    bill on a PERFORM request = the sender is the act (`includeSelf:
 *    true`). An EMPTY bill is allowed (v3 L12: the request names only the
 *    sender; a venue whose BILL standard is REQUIRED still refuses it, 5b).
 * 1. Sender control — self for a human sender, org EDIT roles for an org sender.
 * 2. Performer mode — PERFORM ONLY, and only when the sender's own act is on
 *    the bill (D3: it gates the SELF row, not sending): the sender entity
 *    must have an enabled PerformerProfile. RENT/USE are open to any human
 *    or org, and so is a PERFORM bill of other acts.
 * 3. Place gate — must exist and be CLAIMED (`isClaimedPlace`; amendment
 *    2026-09-25: an unclaimed venue takes no requests →
 *    PLACE_NOT_TAKING_REQUESTS). Checked FIRST, before the bill, the sender
 *    and the standards, and again by the shared gate walk. Then VERIFIED and
 *    opted in (`acceptsBookingRequests`), and a PERFORM request must fit the
 *    venue's declared hours. Past dates are refused on every path.
 * 4. Calendar routing + intent — the routed calendar (explicit, else the
 *    place's default) must accept the intent; RENT/USE need a space that is
 *    on that calendar.
 * 5. One open (PENDING | VIEWED) request per (sender, place).
 * 5b. The venue's booking standards (venue-booking-standards spec, FR-006):
 *    REQUIRED items for the routed calendar + intent the payload does not
 *    satisfy → STANDARDS_UNMET `{ items: [{ field, label }] }`. Fails OPEN
 *    when the standards read degrades (reported by the loader).
 * 6. Tagged acts are TAGGABLE (ACT_NOT_TAGGABLE `not_taggable`) — people
 *    with a PUBLIC page, groups that are ACTIVE (v3 L17) — then the sender's
 *    daily tag budget (RATE_LIMITED `lineup_tag_budget`, groups count too) —
 *    last, so a refused request never spends it.
 *
 * The request, its bill rows, the ledger entry and the audit row commit in
 * one transaction; tagged artists are notified after it (FR-003).
 *
 * Genre default: when the sender is a human and `genre` is omitted, it is
 * prefilled from the human's first `genreTags` entry (2026-04-14 FR-006).
 * Expiry is stamped at `now + BOOKING_REQUEST_TTL_DAYS`.
 */
export async function createBookingRequest(
  deps: CreateBookingRequestDeps,
  rawInput: unknown,
): Promise<CreateBookingRequestOutput> {
  const input = parseInput(createBookingRequestInputSchema, rawInput);

  // An unclaimed venue takes no requests (amendment 2026-09-25). Refused
  // FIRST — before the bill, the sender check, the standards and any
  // notification — so a pitch to a venue nobody holds fails with the one
  // reason that matters. Whether a place is claimed is public (its page
  // offers "Claim this venue"), so running this before the sender check
  // leaks nothing. The gate walk below re-checks it for every entry path.
  assertPlaceTakesRequests(
    await deps.repos.places.getById(input.placeId),
  );

  const ownerType = toPerformerOwnerType(input.performerOwnerType);

  // 0. The bill's typed shape rules (lineup v2, FR-002) — pure input, no
  // reads: RENT/USE never carry one, and a tag is never a duplicate or the
  // sender themselves. Null = no bill applies (RENT/USE). An empty PERFORM
  // bill passes (v3 L12).
  const bill = resolveBill(input.intent, input.bill);
  const { humanIds: taggedHumanIds, orgIds: taggedOrgIds } = bill
    ? assertBillTags(bill, {
        ownerType,
        ownerId: input.performerOwnerId,
      })
    : { humanIds: [], orgIds: [] };
  const tagCount = taggedHumanIds.length + taggedOrgIds.length;

  // 1. Sender control.
  await requireOwnerAccess({
    repos: deps.repos,
    ownerType: input.performerOwnerType === "human" ? "HUMAN" : "ORGANIZATION",
    ownerId: input.performerOwnerId,
    actorHumanId: input.actorHumanId,
    roles: ORG_EDIT_ROLES,
  });

  // 2..5 — the shared gate walk (performer mode, place + claimed, hours,
  // calendar routing + intent, one open request per sender×place). Read-only
  // and BEFORE the transaction: nothing is written until every gate passed.
  const { place, calendar } = await runBookingRequestGates(
    deps.repos,
    { now: () => deps.clock.now(), logger: deps.logger },
    {
      ownerType,
      ownerId: input.performerOwnerId,
      intent: input.intent,
      placeId: input.placeId,
      calendarId: input.calendarId,
      spaceId: input.spaceId,
      preferredDates: input.preferredDates,
      requestedStartsAt: input.requestedStartsAt,
      performerGate: "enforce",
      // D3: performer mode gates the SELF row, not the sender. A promoter
      // who is not on the bill needs none.
      selfOnBill: bill?.includeSelf,
    },
  );

  // 5b. The venue's booking standards (FR-006) — for the calendar the walk
  // just ROUTED to (null = the place has none: place → platform), and the
  // PARSED payload, which is what the form's live ticks evaluate too (the
  // built payload, never raw text). Read-only, before the taggable reads,
  // the tag budget and the transaction, so a refused pitch spends nothing.
  // Deliberately here and NOT in `runBookingRequestGates`: that walk is
  // shared with the event-first and legacy-migration paths, which are not
  // pitches (see create-booking-request-from-event.ts).
  //
  // BILL is judged on `input.bill`, never the defaulted `bill` above: no
  // bill (the pre-bill contract) means the sender alone, which never meets
  // a REQUIRED bill ("≥ 1 act besides the sender").
  await assertBookingStandardsMet(
    {
      repos: deps.repos,
      logger: deps.logger,
      reportError: deps.reportError,
    },
    {
      place,
      calendarId: calendar?.id ?? null,
      intent: input.intent,
      payload: input,
    },
  );

  // 2b. Every tagged act must be TAGGABLE (FR-002 / v3 L17: what the admin
  // search surfaces — see `_shared/taggable-humans.ts`). Read-only, batched,
  // before the transaction. Groups are read only when the bill tags one.
  const [taggable, taggableGroups] = await Promise.all([
    taggedHumanIds.length > 0
      ? resolveTaggableHumans(deps.repos, taggedHumanIds)
      : new Map<string, { displayName: string | null }>(),
    taggedOrgIds.length > 0
      ? resolveTaggableGroups(deps.repos, taggedOrgIds)
      : new Map<string, { displayName: string | null }>(),
  ]);
  for (const humanId of taggedHumanIds) {
    if (!taggable.has(humanId)) {
      throw fail("ACT_NOT_TAGGABLE", {
        meta: { reason: "not_taggable", humanId },
      });
    }
  }
  for (const orgId of taggedOrgIds) {
    if (!taggableGroups.has(orgId)) {
      throw fail("ACT_NOT_TAGGABLE", {
        meta: { reason: "not_taggable", orgId },
      });
    }
  }

  // Genre prefill: human senders default to their first genre tag.
  let genre = input.genre ?? null;
  if (genre === null && ownerType === "human") {
    const human = await deps.repos.humans.getById(input.performerOwnerId);
    genre = human?.genreTags[0] ?? null;
  }

  // Verified-stats snapshot (FR-009): HUMAN senders only, gated on the shared
  // eligibility threshold. Built entirely server-side from the sender's own
  // HumanStats aggregate — never from client input. Independent of whether the
  // public `stats` block is visible.
  let verifiedStatsSnapshot: VerifiedStatsSnapshot | null = null;
  if (input.includeVerifiedStats && ownerType === "human") {
    const stats = await deps.repos.humanStats.findByHumanId(
      input.performerOwnerId,
    );
    if (stats && isPerformerStatsEligible(stats)) {
      verifiedStatsSnapshot = toVerifiedStatsSnapshot(stats);
    }
  }

  const now = deps.clock.now();

  // Snapshot the fee currency at create time. Venue-level currency isn't
  // modeled, so we store the platform base — only meaningful when an amount is
  // present, and null otherwise.
  const feeCurrency =
    input.feeAmountCents !== undefined ? BOOKING_FEE_DEFAULT_CURRENCY : null;

  const tags = normalizeBookingTags(input.tags ?? []);

  // FR-004: `actName` stays the request's display name. With the sender on
  // the bill it is exactly what it always was (the pitch's own, else null —
  // readers resolve the sender). Without them it defaults to the first
  // FREE-TEXT act's name — NEVER a tagged human's. A TAGGED act is PENDING
  // until the artist answers, and `actName` is what the venue is told "wants
  // to play" (the received notification and the inbox row read it): naming a
  // tagged artist there would put a non-consenting artist's name in front of
  // the venue, and keep it there after they decline (NFR-002). No free-text
  // act → null, and readers name the sender (the organizer) instead.
  const actName =
    input.actName ??
    (bill && !bill.includeSelf ? firstExternalActName(bill) : null);

  // The bill's rows, in bill order: SELF first (0 = headliner by default),
  // then the acts as given. Undefined for RENT/USE — they carry no bill.
  const actRows = bill ? buildBillActRows(bill, now) : undefined;

  // RENT/USE derivations. `message` and `preferredDates` are NOT NULL columns
  // every downstream reader (inbox, pitch seed, holds) treats as populated,
  // so the variant that does not collect them fills them from what it does
  // collect: the one-line purpose, and the window's start as a place-local
  // day. PERFORM writes exactly what it always wrote.
  const message = input.message ?? input.purpose ?? "";
  const preferredDates =
    input.preferredDates ??
    (input.requestedStartsAt
      ? [
          toLocalParts(input.requestedStartsAt, resolveTimeZone(place.timezone))
            .date,
        ]
      : []);

  // Tag budget (FR-007) — deliberately LAST before the write: a request that
  // fails any gate above never burns the sender's budget.
  await consumeLineupTagBudget(deps, {
    ownerType,
    ownerId: input.performerOwnerId,
    placeId: place.id,
    tagCount,
  });

  const created = await deps.repos.tx((tx) =>
    writeBookingRequestInTx(tx, {
      place,
      calendar,
      ownerType,
      ownerId: input.performerOwnerId,
      actorHumanId: input.actorHumanId,
      now,
      acts: actRows,
      fields: {
        message,
        preferredDates,
        expectedDraw: input.expectedDraw ?? null,
        genre,
        // `links` (legacy generic array) is no longer written — the typed
        // link slots below replace it. The column defaults to [] for new rows.
        actName,
        lineupSize: input.lineupSize ?? null,
        setLengthMinutes: input.setLengthMinutes ?? null,
        contactPhone: input.contactPhone ?? null,
        techNeeds: input.techNeeds ?? null,
        feeType: input.feeType ?? null,
        feeAmountCents: input.feeAmountCents ?? null,
        feeCurrency,
        linkMusic: input.linkMusic ?? null,
        linkVideo: input.linkVideo ?? null,
        linkSocial: input.linkSocial ?? null,
        linkEpk: input.linkEpk ?? null,
        // taxFormStatus is deliberately NOT accepted here — it is a
        // VENUE-side workflow flag set later (off-platform paperwork only;
        // never TINs). The column's default (NONE) applies.
        tags,
        verifiedStatsSnapshot,
        // Intent + the room + the window (venue-confirmation spec).
        intent: input.intent,
        spaceId: input.spaceId ?? null,
        requestedStartsAt: input.requestedStartsAt ?? null,
        requestedEndsAt: input.requestedEndsAt ?? null,
        purpose: input.purpose ?? null,
        expectedAttendance: input.expectedAttendance ?? null,
        originEventId: null,
        // v3 L12: every PERFORM request records a bill — even an EMPTY one
        // (the sender off it, no acts), which writes no act rows and must
        // still mint an empty lineup, not the pre-bill "sender headlines"
        // fallback. RENT/USE carry no bill (BILL_NOT_ALLOWED) and keep the
        // column default (false).
        billRecorded: bill !== null,
      },
    }),
  );

  // ── Venue notification (FR-008) — post-commit, best-effort (NFR-004) ──────
  // The request is durably committed above; a notification failure must never
  // fail the submission. Deliberate swallow → keep the log AND report via
  // ReporterPort so the branch stays visible in Sentry.
  if (deps.notifyBookingRequestReceived) {
    try {
      await deps.notifyBookingRequestReceived({
        bookingRequest: created,
        place,
      });
    } catch (error) {
      deps.logger?.error("booking_requests.notify_received_failed", {
        bookingRequestId: created.id,
        placeId: place.id,
        err: error,
      });
      try {
        deps.reportError?.(error, {
          tags: { useCase: "createBookingRequest" },
          extra: { bookingRequestId: created.id, placeId: place.id },
        });
      } catch {
        // Reporting is best-effort — a throwing reporter must never fail the
        // committed submission.
      }
    }
  }

  // ── Lineup invites (lineup v2, FR-003) — post-commit, best-effort ───────
  // Every TAGGED act hears about it once (the notifier keys each send on
  // (request, act, recipient)); a tagged GROUP is heard by its editors (v3
  // L17). Deliberate swallow → keep the log AND report via ReporterPort.
  if (deps.notifyBookingLineupInvited && tagCount > 0) {
    try {
      await deps.notifyBookingLineupInvited({
        bookingRequest: created,
        place,
        taggedHumanIds,
        taggedOrgIds,
        // Skipped in a tagged group's fan-out: an editor of the group who
        // tagged it is not invited by their own action.
        actorHumanId: input.actorHumanId,
      });
    } catch (error) {
      deps.logger?.error("booking_requests.notify_lineup_invited_failed", {
        bookingRequestId: created.id,
        placeId: place.id,
        taggedCount: tagCount,
        err: error,
      });
      try {
        deps.reportError?.(error, {
          tags: { useCase: "createBookingRequest", step: "lineup_invited" },
          extra: {
            bookingRequestId: created.id,
            placeId: place.id,
            taggedCount: tagCount,
          },
        });
      } catch {
        // Reporting is best-effort — a throwing reporter must never fail the
        // committed submission.
      }
    }
  }

  deps.logger?.info("booking_requests.created", {
    bookingRequestId: created.id,
    placeId: place.id,
    intent: input.intent,
    performerOwnerType: ownerType,
    performerOwnerId: input.performerOwnerId,
    actorHumanId: input.actorHumanId,
    billActs: actRows?.length ?? 0,
    taggedActs: tagCount,
    selfOnBill: bill?.includeSelf ?? false,
  });

  return createBookingRequestOutputSchema.parse({
    bookingRequestId: created.id,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared core — the gates and the in-tx write, used by BOTH entry paths
// (spec "Two entry paths, one request"): the request-first pitch above and
// the event-first `createBookingRequestFromEvent` (which runs INSIDE the
// event save's transaction, so it needs the walk over `TxRepos`). One
// definition of "may this sender ask this venue for this" — never two.
// ─────────────────────────────────────────────────────────────────────────────

/** The repos the gate walk reads. `TxRepos` so a caller inside a tx can pass its bag. */
export type BookingRequestGateRepos = Pick<
  TxRepos,
  "performerProfiles" | "places" | "calendars" | "bookingRequests" | "events"
>;

export type BookingRequestGateArgs = {
  ownerType: PerformerOwnerType;
  ownerId: string;
  intent: BookingIntentInput;
  placeId: string;
  /** Named calendar (must belong to the place); absent = the place default. */
  calendarId?: string | undefined;
  /** RENT/USE room; asserted to be on the routed calendar when present. */
  spaceId?: string | undefined;
  /** PERFORM: the nights checked against the venue's hours (and for being past). */
  preferredDates?: string[] | undefined;
  /** RENT/USE: the window start, refused when already past (beyond the grace). */
  requestedStartsAt?: Date | undefined;
  /**
   * `"enforce"` everywhere a person asks. `"bypass"` exists for ONE caller:
   * the legacy third-party-event migration, where the sender is the event's
   * owner as a SYSTEM actor and the ask is the spec's migration step (4), not
   * a pitch — a promoter org that never enabled performer mode must still
   * get its published show in front of the venue.
   */
  performerGate: "enforce" | "bypass";
  /**
   * Is the SENDER's own act on the bill (lineup v2, D3)? The PERFORM
   * performer-mode gate guards the SELF row, not the sender: `false` (a
   * promoter pitching other acts) skips it. Absent = `true` — every caller
   * that predates the bill (the event-first path, the legacy migration)
   * asks as the act, so their behaviour is unchanged.
   */
  selfOnBill?: boolean | undefined;
};

export type BookingRequestGateResult = {
  place: PlaceRecord;
  /** The routed calendar with its spaces (null = the place has none; PERFORM only). */
  calendar: CalendarWithSpacesRow | null;
};

/**
 * Steps 2–5 of `createBookingRequest`, read-only, in order:
 *  2. performer mode (PERFORM only, unless bypassed, and only when the
 *     sender's own act is on the bill — `selfOnBill`);
 *  3. place exists and is CLAIMED (else PLACE_NOT_TAKING_REQUESTS), VERIFIED
 *     and opted in; PERFORM → hours configured, and the nights fit the hours
 *     / are not past; RENT/USE → the window has not already started (beyond
 *     the grace);
 *  4. calendar routing + the calendar accepts the intent + the space is on
 *     it — ONE read of the place's calendars answers all three;
 *  5. one open request per (sender, place).
 * Throws the same codes the pitch always threw; writes nothing.
 */
export async function runBookingRequestGates(
  repos: BookingRequestGateRepos,
  ctx: { now: () => Date; logger?: LoggerPort },
  args: BookingRequestGateArgs,
): Promise<BookingRequestGateResult> {
  // 2. Performer-mode gate — PERFORM only. "The requester is any human (or
  // org). Performer mode sets the DEFAULT intent; the intent is a choice."
  // Lineup v2 (D3): it gates the SELF row, so a sender who is not on their
  // own bill (`selfOnBill === false`) is not asked for it. Same code, same
  // one-click enable when they ARE on it.
  if (
    args.intent === "PERFORM" &&
    args.performerGate === "enforce" &&
    args.selfOnBill !== false
  ) {
    const profile = await repos.performerProfiles.getByOwner({
      ownerType: args.ownerType,
      ownerId: args.ownerId,
    });
    if (!isPerformerEnabled(profile)) {
      throw fail("PERFORMER_MODE_REQUIRED");
    }
  }

  // 3. Place gate. CLAIMED first (amendment 2026-09-25): an unclaimed venue
  // takes no requests from any entry path — the pitch (which also checks it
  // before anything else), the event-first create (which absorbs the code
  // into a skip, so the event still saves address-only) and the legacy
  // migration that rides it.
  const place = assertPlaceTakesRequests(
    await repos.places.getById(args.placeId),
  );
  if (place.verificationStatus !== "VERIFIED") {
    throw fail("PLACE_NOT_VERIFIED");
  }
  // `acceptsBookingRequests` is the claimed venue's opt-out (spec).
  if (!place.acceptsBookingRequests) {
    throw fail("PLACE_NOT_ACCEPTING_REQUESTS");
  }

  // 3a — PERFORM only.
  //
  // RENT/USE: the window IS the request. Availability rows are the venue's
  // performance hours, and a room hire at 10am on a dark Monday is a
  // perfectly ordinary ask; the venue confirms or declines. So neither the
  // unconfigured gate nor the hours check applies (spec: "the window is
  // what's requested") — only "not already in the past" (below).
  if (args.intent === "PERFORM") {
    // Availability-onboarding FR-005 (docs/specs/2026-08-31): a place
    // with ZERO CalendarAvailability rows has never stated hours, so every
    // public date computes `closed` and the form the client hides here must
    // also be refused server-side (a client-only hide leaves the mutation
    // reachable). Same house code as the paused-venue refusal — "not taking
    // requests right now" deliberately says nothing about why — with a
    // distinct machine message so the UI can route the venue-side copy.
    // INVARIANT THIS GATE RELIES ON (availability-onboarding spec
    // 2026-08-31): the count is PLACE-GLOBAL while availability reads are
    // calendar-scoped (place-wide rows + ONE calendar's rows). That is safe
    // only because every public booking surface today resolves the DEFAULT
    // calendar — where the hours modal's presets land. A future public
    // surface pinned to a NON-default calendar could pass this gate yet see
    // an all-dark month (rows exist, just not in its scope): re-examine this
    // gate's scope before shipping such a surface.
    const availabilityRowCount =
      await repos.calendars.countAvailabilityForPlace(place.id);
    if (availabilityRowCount === 0) {
      throw fail("PLACE_NOT_ACCEPTING_REQUESTS", {
        message: "booking_requests_unconfigured",
        meta: { placeId: place.id },
      });
    }
  }

  // 3b — every PERFORM request: the requested nights must be ones this venue
  // can actually host. The picker already filters them, but the picker is a
  // courtesy — without this a crafted payload books a dark Monday at 4am.
  //
  // Checked against the calendar the request ROUTES to, so the gate and
  // the picker answer the same question. A cross-place `calendarId` fails
  // here as CALENDAR_NOT_FOUND — the same code the routing block below
  // raises, just sooner, and still before any write.
  if (args.intent === "PERFORM") {
    const unavailable = await findUnavailableBookingDates(
      { repos, logger: ctx.logger, now: ctx.now },
      {
        placeId: place.id,
        // PERFORM: present by the intent-shape refine.
        dates: args.preferredDates ?? [],
        // `!== undefined`: a malformed id must fail the calendar lookup, not
        // be dropped into a silent default-routing.
        ...(args.calendarId !== undefined
          ? { calendarId: args.calendarId }
          : {}),
      },
    );
    if (unavailable.length > 0) {
      throw fail("BOOKING_DATE_UNAVAILABLE", {
        meta: {
          dates: unavailable.map((p) => p.value),
          reasons: unavailable.map((p) => p.reason),
        },
      });
    }
  } else if (
    args.requestedStartsAt !== undefined &&
    args.requestedStartsAt.getTime() <
      ctx.now().getTime() - BOOKING_WINDOW_PAST_GRACE_MS
  ) {
    // RENT/USE: a window that already started (beyond the grace) is a room
    // that is already gone. Same code and meta shape as the PERFORM past-date
    // refusal so the dialog handles both alike.
    throw fail("BOOKING_DATE_UNAVAILABLE", {
      meta: {
        dates: [args.requestedStartsAt.toISOString()],
        reasons: ["past"],
      },
    });
  }

  // 4. Calendar routing (FR-008) + intent acceptance + space membership.
  // Read-only, and BEFORE the duplicate check and the transaction: a request
  // for an intent the calendar does not take must fail before any write, and
  // with the SAME code whether the calendar was named or defaulted. ONE read
  // (the place's own calendar list, with spaces) answers all three.
  const calendar = await resolveCalendar(repos, place.id, args.calendarId);
  assertCalendarAcceptsIntent(calendar, args.intent);
  if (args.spaceId !== undefined) {
    assertSpaceOnCalendar(calendar, args.spaceId);
  }

  // 5. One open request per (sender, place).
  const open = await repos.bookingRequests.findOpenByPerformerAndPlace({
    ownerType: args.ownerType,
    ownerId: args.ownerId,
    placeId: place.id,
  });
  if (open) {
    throw fail("DUPLICATE_OPEN_REQUEST");
  }

  return { place, calendar };
}

/**
 * The place exists and is CLAIMED, or the ask is refused: PLACE_NOT_FOUND,
 * or PLACE_NOT_TAKING_REQUESTS for a place nobody holds (amendment
 * 2026-09-25 — `isClaimedPlace` is the one definition). Error copy takes no
 * arguments, so the place's name rides the meta for a client that wants to
 * name it — only while the place is ACTIVE: an archived or suspended place
 * has no public page, so its name does not leave through an error either.
 */
export function assertPlaceTakesRequests(
  place: PlaceRecord | null,
): PlaceRecord {
  if (!place) {
    throw fail("PLACE_NOT_FOUND");
  }
  if (!isClaimedPlace(place)) {
    throw fail("PLACE_NOT_TAKING_REQUESTS", {
      meta: {
        placeId: place.id,
        ...(place.status === "ACTIVE" ? { placeName: place.name } : {}),
      },
    });
  }
  return place;
}

/** The row fields the caller owns; routing / expiry come from the gate result. */
export type BookingRequestWriteFields = Omit<
  CreateBookingRequestRecordInput,
  | "placeId"
  | "calendarId"
  | "performerOwnerType"
  | "performerOwnerId"
  | "expiresAt"
  | "source"
  | "embedId"
>;

export type BookingRequestWriteArgs = {
  place: Pick<PlaceRecord, "id">;
  calendar: Pick<CalendarRow, "id"> | null;
  ownerType: PerformerOwnerType;
  ownerId: string;
  /** Null ONLY for a system actor (the legacy migration) — ledger + audit record it as such. */
  actorHumanId: string | null;
  now: Date;
  fields: BookingRequestWriteFields;
  /**
   * The bill's rows (lineup v2, FR-001), written in the SAME transaction as
   * the request — a request never commits without its bill. Core assigns
   * distinct `sortOrder`s. Absent = no act rows (RENT/USE, and the
   * event-first path, whose lineup lives on the event it came from).
   */
  acts?: readonly CreateBookingRequestActInput[] | undefined;
};

/**
 * The transactional half: the row (expiry stamped at `now + TTL`), the
 * ledger's opening entry and the audit row. Same tx as the caller's, so a
 * request can never exist without the entry that opens its thread.
 */
export async function writeBookingRequestInTx(
  tx: TxRepos,
  args: BookingRequestWriteArgs,
): Promise<ToVenueBookingRequestRecord> {
  const expiresAt = new Date(
    args.now.getTime() + BOOKING_REQUEST_TTL_DAYS * DAY_MS,
  );

  const request = await tx.bookingRequests.create({
    ...args.fields,
    placeId: args.place.id,
    calendarId: args.calendar?.id ?? null,
    performerOwnerType: args.ownerType,
    performerOwnerId: args.ownerId,
    expiresAt,
  });

  // The bill, same tx. A duplicate owner key here ABORTS the Postgres
  // transaction (see the port doc) — core deduped the tags before the tx, so
  // this only fires on a genuine race, and it must propagate: never catch
  // and continue inside `repos.tx()`.
  if (args.acts && args.acts.length > 0) {
    await tx.bookingRequests.addActs(request.id, args.acts);
  }

  // Opens the LEDGER (booking timeline step 2). Same tx as the create, so a
  // request can never exist without the entry that opens its thread.
  await appendBookingSystemEntry(tx, {
    bookingRequestId: request.id,
    kind: "booking_request.opened",
    data: { direction: "TO_VENUE", source: "PLATFORM" },
    actorHumanId: args.actorHumanId,
  });

  await tx.audit.log({
    entity: "booking_request",
    entityId: request.id,
    action: "booking_request.created",
    data: {
      placeId: args.place.id,
      calendarId: request.calendarId,
      intent: args.fields.intent ?? "PERFORM",
      spaceId: args.fields.spaceId ?? null,
      originEventId: args.fields.originEventId ?? null,
      performerOwnerType: args.ownerType,
      performerOwnerId: args.ownerId,
      actorHumanId: args.actorHumanId,
      expiresAt,
      // The bill's shape (lineup v2) — counts only; the rows are the record.
      ...(args.acts
        ? {
            bill: {
              self: args.acts.some((act) => act.source === "SELF"),
              tagged: args.acts.filter((act) => act.source === "TAGGED")
                .length,
              external: args.acts.filter((act) => act.source === "EXTERNAL")
                .length,
            },
          }
        : {}),
    },
    at: args.now,
  });

  return request;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The bill this request carries, or null when none applies (FR-002):
 *   · RENT/USE with a `bill` → BILL_NOT_ALLOWED (a room hire has no lineup);
 *   · PERFORM without one → the pre-bill contract: the sender is the act;
 *   · a PERFORM bill may be EMPTY (v3 L12 — LINEUP_REQUIRED is gone): the
 *     request names only the sender and writes no act rows; `billRecorded`
 *     on the request is what makes the mint create an empty lineup rather
 *     than the pre-bill headliner. The BILL standard (5b) still refuses it
 *     at a venue that requires one.
 */
function resolveBill(
  intent: BookingIntentInput,
  bill: BookingBillInput | undefined,
): BookingBillInput | null {
  if (intent !== "PERFORM") {
    if (bill !== undefined) {
      throw fail("BILL_NOT_ALLOWED", { meta: { intent } });
    }
    return null;
  }
  return bill ?? { includeSelf: true, acts: [] };
}

/**
 * The bill's tagged ids, in bill order, split by kind, after the pure tag
 * rules:
 *   · an act tagged twice → ACT_NOT_TAGGABLE `duplicate` (the DB unique
 *     would abort the whole transaction, so it is refused before it);
 *   · the SENDER tagging itself — a human sender their own humanId, an org
 *     sender its own orgId (v3 L17) → ACT_NOT_TAGGABLE `self`: the "I'm on
 *     the bill" toggle is how a sender goes on it, never as an invite to
 *     itself. An ORG sender may tag a member, and a HUMAN sender may tag a
 *     group they belong to; those are different parties.
 */
function assertBillTags(
  bill: BookingBillInput,
  sender: { ownerType: PerformerOwnerType; ownerId: string },
): { humanIds: string[]; orgIds: string[] } {
  const seen = new Set<string>();
  const humanIds: string[] = [];
  const orgIds: string[] = [];
  for (const act of bill.acts) {
    if (act.kind !== "tagged") continue;
    const owner = taggedOwnerOf(act);
    const meta =
      owner.ownerType === "human"
        ? { humanId: owner.ownerId }
        : { orgId: owner.ownerId };
    const key = `${owner.ownerType}:${owner.ownerId}`;
    if (seen.has(key)) {
      throw fail("ACT_NOT_TAGGABLE", { meta: { reason: "duplicate", ...meta } });
    }
    if (
      owner.ownerType === sender.ownerType &&
      owner.ownerId === sender.ownerId
    ) {
      throw fail("ACT_NOT_TAGGABLE", { meta: { reason: "self", ...meta } });
    }
    seen.add(key);
    (owner.ownerType === "human" ? humanIds : orgIds).push(owner.ownerId);
  }
  return { humanIds, orgIds };
}

/** A tagged act's owner pair. The schema guarantees exactly one id. */
function taggedOwnerOf(
  act: Extract<BookingBillInput["acts"][number], { kind: "tagged" }>,
): { ownerType: PerformerOwnerType; ownerId: string } {
  return act.orgId !== undefined
    ? { ownerType: "organization", ownerId: act.orgId }
    : { ownerType: "human", ownerId: act.humanId as string };
}

/**
 * Role + label for one act row (v3 L13): PERFORMER when none was given; the
 * label kept only beside OTHER and only when non-blank (the same rule
 * `attachEventHuman` applies, so the label flows onto the lineup as is).
 */
function actRoleFields(act: {
  role?: CreateBookingRequestActInput["role"];
  customRoleLabel?: string | undefined;
}): Pick<CreateBookingRequestActInput, "role" | "customRoleLabel"> {
  const role = act.role ?? "PERFORMER";
  const label = act.customRoleLabel?.trim();
  return { role, customRoleLabel: role === "OTHER" && label ? label : null };
}

/**
 * Bill rows in bill order with DISTINCT sortOrders (the port requires it —
 * the adapter's tiebreak is not insert order): SELF at 0 (position 1,
 * "Headlining") when the sender is on the bill, then the acts as given, each
 * with its role (v3 L13; PERFORMER by default — SELF always is). TAGGED rows
 * (a person or a group) are stamped invited now (their notification is sent
 * post-commit).
 */
function buildBillActRows(
  bill: BookingBillInput,
  now: Date,
): CreateBookingRequestActInput[] {
  const rows: CreateBookingRequestActInput[] = [];
  if (bill.includeSelf) {
    rows.push({ source: "SELF", sortOrder: 0, role: "PERFORMER" });
  }
  for (const act of bill.acts) {
    const sortOrder = rows.length;
    if (act.kind === "tagged") {
      const owner = taggedOwnerOf(act);
      rows.push({
        source: "TAGGED",
        actOwnerType: owner.ownerType,
        actOwnerId: owner.ownerId,
        invitedAt: now,
        sortOrder,
        ...actRoleFields(act),
      });
    } else {
      rows.push({
        source: "EXTERNAL",
        externalName: act.name,
        externalUrl: act.url ?? null,
        sortOrder,
        ...actRoleFields(act),
      });
    }
  }
  return rows;
}

/**
 * FR-004 default for a bill WITHOUT the sender: the first FREE-TEXT act's
 * name, clipped to the `actName` bound; null when the bill has none. Tagged
 * acts are skipped on purpose — they are PENDING consent, and `actName` is
 * venue-facing (see the call site).
 */
function firstExternalActName(bill: BookingBillInput): string | null {
  const first = bill.acts.find((act) => act.kind === "external");
  if (!first || first.kind !== "external") return null;
  const clipped = first.name.slice(0, BOOKING_BILL_ACT_NAME_MAX_LENGTH).trim();
  return clipped ? clipped : null;
}

/**
 * The tag budget (FR-007): the bill's tagged acts — people and groups (v3
 * L17) — are charged against the SENDER pair's daily bucket. Same shape as the embed's per-place daily cap
 * (`embeds/create-booking-inquiry.ts`): consumed in the use case, after every
 * gate, fail-OPEN when the limiter throws, RATE_LIMITED when it will not fit.
 *
 * PROBE FIRST, so a refusal costs at most ONE token: the first `consume`
 * both charges the first tag and reports what is left (`remaining` = tokens
 * left AFTER it). If the bucket is empty, or `remaining + 1` (what this bill
 * could use, the probe's own token included) is less than the tags on the
 * bill, it is refused before anything else is spent. Only a bill that fits
 * consumes its remaining tokens. A concurrent sender can still drain the
 * bucket between the probe and the rest; that loser is refused too, having
 * spent what it consumed.
 *
 * RESIDUAL, accepted: the port is a fixed-window counter with no refund, so a
 * request that consumed its tokens and then fails later (the transaction
 * rolls back) still burns them. Rare (the gates have all passed by now) and
 * bounded by the bill size.
 *
 * APPROXIMATION, deliberately: the spec says "30 DISTINCT tagged humans per
 * rolling day". `RateLimitPort` is a fixed-window counter (INCR + EXPIRE) —
 * it can count, not remember members — so this counts TAGS: the same artist
 * tagged on two requests spends two tokens, and the window is fixed, not
 * rolling. Within one bill tags are already distinct (duplicates are refused
 * above). Both deviations only make the budget stricter for a sender who
 * re-tags the same artist a lot, which is the abuse the cap is for; an exact
 * distinct-set count would need a new port for a nuisance-level difference.
 */
export async function consumeLineupTagBudget(
  deps: Pick<CreateBookingRequestDeps, "rateLimit" | "logger" | "reportError">,
  args: {
    ownerType: PerformerOwnerType;
    ownerId: string;
    placeId: string;
    tagCount: number;
    /**
     * Who is spending the budget, for the fail-open report. Defaults to the
     * create path; the bill edit (v3 FR-009) charges the same bucket.
     */
    useCase?: string;
  },
): Promise<void> {
  if (!deps.rateLimit || args.tagCount === 0) return;

  const key = bookingLineupTagBudgetKey(args.ownerType, args.ownerId);
  let denied: RateLimitResult | null = null;
  for (let i = 0; i < args.tagCount; i += 1) {
    let result: RateLimitResult;
    try {
      result = await deps.rateLimit.consume(
        key,
        BOOKING_LINEUP_TAG_DAILY_MAX,
        BOOKING_LINEUP_TAG_DAILY_WINDOW_SECONDS,
      );
    } catch (error) {
      // Fail open, matching the embed cap's stance: an abuse cap must never
      // take down legitimate submissions because a counter could not be
      // incremented. Deliberate swallow → log AND report (ReporterPort
      // convention). Stops consuming for this bill: one broken limiter, one
      // report — not one per tag.
      deps.logger?.error("booking_requests.lineup_tag_budget_consume_failed", {
        performerOwnerType: args.ownerType,
        performerOwnerId: args.ownerId,
        placeId: args.placeId,
        err: error,
      });
      try {
        deps.reportError?.(error, {
          tags: {
            useCase: args.useCase ?? "createBookingRequest",
            step: "lineup_tag_budget",
          },
          extra: {
            performerOwnerType: args.ownerType,
            performerOwnerId: args.ownerId,
            placeId: args.placeId,
          },
        });
      } catch {
        // Reporting is best-effort — a throwing reporter must never turn
        // the fail-open allow into a thrown error.
      }
      return;
    }
    const probe = i === 0;
    if (
      !result.allowed ||
      (probe && result.remaining + 1 < args.tagCount)
    ) {
      denied = result;
      break;
    }
  }

  if (denied) {
    deps.logger?.warn("booking_requests.lineup_tag_budget_exceeded", {
      performerOwnerType: args.ownerType,
      performerOwnerId: args.ownerId,
      placeId: args.placeId,
      tagCount: args.tagCount,
      remaining: denied.remaining,
      retryAfterSeconds: denied.retryAfterSeconds,
    });
    // RATE_LIMITED → TOO_MANY_REQUESTS at the tRPC boundary; the scope in
    // meta tells the form this is the tag budget, not the per-actor limit.
    throw fail("RATE_LIMITED", {
      message: "lineup_tag_budget",
      meta: {
        scope: "lineup_tag_budget",
        retryAfterSeconds: denied.retryAfterSeconds,
      },
    });
  }
}

/**
 * Explicit calendarId: must belong to THIS place (cross-place isolation — a
 * foreign id is indistinguishable from a missing one). Absent: the place's
 * `isDefault` calendar (null when the place somehow has none — the row stays
 * unrouted rather than failing the pitch).
 *
 * Resolved through the place's OWN calendar list, which is what makes the
 * isolation structural — a foreign id simply is not in the list — and which
 * carries the joined spaces, so the space check below needs no second read.
 */
async function resolveCalendar(
  repos: Pick<TxRepos, "calendars">,
  placeId: string,
  calendarId: string | undefined,
): Promise<CalendarWithSpacesRow | null> {
  const calendars = await repos.calendars.listByPlace(placeId);
  if (calendarId !== undefined) {
    const calendar = calendars.find((row) => row.id === calendarId);
    if (!calendar) {
      throw fail("CALENDAR_NOT_FOUND");
    }
    return calendar;
  }
  return calendars.find((row) => row.isDefault) ?? null;
}

/**
 * The calendar is the CONFIG layer: which intents it accepts. A calendar
 * that does not take the intent refuses BEFORE any write with
 * `INVALID_INPUT` / `calendar_rejects_intent` (no new error code: the
 * message is the machine key the dialog branches on, and the dialog never
 * offers an intent the options read did not list, so a hit here is a stale
 * form or a crafted payload).
 *
 * No calendar at all: PERFORM keeps its pre-hierarchy behaviour (unrouted
 * row, the column default `acceptsPerform: true` is the policy); RENT/USE
 * cannot be accepted by nothing — there is no space to block.
 *
 * RENT on a calendar in `rentalMode: "INSTANT"` is refused too: instant book
 * is mutually exclusive with rental REQUESTS on that calendar (spec, Calendar
 * config); PERFORM/USE are unaffected by it.
 */
function assertCalendarAcceptsIntent(
  calendar: CalendarRow | null,
  intent: BookingIntentInput,
): void {
  // PERFORM reads the column DEFAULT (`true`) when the flag is absent —
  // a row that predates the config layer, or a partial read — so the
  // pre-intent behaviour holds unless a venue explicitly turned it off.
  // RENT/USE default OFF, so absent reads as refused.
  const accepted =
    calendar === null
      ? intent === "PERFORM"
      : intent === "PERFORM"
        ? calendar.acceptsPerform !== false
        : intent === "RENT"
          ? calendar.acceptsRent === true && calendar.rentalMode === "REQUEST"
          : calendar.acceptsUse === true;
  if (!accepted) {
    throw fail("INVALID_INPUT", {
      message: "calendar_rejects_intent",
      meta: { calendarId: calendar?.id ?? null, intent },
    });
  }
}

/**
 * The space must be one the ROUTED calendar schedules into, and still
 * ACTIVE. Answered off the calendar's own joined spaces (already loaded), so
 * a space on another place — or on this place's OTHER calendar — is refused
 * identically: `INVALID_INPUT` / `space_not_on_calendar`, never a
 * confirmation that the id exists.
 */
function assertSpaceOnCalendar(
  calendar: CalendarWithSpacesRow | null,
  spaceId: string,
): void {
  const space = calendar?.spaces.find((s) => s.id === spaceId);
  if (!space || space.status !== "ACTIVE") {
    throw fail("INVALID_INPUT", {
      message: "space_not_on_calendar",
      meta: { calendarId: calendar?.id ?? null, spaceId },
    });
  }
}
