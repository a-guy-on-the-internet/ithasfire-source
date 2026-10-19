import { z } from "zod";

import { parseInput } from "../../lib/io";
import { resolveBookingTimezone } from "../booking-agreements/_shared/pitch-seed";
import { isHoldLapsed } from "../booking-holds/_shared/booking-hold-lapse";
import {
  bookingHoldOutputSchema,
  toBookingHoldOutput,
} from "../booking-holds/_shared/hold-context";
import {
  grantEventOutputSchema,
  listEventsConfirmedUnderGrant,
  placeBookingGrantOutputSchema,
  requireGrantAtPlace,
  requireGrantManager,
  toGrantEventOutput,
  toPlaceBookingGrantOutput,
  type PlaceBookingGrantDeps,
} from "./_shared/grant-context";

// ─────────────────────────────────────────────────────────────────────────────
// previewGrantRevoke (holds-without-a-request FR-003, H15; the R1 dialog).
//
// What revoking would touch, for the grant's managers (H4: owner / owning-org
// OWNER / ADMIN):
//   - every LIVE booker hold riding the grant (not yet lapsed), each with
//     the default `release` (the alternative, `keep`, makes it a place hold
//     naming the booker);
//   - every UPCOMING event of the grantee at the place whose current venue
//     confirmation came from THIS grant (`listEventsConfirmedUnderGrant`),
//     each with the default `stay` (the alternative, `withdraw`, takes the
//     place's confirmation back through `withdrawVenueConfirmation`). Never
//     cancel (H15).
// Read-only. A revoked grant previews too: its holds are gone (kept or
// released), its events are still listed, so a retried revoke can finish a
// withdrawal that failed.
// ─────────────────────────────────────────────────────────────────────────────

export const previewGrantRevokeInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    placeId: z.uuid(),
    grantId: z.uuid(),
  })
  .strict();

export const previewGrantRevokeOutputSchema = z
  .object({
    grant: placeBookingGrantOutputSchema,
    holds: z.array(
      z
        .object({
          hold: bookingHoldOutputSchema,
          defaultAction: z.literal("release"),
        })
        .strict(),
    ),
    events: z.array(
      z
        .object({
          event: grantEventOutputSchema,
          defaultAction: z.literal("stay"),
        })
        .strict(),
    ),
  })
  .strict();

export type PreviewGrantRevokeInput = z.infer<
  typeof previewGrantRevokeInputSchema
>;
export type PreviewGrantRevokeOutput = z.infer<
  typeof previewGrantRevokeOutputSchema
>;
export type PreviewGrantRevokeDeps = PlaceBookingGrantDeps;

export async function previewGrantRevoke(
  deps: PreviewGrantRevokeDeps,
  rawInput: unknown,
): Promise<PreviewGrantRevokeOutput> {
  const input = parseInput(previewGrantRevokeInputSchema, rawInput);
  const now = deps.clock.now();
  const { repos } = deps;

  const { place } = await requireGrantManager(
    repos,
    input.placeId,
    input.actorHumanId,
  );
  const grant = await requireGrantAtPlace(repos, place.id, input.grantId);
  const placeTz = resolveBookingTimezone(place.timezone);

  const [holds, events] = await Promise.all([
    repos.bookingHolds.listLiveForGrant(grant.id),
    listEventsConfirmedUnderGrant(repos, { grant, now }),
  ]);

  return previewGrantRevokeOutputSchema.parse({
    grant: toPlaceBookingGrantOutput(grant, now),
    holds: holds
      // A lapsed hold is already over (the next read on its line settles
      // it); there is nothing to choose for it.
      .filter((hold) => isHoldLapsed(hold, now, placeTz) === null)
      .map((hold) => ({
        hold: toBookingHoldOutput(hold, now, placeTz),
        defaultAction: "release" as const,
      })),
    events: events.map((event) => ({
      event: toGrantEventOutput(event),
      defaultAction: "stay" as const,
    })),
  });
}
