import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { redactPlaceLocation } from "../../lib/location/redact-place-location";
import { fail } from "@th/errors";

export const getPlacePublicInputSchema = z
  .object({
    placeId: z.string().uuid(),
  })
  .strict();

export const getPlacePublicOutputSchema = z
  .object({
    place: z
      .object({
        placeId: z.string().uuid(),
        name: z.string(),
        /**
         * REDACTED. Null whenever the venue withholds its address — this is
         * an anonymous public read, so it is always the public projection
         * (`redactPlaceLocation`), never the row.
         */
        formattedAddress: z.string().nullable(),
        /**
         * The street line and the "Unit or room", REDACTED like the rest
         * (both already inside `formattedAddress` when public). The
         * community place dialog reads them to prefill Unit and show the
         * Address without it: the unit sits right after the street line
         * (`lib/location/place-unit.ts`).
         */
        addressLine1: z.string().nullable(),
        addressLine2: z.string().nullable(),
        city: z.string().nullable(),
        region: z.string().nullable(),
        countryCode: z.string().nullable(),
        /**
         * The TRUE pin for an EXACT venue; the obfuscated circle centre for an
         * OBSCURED one with a radius; NULL when the venue is fully hidden.
         */
        lat: z.number().nullable(),
        lng: z.number().nullable(),
        capacity: z.number().nullable(),
        status: z.string(),
        verificationStatus: z.string(),
        /** False when the address is withheld — drives the "area only" UI. */
        locationIsExact: z.boolean(),
        /** True = fully hidden: draw no map at all. */
        locationHidden: z.boolean(),
        /** Circle radius in metres; non-null only in the obfuscated-circle state. */
        locationRadiusMeters: z.number().nullable(),
        /** Coarse area label, the only place string a withheld venue publishes. */
        areaLabel: z.string().nullable(),
      })
      .strict(),
  })
  .strict();

export type GetPlacePublicInput = z.infer<typeof getPlacePublicInputSchema>;
export type GetPlacePublicOutput = z.infer<typeof getPlacePublicOutputSchema>;

export type GetPlacePublicDeps = {
  repos: Pick<Repos, "places">;
  logger?: LoggerPort;
};

export async function getPlacePublic(
  deps: GetPlacePublicDeps,
  rawInput: unknown,
): Promise<GetPlacePublicOutput> {
  const input = parseInput(getPlacePublicInputSchema, rawInput);

  const place = await deps.repos.places.getById(input.placeId);
  if (!place) {
    throw fail("PLACE_NOT_FOUND");
  }

  // Public gating: archived places are not publicly visible.
  if (place.status === "ARCHIVED") {
    throw fail("PLACE_ARCHIVED");
  }

  // Product decision (2026-02): unverified places render publicly so owners
  // can share a direct link, but they are excluded from search indexes and
  // venue calendar pages (those require VERIFIED). The verificationStatus is
  // included in the response so the UI can display a badge or disclaimer.

  deps.logger?.info("places.get_public", {
    placeId: place.id,
    verificationStatus: place.verificationStatus,
    status: place.status,
  });

  // ANONYMOUS PUBLIC READ — there is no actor on this use case at all, so the
  // location goes through the redactor with no unlock. A venue that withholds
  // its address publishes city/region/area-label and nothing finer; a fully
  // hidden one publishes no coordinates either.
  const location = redactPlaceLocation(place);

  return getPlacePublicOutputSchema.parse({
    place: {
      placeId: place.id,
      name: place.name,
      formattedAddress: location.formattedAddress,
      addressLine1: location.addressLine1,
      addressLine2: location.addressLine2,
      city: location.city,
      region: location.region,
      countryCode: location.countryCode,
      lat: location.lat,
      lng: location.lng,
      capacity: place.capacity,
      status: place.status,
      verificationStatus: place.verificationStatus,
      locationIsExact: location.isExact,
      locationHidden: location.hidden,
      locationRadiusMeters: location.radiusMeters,
      areaLabel: location.areaLabel,
    },
  });
}
