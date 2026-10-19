import { z } from "zod";

import { LIVE_BOOKING_HOLD_STATUSES } from "@th/ports/repos/booking-holds";

import { parseInput } from "../../lib/io";
import { resolveBookingTimezone } from "../booking-agreements/_shared/pitch-seed";
import { isHoldLapsed } from "./_shared/booking-hold-lapse";
import { isLineHeadChallengeable } from "./_shared/booking-night";
import { lineKeysOf } from "./_shared/hold-line";
import { resolveActChallengeView } from "./_shared/keep-will";
import {
  areTermsAgreedForNight,
  findReadyBehind,
} from "./_shared/night-readiness";
import { TERMINAL_BOOKING_REQUEST_STATUSES } from "./_shared/settle-lapsed-holds";
import {
  actBookingHoldOutputSchema,
  bookingHoldOutputSchema,
  ensureHoldReader,
  isoCalendarDateSchema,
  requirePlace,
  requireRequest,
  requireToVenueRequest,
  toActBookingHoldOutput,
  toBookingHoldOutput,
  type ActBookingHoldOutput,
  type BookingHoldDeps,
} from "./_shared/hold-context";

// ─────────────────────────────────────────────────────────────────────────────
// listBookingHoldsForRequest (FR-012 thread strip / FR-013 act view).
//
// VIEWER-AWARE: staff get every column of every hold on the request; the act
// gets ITS OWN holds (own by construction — they hang off the act's request)
// projected to date / position / status / respondBy / lapsed and nothing
// else. Never the names or count of other acts in a line.
//
// READ ONLY: lapses are PROJECTED (`lapsed`), never persisted here — reads
// do not write. Settlement happens on the next mutation or via
// `settleBookingHolds`.
//
// STAFF ONLY — `lineHeads` (booking-the-night FR-002): for every line this
// request holds a live place in, the position-1 hold's id and whether it can
// be challenged right now, so the venue can challenge the hold ahead from
// this thread (`challengeBookingHold` takes the position-1 hold's id). It
// names ANOTHER party's hold, so the act variant has no such field — the
// discriminated union's strict objects make it unrepresentable there.
//
// booking-the-night P2d-2: `challengeable` now folds in N20 / FR-015 — the
// SAME readiness rule `challengeBookingHold` enforces (`findReadyBehind`) —
// and `challengeBlocker` says why not, so the strip can show "Challenge"
// disabled with the reason. The act variant gains `keepWill` / `kept` on
// its own challenged holds (N19 / FR-014), from its own terms only.
// ─────────────────────────────────────────────────────────────────────────────

export const listBookingHoldsForRequestInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    bookingRequestId: z.uuid(),
    viewer: z.enum(["staff", "act"]),
  })
  .strict();

// The act projection lives in hold-context (shared with the act's challenge
// answer wire output); re-exported here for the existing import surface.
export { actBookingHoldOutputSchema, type ActBookingHoldOutput };

/**
 * One line's head, as the venue's thread strip needs it. `holdId` may be
 * this request's own hold (`isThisRequest`). Lapsed rows are projected out,
 * as everywhere on this read. `challengeable` is exactly what
 * `challengeBookingHold` would accept right now: the head is ACTIVE, no
 * challenge is open on the line, AND a hold behind it is ready to book the
 * night (N20 / FR-015). `challengeBlocker` is why not (null when
 * challengeable): `challenge_open` — a challenge is already running on the
 * line; `terms_agreed` — the head's own terms for the night are already
 * agreed, so the venue books it with Create event (review W3);
 * `no_act_ready` — nobody behind has terms ready for that night;
 * `requestless_head` — the head is an outside booker's or the place's own
 * hold, which `challengeBookingHold` does not challenge yet
 * (holds-without-a-request, plan step 6). Holds whose request is already
 * closed are projected out, as the challenge's own settlement releases them.
 */
export const bookingHoldLineHeadSchema = z
  .object({
    calendarId: z.uuid(),
    date: isoCalendarDateSchema,
    holdId: z.uuid(),
    isThisRequest: z.boolean(),
    challengeable: z.boolean(),
    challengeBlocker: z
      .enum([
        "challenge_open",
        "terms_agreed",
        "no_act_ready",
        "requestless_head",
      ])
      .nullable(),
  })
  .strict();

export type BookingHoldLineHead = z.infer<typeof bookingHoldLineHeadSchema>;

export const listBookingHoldsForRequestOutputSchema = z.discriminatedUnion(
  "viewer",
  [
    z
      .object({
        viewer: z.literal("staff"),
        holds: z.array(bookingHoldOutputSchema),
        lineHeads: z.array(bookingHoldLineHeadSchema),
      })
      .strict(),
    z
      .object({
        viewer: z.literal("act"),
        holds: z.array(actBookingHoldOutputSchema),
      })
      .strict(),
  ],
);

export type ListBookingHoldsForRequestInput = z.infer<
  typeof listBookingHoldsForRequestInputSchema
>;
export type ListBookingHoldsForRequestOutput = z.infer<
  typeof listBookingHoldsForRequestOutputSchema
>;
export type ListBookingHoldsForRequestDeps = BookingHoldDeps;

export async function listBookingHoldsForRequest(
  deps: ListBookingHoldsForRequestDeps,
  rawInput: unknown,
): Promise<ListBookingHoldsForRequestOutput> {
  const input = parseInput(listBookingHoldsForRequestInputSchema, rawInput);
  const now = deps.clock.now();

  const request = requireToVenueRequest(
    await requireRequest(deps.repos, input.bookingRequestId),
  );
  await ensureHoldReader(deps.repos, request, input.actorHumanId, input.viewer);
  const place = await requirePlace(deps.repos, request.placeId);
  const placeTz = resolveBookingTimezone(place.timezone);

  const holds = await deps.repos.bookingHolds.listForRequest(request.id);

  if (input.viewer === "staff") {
    const heldLines = lineKeysOf(
      holds.filter(
        (h) =>
          (LIVE_BOOKING_HOLD_STATUSES as readonly string[]).includes(
            h.status,
          ) && isHoldLapsed(h, now, placeTz) === null,
      ),
    );
    // The request status of every hold read below, once per request: a live
    // hold whose request is already closed is projected out exactly as the
    // challenge's settlement releases it (REQUEST_CLOSED, settle-lapsed-holds)
    // — so the strip and the challenge read the same line (review nit).
    const requestStatus = new Map<string, string | null>();
    const isOnClosedRequest = async (bookingRequestId: string) => {
      if (!requestStatus.has(bookingRequestId)) {
        requestStatus.set(
          bookingRequestId,
          (await deps.repos.bookingRequests.getById(bookingRequestId))?.status ??
            null,
        );
      }
      const status = requestStatus.get(bookingRequestId) ?? null;
      return (
        status !== null &&
        (TERMINAL_BOOKING_REQUEST_STATUSES as readonly string[]).includes(status)
      );
    };
    const lineHeads = [];
    for (const key of heldLines) {
      const line = [];
      for (const h of await deps.repos.bookingHolds.listLineWithTerms(key)) {
        if (isHoldLapsed(h, now, placeTz) !== null) continue;
        // The closed-request backstop is a request's; a request-less hold
        // has none (holds-without-a-request).
        if (h.ownerKind === "REQUEST" && (await isOnClosedRequest(h.bookingRequestId))) {
          continue;
        }
        line.push(h);
      }
      const head = line[0];
      if (!head) continue;
      const requestHead = head.ownerKind === "REQUEST";
      const lineOpen = isLineHeadChallengeable(line);
      // Review W3: the head's own terms for the night are agreed — book it.
      const agreed =
        lineOpen && areTermsAgreedForNight(head.terms, key.date, placeTz);
      const ready =
        requestHead &&
        lineOpen &&
        !agreed &&
        findReadyBehind({ line, target: head, now, placeTz }) !== null;
      lineHeads.push({
        calendarId: key.calendarId,
        date: key.date,
        holdId: head.id,
        isThisRequest:
          head.ownerKind === "REQUEST" && head.bookingRequestId === request.id,
        challengeable: ready,
        challengeBlocker: !lineOpen
          ? ("challenge_open" as const)
          : !requestHead
            ? ("requestless_head" as const)
            : agreed
              ? ("terms_agreed" as const)
              : ready
                ? null
                : ("no_act_ready" as const),
      });
    }
    return listBookingHoldsForRequestOutputSchema.parse({
      viewer: "staff",
      holds: holds.map((h) => toBookingHoldOutput(h, now, placeTz)),
      lineHeads,
    });
  }

  const actHolds = [];
  for (const hold of holds) {
    actHolds.push(
      toActBookingHoldOutput(
        hold,
        now,
        placeTz,
        await resolveActChallengeView(deps.repos, {
          hold,
          request,
          placeId: place.id,
          placeTz,
        }),
      ),
    );
  }
  return listBookingHoldsForRequestOutputSchema.parse({
    viewer: "act",
    holds: actHolds,
  });
}
