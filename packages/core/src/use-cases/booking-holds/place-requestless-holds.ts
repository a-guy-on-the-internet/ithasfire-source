import { z } from "zod";

import type { Repos } from "@th/ports/repos";
import type {
  BookerBookingHoldRecord,
  BookingHoldHolder,
  PlaceBookingHoldRecord,
} from "@th/ports/repos/booking-holds";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { ReporterPort } from "@th/ports/reporter";
import { NOTE_MAX_LENGTH } from "@th/types/repos/notes";
import { fail, isAppError } from "@th/errors";

import { parseInput } from "../../lib/io";
import { plainTextMultilineOptional } from "../../lib/sanitize-plain-text";
import { resolveBookingTimezone } from "../booking-agreements/_shared/pitch-seed";
import {
  listPlaceBookerGrants,
  requirePlaceBookerAuthority,
  requirePlaceBookingAuthority,
  type PlaceBookerAuthorityResult,
  type PlaceBookingAuthorityResult,
} from "../booking-requests/_shared/place-access";
import {
  requirePublicPartyPage,
  sameGrantee,
} from "../place-booking-grants/_shared/grant-context";
import { placeBookingGranteeSchema } from "../place-booking-grants/_shared/grant-intents";
import {
  bookingHoldNotificationIntentSchema,
  bookingHoldStaffRecipientHintSchema,
  type BookingHoldNotificationIntent,
  type BookingHoldStaffRecipientHint,
} from "./_shared/booking-hold-intents";
import { bookerGrantStillCoversUnderLock } from "./_shared/booker-grant-lock";
import {
  bookingHoldOutputSchema,
  failInvalidField,
  isoCalendarDateSchema,
  requirePlace,
  staffRecipientHintFor,
  toBookingHoldOutput,
  type BookingHoldDeps,
} from "./_shared/hold-context";
import { isHoldLineChangedConflict } from "./_shared/hold-line";
import {
  checkHoldDate,
  isHoldLineAlreadyConfirmed,
  placeRequestlessHoldOnLine,
  type RequestlessHoldOwner,
} from "./_shared/place-hold-on-line";
import {
  requestlessHoldNotificationIntentSchema,
  type RequestlessHoldNotificationIntent,
} from "./_shared/requestless-hold-intents";
import { MAX_BOOKING_HOLD_BATCH_DATES } from "./place-booking-holds";

// ─────────────────────────────────────────────────────────────────────────────
// placeRequestlessHolds (holds-without-a-request FR-005, H1 / H5 / H6 / H11 /
// H14): hold one or more dates (up to 12, like placeBookingHolds) with no
// booking request behind them. ONE use case, two kinds:
//
//   BOOKER — an outside booker holds for itself. The actor must be covered by
//     an ACTIVE (accepted, not declined / revoked / expired) booking grant at
//     the calendar's place that covers the calendar; the holder is the
//     grantee (org or person). The party is passed to the booker gate as `as`
//     (plan item i): when the actor could hold for several parties and names
//     none, the call is refused (`as` required), never answered with the
//     repo's first match.
//   PLACE — the place holds for itself. The actor needs the STAFF gate
//     (`requirePlaceBookingAuthority`: owner / edit-role member). Optionally
//     names ONE party on the platform, picked by its public page (an org's or
//     a person's entity page; no email lookup, NFR-002), and an optional
//     opening note (≤ 2000 chars, sanitized first; stamped with the placer).
//
// SAME LINE BODY AS EVERY PLACEMENT (`placeRequestlessHoldOnLine`): one
// transaction per date, ascending; the line's advisory lock and
// settle-before-count; a line with a CONFIRMED winner is refused; position =
// max + 1 (plan item f: a cascaded org delete leaves gaps, so never a count).
// PARTIAL SUCCESS is a real outcome: `placed` + `failed`, exactly as
// placeBookingHolds. The use case never throws once a hold is durable; an
// unrecognised per-date failure after a commit is `unknown_error`, logged and
// reported (ReporterPort).
//
// THE GRANT ROW (plan item m, hold-line.ts LOCKING): every BOOKER date's
// transaction first takes `SELECT … FOR SHARE` on the grant row
// (`lockSharedAtPlace`) and re-checks it on that row — still active, still
// accepted, still covering the calendar, still the same grantee, and the
// actor still acts for it (`bookerGrantStillCoversUnderLock`) — before any
// line lock. Revoke and update write the row, so they and a placement
// serialise on it: a revoke that lands mid-batch refuses the remaining dates
// (`PLACE_BOOKING_GRANT_ENDED`), and one that lands after a date committed
// sees that hold and releases it.
//
// NAMED-PARTY NOTICE CAP (NFR-002, 50 per place per rolling 24h). CHOICE: a
// call over the cap is REFUSED (RATE_LIMITED, nothing written), never placed
// with its notice skipped: a degraded path would be a hold the named party is
// never told about, which the cap exists to prevent being abused, not to
// produce. The count is the place's own audit rows
// (`booking_hold.party_named`, one per call that names someone: ONE digest
// notice per call), read and written under the place lock (LOCKING step 1)
// so two racing calls cannot both take the 50th slot. The slot is charged
// before the dates are placed; a call whose every date then fails has spent
// one (conservative, and never more than the calls made).
//
// NOTICES (FR-013): a BOOKER placement → staff, in-app (`placed`, one digest
// per call); a PLACE placement naming a party → that party, email + in-app
// (`named`, one digest). An unassigned PLACE hold tells nobody (staff placed
// it). No thread, no request intents for the new rows (H20): an audit row per
// hold. The settle's own intents (an expired challenge on the line, the acts
// it moved up) ride `notificationIntents` as for every placement.
// ─────────────────────────────────────────────────────────────────────────────

/** NFR-002: named-party notices per place per rolling 24 hours. */
export const NAMED_PARTY_NOTICES_PER_DAY = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The place-level audit action that counts toward the cap. */
export const PARTY_NAMED_AUDIT_ACTION = "booking_hold.party_named";

/**
 * Why a date got no hold. Closed set: anything else is `unknown_error` once
 * a hold is durable, and thrown before.
 */
export const REQUESTLESS_HOLD_FAILURE_CODES = [
  /** The holder already has a live hold in that line (FR-005, item f). */
  "BOOKING_HOLD_HOLDER_EXISTS",
  "HOLD_LINE_ALREADY_CONFIRMED",
  "hold_date_in_past",
  "invalid_calendar_date",
  "HOLD_LINE_CHANGED",
  /**
   * BOOKER only: the grant stopped covering the actor between the gate and
   * this date's transaction (revoked, expired, rescoped). Read under the
   * grant row lock, so no hold was written for it.
   */
  "PLACE_BOOKING_GRANT_ENDED",
  "unknown_error",
] as const;

export type RequestlessHoldFailureCode =
  (typeof REQUESTLESS_HOLD_FAILURE_CODES)[number];

const datesSchema = z
  .array(isoCalendarDateSchema)
  .min(1)
  .max(MAX_BOOKING_HOLD_BATCH_DATES);

export const placeRequestlessHoldsInputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("BOOKER"),
      actorHumanId: z.uuid(),
      calendarId: z.uuid(),
      dates: datesSchema,
      /**
       * The party the actor holds FOR (H2: itself, a principal it is an
       * edit-role delegate of, an org it edits). Required only when the
       * actor's grants at the place name more than one party.
       */
      as: placeBookingGranteeSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("PLACE"),
      actorHumanId: z.uuid(),
      calendarId: z.uuid(),
      dates: datesSchema,
      /** The named party's public page (org or person entity page). */
      namedPartyPageId: z.uuid().optional(),
      /** The opening note (FR-011 / FR-012); sanitized before the bound. */
      note: plainTextMultilineOptional(NOTE_MAX_LENGTH).optional(),
    })
    .strict(),
]);

export const placeRequestlessHoldsOutputSchema = z
  .object({
    placed: z.array(bookingHoldOutputSchema),
    failed: z.array(
      z
        .object({
          date: isoCalendarDateSchema,
          code: z.enum(REQUESTLESS_HOLD_FAILURE_CODES),
        })
        .strict(),
    ),
    // ── server-side only (stripped by the wire schema) ──
    /** What the lines owed (settled lapses, move-ups of request holds). */
    notificationIntents: z.array(bookingHoldNotificationIntentSchema),
    requestlessIntents: z.array(requestlessHoldNotificationIntentSchema),
    staffRecipientHint: bookingHoldStaffRecipientHintSchema,
  })
  .strict();

/** What transport puts on the wire: intents + routing stay server-side. */
export const placeRequestlessHoldsWireOutputSchema = z.object(
  placeRequestlessHoldsOutputSchema.omit({
    notificationIntents: true,
    requestlessIntents: true,
    staffRecipientHint: true,
  }).shape,
);

export type PlaceRequestlessHoldsInput = z.input<
  typeof placeRequestlessHoldsInputSchema
>;
export type PlaceRequestlessHoldsOutput = z.infer<
  typeof placeRequestlessHoldsOutputSchema
>;
export type PlaceRequestlessHoldsDeps = BookingHoldDeps & {
  /**
   * ReporterPort convention (CLAUDE.md): an unrecognised per-date failure
   * after a commit is swallowed into `failed[]` and reported here.
   */
  reportError?: ReporterPort;
};

type ParsedInput = z.infer<typeof placeRequestlessHoldsInputSchema>;

/** Who the call holds for, resolved once up front. */
type Resolved =
  | {
      kind: "BOOKER";
      place: PlaceRecord;
      booker: PlaceBookerAuthorityResult;
      holder: BookingHoldHolder;
    }
  | {
      kind: "PLACE";
      place: PlaceRecord;
      ownership: PlaceBookingAuthorityResult;
      holder: BookingHoldHolder | null;
      note: string | null;
    };

function failureCode(error: unknown): RequestlessHoldFailureCode | null {
  if (isAppError(error)) {
    if (error.code === "BOOKING_HOLD_HOLDER_EXISTS") return "BOOKING_HOLD_HOLDER_EXISTS";
    if (error.code === "PLACE_BOOKING_GRANT_ENDED") return "PLACE_BOOKING_GRANT_ENDED";
    if (error.code === "HOLD_LINE_CHANGED") return "HOLD_LINE_CHANGED";
  }
  if (isHoldLineAlreadyConfirmed(error)) return "HOLD_LINE_ALREADY_CONFIRMED";
  // The raw adapter shape (a deadlock folded into line_changed on create).
  if (isHoldLineChangedConflict(error)) return "HOLD_LINE_CHANGED";
  return null;
}

export async function placeRequestlessHolds(
  deps: PlaceRequestlessHoldsDeps,
  rawInput: unknown,
): Promise<PlaceRequestlessHoldsOutput> {
  const input = parseInput(placeRequestlessHoldsInputSchema, rawInput);
  const now = deps.clock.now();
  const { repos } = deps;

  const calendar = await repos.calendars.findById(input.calendarId);
  if (!calendar) throw fail("CALENDAR_NOT_FOUND");
  const place = await requirePlace(repos, calendar.placeId);
  const placeTz = resolveBookingTimezone(place.timezone);

  const resolved = await resolveHolder(repos, { input, place, now });

  // Dedupe + ascending, as placeBookingHolds: the earliest night first.
  const dates = [...new Set(input.dates)].sort();
  const failed: Array<{ date: string; code: RequestlessHoldFailureCode }> = [];
  const placeable: string[] = [];
  for (const date of dates) {
    const issue = checkHoldDate(date, now, placeTz);
    if (issue) failed.push({ date, code: issue });
    else placeable.push(date);
  }

  // The named-party notice cap, charged once per call, before any date.
  if (resolved.kind === "PLACE" && resolved.holder && placeable.length > 0) {
    await chargeNamedPartyNotice(repos, {
      place,
      holder: resolved.holder,
      actorHumanId: input.actorHumanId,
      calendarId: calendar.id,
      dates: placeable,
      now,
    });
  }

  const owner: RequestlessHoldOwner =
    resolved.kind === "BOOKER"
      ? { ownerKind: "BOOKER", grantId: resolved.booker.grant.id, holder: resolved.holder }
      : { ownerKind: "PLACE", holder: resolved.holder };

  const placed: Array<BookerBookingHoldRecord | PlaceBookingHoldRecord> = [];
  const intents: BookingHoldNotificationIntent[] = [];

  for (const date of placeable) {
    try {
      // ONE TRANSACTION PER DATE (placeBookingHolds' header): each line takes
      // its own lock; one spanning them would invite a deadlock.
      const outcome = await repos.tx(async (tx) => {
        if (resolved.kind === "BOOKER") {
          // Trap m: the grant row FOR SHARE, re-checked before the line lock.
          const still = await bookerGrantStillCoversUnderLock(tx, {
            grantId: resolved.booker.grant.id,
            placeId: place.id,
            calendarId: calendar.id,
            holder: resolved.holder,
            actorHumanId: input.actorHumanId,
            now,
          });
          if (!still) {
            throw fail("PLACE_BOOKING_GRANT_ENDED", {
              meta: { grantId: resolved.booker.grant.id, calendarId: calendar.id },
            });
          }
        }
        return placeRequestlessHoldOnLine(tx, {
          placeId: place.id,
          calendarId: calendar.id,
          date,
          now,
          placeTz,
          actorHumanId: input.actorHumanId,
          owner,
          note: resolved.kind === "PLACE" ? resolved.note : null,
        });
      });
      placed.push(outcome.hold);
      intents.push(...outcome.intents);
    } catch (error) {
      const known = failureCode(error);
      if (known) {
        failed.push({ date, code: known });
        continue;
      }
      deps.logger?.error("booking_holds.place_requestless.date_failed", {
        kind: input.kind,
        calendarId: calendar.id,
        date,
        placedSoFar: placed.length,
        err: error,
      });
      // Nothing committed: the honest signal for a systemic failure.
      if (placed.length === 0) throw error;
      // Committed holds exist: degrade, and report the swallow (guarded).
      try {
        deps.reportError?.(error, {
          tags: { useCase: "placeRequestlessHolds", step: "place_date" },
          extra: { kind: input.kind, calendarId: calendar.id, date, placedSoFar: placed.length },
        });
      } catch {
        // Best-effort reporting only.
      }
      failed.push({ date, code: "unknown_error" });
    }
  }
  failed.sort((a, b) => a.date.localeCompare(b.date));

  const requestlessIntents = placementIntents(resolved, {
    placed,
    placeId: place.id,
    calendarId: calendar.id,
    actorHumanId: input.actorHumanId,
  });

  const staffRecipientHint: BookingHoldStaffRecipientHint =
    resolved.kind === "PLACE"
      ? staffRecipientHintFor({
          hold: { placedByHumanId: input.actorHumanId },
          request: null,
          place,
          ownership: resolved.ownership,
        })
      : // A booker is not staff: the hint names the staff member who gave the
        // grant, never the booker (FR-016 routing reads it as the placer).
        staffRecipientHintFor({
          hold: { placedByHumanId: resolved.booker.grant.grantedByHumanId },
          request: null,
          place,
          ownership: null,
        });

  const payload: PlaceRequestlessHoldsOutput = {
    placed: placed.map((hold) => toBookingHoldOutput(hold, now, placeTz)),
    failed,
    notificationIntents: intents,
    requestlessIntents,
    staffRecipientHint,
  };

  // The tail is inside "never throw once durable" (placeBookingHolds' tail).
  try {
    deps.logger?.info("booking_holds.placed_requestless", {
      kind: input.kind,
      calendarId: calendar.id,
      requested: dates.length,
      placed: placed.length,
      failed: failed.length,
      actorHumanId: input.actorHumanId,
    });
    return placeRequestlessHoldsOutputSchema.parse(payload);
  } catch (error) {
    if (placed.length === 0) throw error;
    try {
      deps.reportError?.(error, {
        tags: { useCase: "placeRequestlessHolds", step: "finalize" },
        extra: { kind: input.kind, calendarId: calendar.id, placed: placed.length },
      });
    } catch {
      // Best-effort reporting only.
    }
    return payload;
  }
}

/**
 * The gate, once, before anything is written: BOOKER → the booker gate with
 * `as`; PLACE → the staff gate, then the named party by public page.
 */
async function resolveHolder(
  repos: Repos,
  args: { input: ParsedInput; place: PlaceRecord; now: Date },
): Promise<Resolved> {
  const { input, place, now } = args;
  if (input.kind === "BOOKER") {
    let as = input.as;
    if (!as) {
      // No party named: fine when every grant covering the actor here is
      // the same party's; otherwise the actor must say which (item i).
      const covering = await listPlaceBookerGrants(repos, place, input.actorHumanId, {
        calendarId: input.calendarId,
        now,
      });
      const parties = covering.filter(
        (c, i) => covering.findIndex((o) => sameGrantee(o.holder, c.holder)) === i,
      );
      if (parties.length > 1) failInvalidField("as", "booker_party_required");
      as = parties[0]?.holder;
    }
    if (!as) throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "place" } });
    const booker = await requirePlaceBookerAuthority(repos, place, input.actorHumanId, {
      calendarId: input.calendarId,
      now,
      as,
    });
    return { kind: "BOOKER", place, booker, holder: booker.holder };
  }

  const ownership = await requirePlaceBookingAuthority(repos, place, input.actorHumanId);
  let holder: BookingHoldHolder | null = null;
  if (input.namedPartyPageId) {
    // By PUBLIC page only (NFR-002): never an email; a private or unlisted
    // page, or a banned owner's, reads like a missing one.
    const page = await requirePublicPartyPage(repos, input.namedPartyPageId);
    if (page.ownerType === "ORGANIZATION") {
      holder = { kind: "org", orgId: page.ownerId };
    } else if (page.ownerType === "HUMAN") {
      holder = { kind: "person", humanId: page.ownerId };
    } else {
      failInvalidField("namedPartyPageId", "named_party_not_org_or_person");
    }
  }
  const note = input.note && input.note.length > 0 ? input.note : null;
  return { kind: "PLACE", place, ownership, holder, note };
}

/**
 * NFR-002: one named-party notice per call, at most 50 per place per rolling
 * 24 hours. Counted from the place's own audit rows under the place lock,
 * and charged in the same transaction (so the 51st racing call waits, then
 * reads 50 and is refused).
 */
async function chargeNamedPartyNotice(
  repos: Repos,
  args: {
    place: PlaceRecord;
    holder: BookingHoldHolder;
    actorHumanId: string;
    calendarId: string;
    dates: string[];
    now: Date;
  },
): Promise<void> {
  const { place, now } = args;
  await repos.tx(async (tx) => {
    await tx.placeBookingGrants.lockPlace(place.id);
    const recent = await tx.audit.listForEntity({
      entity: "place",
      entityId: place.id,
      actions: [PARTY_NAMED_AUDIT_ACTION],
      after: new Date(now.getTime() - DAY_MS),
      limit: NAMED_PARTY_NOTICES_PER_DAY,
    });
    if (recent.length >= NAMED_PARTY_NOTICES_PER_DAY) {
      throw fail("RATE_LIMITED", {
        meta: {
          scope: "booking_hold_named_party_notices_daily",
          limit: NAMED_PARTY_NOTICES_PER_DAY,
        },
      });
    }
    await tx.audit.log({
      entity: "place",
      entityId: place.id,
      action: PARTY_NAMED_AUDIT_ACTION,
      data: {
        actorHumanId: args.actorHumanId,
        holder: args.holder,
        calendarId: args.calendarId,
        dates: args.dates,
      },
      at: now,
    });
  });
}

/** The FR-013 notices a placement call owes: one digest, or none. */
function placementIntents(
  resolved: Resolved,
  args: {
    placed: ReadonlyArray<BookerBookingHoldRecord | PlaceBookingHoldRecord>;
    placeId: string;
    calendarId: string;
    actorHumanId: string;
  },
): RequestlessHoldNotificationIntent[] {
  const { placed } = args;
  if (placed.length === 0) return [];
  const first = placed[0]!;
  const digest = {
    holdId: first.id,
    placeId: args.placeId,
    calendarId: args.calendarId,
    date: first.date,
    position: first.position,
    ...(placed.length > 1
      ? {
          dates: placed.map((h) => ({ date: h.date, position: h.position })),
          holdIds: placed.map((h) => h.id),
        }
      : {}),
  };
  if (resolved.kind === "BOOKER") {
    // Staff, in-app. The placer is the booker, not staff: routing goes to the
    // grant's giver.
    return [
      {
        ...digest,
        kind: "requestless_hold.placed",
        audience: "staff",
        staffHumanId: resolved.booker.grant.grantedByHumanId,
      },
    ];
  }
  if (!resolved.holder) return [];
  return [
    {
      ...digest,
      kind: "requestless_hold.named",
      audience: "named_party",
      party: resolved.holder,
      staffHumanId: args.actorHumanId,
    },
  ];
}
