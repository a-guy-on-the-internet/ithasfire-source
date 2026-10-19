import { z } from "zod";

import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { ORG_EDIT_ROLES } from "../../lib/rbac";
import {
  anchorBookingNight,
  assertBookingEventOnNight,
  bookingNightOf,
  defaultTermsNight,
  failBookingAlreadyHasNight,
  namedTimeOnNight,
  otherBookedNight,
  resolveBookingEvent,
  resolveNightCalendarId,
} from "../booking-holds/_shared/booking-night";
import { isoCalendarDateSchema } from "../booking-holds/_shared/hold-context";
import { requireAgreementParty } from "./_shared/agreement-access";
import { requireAgreementTermsEditor } from "./_shared/agreement-editor-side";
import {
  addSetLength,
  resolveBookingTimezone,
  resolveCalendarDefaultStartTime,
} from "./_shared/pitch-seed";
import {
  sendBookingAgreementForReview,
  sendBookingAgreementForReviewOutputSchema,
  type BookingAgreementTransitionDeps,
} from "./send-booking-agreement-for-review";
import { updateBookingAgreementHeader } from "./update-booking-agreement-header";
// ── P3b (asks) ──
import { effectiveSetLengthMinutes } from "../booking-requests/asks/map-ask-answers";

// ─────────────────────────────────────────────────────────────────────────────
// sendBookingTerms — the venue's one "Send terms" button (booking-the-night
// N2, FR-003), server side.
//
// One call = put the chosen night (and time) on the DRAFT terms, then send
// them. It COMPOSES the two existing use cases rather than re-implementing
// them, so every gate stays where it is: the header update owns "DRAFT only,
// terms editor only, end after start"; the send owns the N6 night check
// (NIGHT_TAKEN) and the sender stamp. Payout lines are never touched.
//
// Why a combined call earns its place over the two existing ones:
//   - the DEFAULT NIGHT is a server rule (the night this request already
//     booked, else its position-1 hold, else the first night it asked for)
//     that both the web and mobile cards would otherwise each re-derive;
//   - the night → instant step is the booking night's own rule
//     (`anchorBookingNight`: the start lands ON the chosen calendar day, the
//     day every line consumer uses), in one place rather than per client.
//
// NOT atomic across the two steps, deliberately: they are separate
// transactions. If the send is refused (NIGHT_TAKEN, a lost CAS), the DRAFT
// keeps the night the venue picked — which is what the venue then edits or
// challenges for — and nothing has been sent. A header that already names
// that instant is not rewritten.
// ─────────────────────────────────────────────────────────────────────────────

/** `HH:MM`, 24h — the calendar template's own wall-clock shape. */
const wallClockSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, "invalid_wall_clock");

export const sendBookingTermsInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    agreementId: z.uuid(),
    /**
     * The night the terms book (place-local `YYYY-MM-DD`). Omitted → this
     * request's booked night, else its position-1 hold's night, else the
     * first night it asked for.
     */
    night: isoCalendarDateSchema.optional(),
    /**
     * Start time on that night. Omitted → the act's named time for that
     * night, else the night's calendar default, else 19:00 — always on the
     * chosen calendar day ("00:30" is 00:30 of that day, never the next).
     */
    startTime: wallClockSchema.optional(),
  })
  .strict();

export const sendBookingTermsOutputSchema =
  sendBookingAgreementForReviewOutputSchema
    .extend({
      night: isoCalendarDateSchema,
      proposedDate: z.date(),
    })
    .strict();

export type SendBookingTermsInput = z.infer<typeof sendBookingTermsInputSchema>;
export type SendBookingTermsOutput = z.infer<
  typeof sendBookingTermsOutputSchema
>;
export type SendBookingTermsDeps = BookingAgreementTransitionDeps;

export async function sendBookingTerms(
  deps: SendBookingTermsDeps,
  rawInput: unknown,
): Promise<SendBookingTermsOutput> {
  const input = parseInput(sendBookingTermsInputSchema, rawInput);

  const agreement = await deps.repos.agreements.getById(input.agreementId);
  if (!agreement) {
    throw fail("AGREEMENT_NOT_FOUND");
  }
  // The same gate the two composed use cases apply, FIRST — nothing about the
  // request, its holds or the place is read for anyone but the terms editor.
  const party = await requireAgreementParty(deps.repos, {
    agreement,
    actorHumanId: input.actorHumanId,
    orgRoles: ORG_EDIT_ROLES,
  });
  await requireAgreementTermsEditor(deps.repos, agreement, party.side);

  // Only request-linked TO_VENUE terms name a night at a venue. Everything
  // else keeps the plain send (no night to pick).
  const request = await deps.repos.bookingRequests.findByAgreementId(
    agreement.id,
  );
  if (!request || request.direction !== "TO_VENUE") {
    throw fail("BOOKING_REQUEST_NOT_FOUND", {
      meta: {
        agreementId: agreement.id,
        reason: "terms_have_no_venue_request",
      },
    });
  }
  const place = await deps.repos.places.getById(request.placeId);
  if (!place) {
    throw fail("PLACE_NOT_FOUND");
  }
  const placeTz = resolveBookingTimezone(place.timezone);
  const now = deps.clock.now();

  const requestHolds = await deps.repos.bookingHolds.listForRequest(
    request.id,
  );
  const night =
    input.night ?? defaultTermsNight(request, requestHolds, now, placeTz);
  if (!night) {
    throw {
      code: "invalid_input",
      message: "invalid_input",
      issues: [{ code: "custom", message: "night_required", path: ["night"] }],
    } as const;
  }

  const calendarId = await resolveNightCalendarId(deps.repos, {
    request,
    placeId: place.id,
    night,
  });

  // Read-only pre-checks BEFORE the header write (review W2), so a refused
  // send leaves the draft exactly as it was. The send re-checks both — the
  // first under the night's lock — after.
  //   - one booked night per request;
  if (calendarId && otherBookedNight(requestHolds, { calendarId, date: night })) {
    failBookingAlreadyHasNight();
  }
  //   - the booking's event (finalized link, live draft, live event-first
  //     origin) must sit on this night.
  assertBookingEventOnNight(
    await resolveBookingEvent(deps.repos, { agreement, request }),
    { night, placeTz, side: "venue", agreementId: agreement.id, calendarId },
  );

  const clock = input.startTime
    ? {
        hour: Number(input.startTime.slice(0, 2)),
        minute: Number(input.startTime.slice(3, 5)),
      }
    : namedTimeOnNight(request, night);
  const calendarDefault =
    clock || !calendarId
      ? null
      : await resolveCalendarDefaultStartTime(
          {
            repos: deps.repos,
            logger: deps.logger,
            reportError: deps.reportError,
          },
          { placeId: place.id, calendarId },
        );
  const proposedDate = anchorBookingNight(
    night,
    placeTz,
    clock,
    calendarDefault,
  );
  if (!proposedDate) {
    throw {
      code: "invalid_input",
      message: "invalid_input",
      issues: [
        { code: "custom", message: "invalid_calendar_date", path: ["night"] },
      ],
    } as const;
  }

  // Keep the negotiated length (a venue-edited "two hours" is a term, not a
  // night); with none, the pitch's set length; else no end.
  // ── P3b (asks) ── "the pitch's set length" is the pitch's own, else the
  // sender's answer to a SET_LENGTH ask (venue-booking-standards V10): an
  // answer given while the terms named no date still sets the end here.
  const span =
    agreement.proposedDate && agreement.proposedEndDate
      ? agreement.proposedEndDate.getTime() - agreement.proposedDate.getTime()
      : 0;
  const proposedEndDate =
    span > 0
      ? new Date(proposedDate.getTime() + span)
      : addSetLength(
          proposedDate,
          await effectiveSetLengthMinutes(deps.repos, request),
        );

  if (
    agreement.proposedDate?.getTime() !== proposedDate.getTime() ||
    (agreement.proposedEndDate?.getTime() ?? null) !==
      (proposedEndDate?.getTime() ?? null)
  ) {
    await updateBookingAgreementHeader(deps, {
      actorHumanId: input.actorHumanId,
      agreementId: agreement.id,
      proposedDate,
      proposedEndDate,
    });
  }

  const sent = await sendBookingAgreementForReview(deps, {
    actorHumanId: input.actorHumanId,
    agreementId: agreement.id,
  });

  // What was actually SENT: the stored instant (re-read after the send) and
  // the night derived from it — never the value this call computed, in case
  // a skipped header write left a different one in place.
  const stored = (await deps.repos.agreements.getById(agreement.id))
    ?.proposedDate;
  if (!stored) {
    throw fail("AGREEMENT_NOT_FOUND");
  }
  return sendBookingTermsOutputSchema.parse({
    ...sent,
    night: bookingNightOf(stored, placeTz),
    proposedDate: stored,
  });
}
