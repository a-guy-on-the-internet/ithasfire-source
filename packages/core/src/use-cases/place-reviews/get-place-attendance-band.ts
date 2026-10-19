import { z } from "zod";

import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { ATTENDANCE_BANDS, attendanceBandFor } from "./track-record-policy";

// ---------------------------------------------------------------------------
// getPlaceAttendanceBand (venue-track-record-and-review-switch spec,
// docs/specs/2026-09-24, FR-010 / FR-014, NFR-004, ruling R4)
//
// The sibling read behind `places.getTrackRecord`: the request-to-play line
// says "Usually 25–100 people checked in" and this is the ONLY thing it may
// learn. The output carries the BAND and nothing else — `checkedInAvg`,
// `checkedInTotal`, `scannedEventCount` never leave core (NFR-004); the strict
// output schema is the gate, and the transport test serialises the result to
// prove the key set.
//
// DOOR DATA, NOT PERFORMER DATA. `Place.communityReviewsEnabled` governs the
// performer tier (`getPlacePublicStats`, `venue_stats`, the trusted-venues
// list). Scans are the venue's own door count, so the switch is deliberately
// NOT consulted here — a place with performer reviews off still says how many
// people usually check in.
//
// Public read, no actor, NO THROW, NO EXISTENCE ORACLE: an unknown place, an
// ARCHIVED place, a place with no `PlaceStats` row, and a place with no
// scanned show all answer the SAME `{ placeId, attendanceBand: null }` — a
// caller cannot tell the four apart. `getPlacePublicStats` is the model
// (never throws for a missing place); the sibling `listPlaceLineupHistory`
// throws PLACE_ARCHIVED because it is a page read that has to say why there
// is no page, whereas this is one line on a form. Archived short-circuits
// BEFORE the stats read so no stale row is ever consulted.
// ---------------------------------------------------------------------------

export const getPlaceAttendanceBandInputSchema = z
  .object({
    placeId: z.string().uuid(),
  })
  .strict();

export const getPlaceAttendanceBandOutputSchema = z
  .object({
    placeId: z.string().uuid(),
    /** Coarsened `checkedInAvg` (FR-010); null when no scanned show exists. */
    attendanceBand: z.enum(ATTENDANCE_BANDS).nullable(),
  })
  .strict();

export type GetPlaceAttendanceBandInput = z.infer<
  typeof getPlaceAttendanceBandInputSchema
>;
export type GetPlaceAttendanceBandOutput = z.infer<
  typeof getPlaceAttendanceBandOutputSchema
>;

export type GetPlaceAttendanceBandDeps = {
  repos: Pick<Repos, "placeStats" | "places">;
};

export async function getPlaceAttendanceBand(
  deps: GetPlaceAttendanceBandDeps,
  rawInput: unknown,
): Promise<GetPlaceAttendanceBandOutput> {
  const input = parseInput(getPlaceAttendanceBandInputSchema, rawInput);

  const place = await deps.repos.places.getById(input.placeId);
  if (!place || place.status === "ARCHIVED") {
    return { placeId: input.placeId, attendanceBand: null };
  }

  const stats = await deps.repos.placeStats.getByPlaceId(input.placeId);

  // `.parse` on the strict output schema is load-bearing: it strips nothing
  // silently — an extra key is a thrown error, so the raw figures cannot
  // ride along even if a future edit spreads the stats row in here.
  return getPlaceAttendanceBandOutputSchema.parse({
    placeId: input.placeId,
    attendanceBand: attendanceBandFor(stats?.checkedInAvg ?? null),
  });
}
