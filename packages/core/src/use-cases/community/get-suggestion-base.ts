import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import {
  eventAttendanceModeSchema,
  eventStewardshipSchema,
} from "@th/schema";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import {
  projectPublicEventLocation,
  toPlaceLocationSource,
  unreadablePlaceLocation,
} from "../../lib/location/project-public-event-location";
import {
  GEO_GROUP_FIELDS,
  snapshotSuggestionBase,
} from "../events/_shared/suggestion-fields";
import {
  ensureCommunitySuggestibleEvent,
  resolveCurrentHeroImageId,
} from "./_shared/suggestion-validation";

/**
 * PUBLIC hydration query for the propose-mode edit surface
 * (community-managed-event-listings spec FR-006; UI→backend request #4):
 * returns the event's CURRENT whitelisted-field values (the same snapshot
 * shape `submit-event-edit-suggestion` stores as `baseVersion`) plus the
 * ATTACHED images available to the anonymous hero picker.
 *
 * This query only hydrates the form — the server still stamps the
 * authoritative `baseVersion` at submit time, so a stale client snapshot can
 * never corrupt conflict detection (FR-009).
 *
 * Visibility: only PUBLISHED PUBLIC **COMMUNITY-stewarded** events are
 * readable; anything else — including OWNED events (product decision
 * 2026-07-20 reversing FR-006's universal scope) — collapses to
 * EVENT_NOT_FOUND (`ensureCommunitySuggestibleEvent` — the
 * anonymous surface must not be an existence oracle for drafts/private
 * events, nor a stewardship oracle). Only ATTACHED, finalized, non-deleted images are exposed:
 * unattached suggestion-borne uploads stay non-public until APPROVE
 * (FR-015 "nothing public pre-approval").
 *
 * Location redaction: unless the event's PUBLIC location
 * (`projectPublicEventLocation`, with its venue as the floor) is EXACT, every
 * geo-group field is NULLED in the returned base. The event row's own mode is
 * not enough: an event at a venue that withholds its address is withheld
 * whatever its row says, and a row written before the venue was withheld
 * still carries the house. This does NOT affect FR-009 conflict detection:
 * the authoritative `baseVersion` is snapshotted server-side (unredacted) at
 * submit time.
 */

export const getSuggestionBaseInputSchema = z
  .object({
    eventId: z.uuid().optional(),
    slug: z.string().trim().min(1).max(255).optional(),
  })
  .strict()
  .refine(
    (value) => (value.eventId ? 1 : 0) + (value.slug ? 1 : 0) === 1,
    "provide exactly one of eventId or slug",
  );

/**
 * Whitelisted current values, in the exact serialized shape of a suggestion
 * `baseVersion` snapshot (dates as ISO strings, absent values as null).
 */
const suggestionBaseFieldsSchema = z
  .object({
    title: z.string(),
    /** Full EventBody JSON, or null when the event has no body. */
    content: z.unknown().nullable(),
    startsAt: z.string(),
    endsAt: z.string().nullable(),
    timezone: z.string(),
    addressText: z.string().nullable(),
    countryCode: z.string().nullable(),
    region: z.string().nullable(),
    locality: z.string().nullable(),
    postalCode: z.string().nullable(),
    lat: z.number().nullable(),
    lng: z.number().nullable(),
    categoryId: z.uuid().nullable(),
    heroImageId: z.uuid().nullable(),
    ageLimit: z.number().nullable(),
  })
  .strict();

export const getSuggestionBaseOutputSchema = z
  .object({
    eventId: z.uuid(),
    slug: z.string().nullable(),
    attendanceMode: eventAttendanceModeSchema,
    stewardship: eventStewardshipSchema,
    base: suggestionBaseFieldsSchema,
    /** ATTACHED event images only — candidates for the hero picker. */
    attachedImages: z.array(
      z.object({ id: z.uuid(), publicUrl: z.string() }).strict(),
    ),
  })
  .strict();

export type GetSuggestionBaseInput = z.infer<typeof getSuggestionBaseInputSchema>;
export type GetSuggestionBaseOutput = z.infer<
  typeof getSuggestionBaseOutputSchema
>;

export type GetSuggestionBaseDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

export async function getSuggestionBase(
  deps: GetSuggestionBaseDeps,
  rawInput: unknown,
): Promise<GetSuggestionBaseOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "getSuggestionBase" });

  const execute = async (): Promise<GetSuggestionBaseOutput> => {
    const input = parseInput(getSuggestionBaseInputSchema, rawInput);

    let eventId = input.eventId ?? null;
    if (!eventId) {
      // Redirected (legacy) slugs still resolve — the propose surface only
      // needs the event; canonical-slug redirects are a page-level concern.
      const resolution = await deps.repos.events.resolveBySlug(input.slug!);
      if (!resolution) {
        throw fail("EVENT_NOT_FOUND", { meta: { via: "slug" } });
      }
      eventId = resolution.eventId;
    }

    const event = ensureCommunitySuggestibleEvent(
      await deps.repos.events.getById(eventId),
    );

    const content = await deps.repos.events.getContent({ eventId: event.id });
    const images = await deps.repos.images.listByEventId(event.id);
    const heroImageId = await resolveCurrentHeroImageId(
      {
        listByEventId: async () => images,
      },
      event,
    );

    const base = snapshotSuggestionBase({ event, content, heroImageId });

    // Redact the geo group unless the PUBLIC projection is EXACT (see module
    // doc). The venue is the floor, so it is read — and a venue that is gone
    // projects as fully hidden, never as "no venue". A place read that THROWS
    // fails this anonymous read (nothing is swallowed, so there is nothing to
    // report). Fail closed throughout: only a literal "EXACT" event mode at an
    // EXACT venue (or no venue) keeps the geo group.
    const place = event.placeId
      ? await deps.repos.places.getById(event.placeId)
      : null;
    const publicLocation = projectPublicEventLocation(event, {
      place: event.placeId
        ? place
          ? toPlaceLocationSource(place)
          : unreadablePlaceLocation(event.placeId)
        : undefined,
    });
    if (publicLocation.mode !== "EXACT") {
      for (const field of GEO_GROUP_FIELDS) {
        base[field] = null;
      }
    }

    const attachedImages = images
      .filter(
        (image) =>
          image.attached &&
          !image.deletedAt &&
          image.uploadedAt !== null &&
          image.publicUrl.length > 0,
      )
      .map((image) => ({ id: image.id, publicUrl: image.publicUrl }));

    return getSuggestionBaseOutputSchema.parse({
      eventId: event.id,
      slug: event.slug ?? null,
      attendanceMode: event.attendanceMode,
      stewardship: event.stewardship,
      base,
      attachedImages,
    });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("getSuggestionBase", execute);
  }

  return execute();
}
