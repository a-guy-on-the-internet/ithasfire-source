import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import type { ImageRecord } from "@th/ports/repos/images";

import { getSuggestionBase } from "../get-suggestion-base";
import {
  EVENT_ID,
  IMAGE_ID,
  makeCommunityEvent,
  makeImage,
  makeOrgEvent,
  makeValidBody,
} from "./helpers";

const OTHER_IMAGE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function makeRepos(params: {
  event?: EventRecord | null;
  images?: ImageRecord[];
  content?: unknown | null;
  slugResolution?: { eventId: string; currentSlug: string; redirect: boolean } | null;
  place?: unknown | null;
}) {
  const getById = vi.fn(async () => params.event ?? null);
  const resolveBySlug = vi.fn(async () => params.slugResolution ?? null);
  const getContent = vi.fn(async () => params.content ?? null);
  const listByEventId = vi.fn(async () => params.images ?? []);
  const getPlaceById = vi.fn(async () => params.place ?? null);

  const repos = {
    events: { getById, resolveBySlug, getContent },
    images: { listByEventId },
    places: { getById: getPlaceById },
  } as unknown as Repos;

  return {
    repos,
    getById,
    resolveBySlug,
    getContent,
    listByEventId,
    getPlaceById,
  };
}

describe("getSuggestionBase", () => {
  it("returns the whitelisted base snapshot + attached images by eventId", async () => {
    const content = makeValidBody();
    const attached = makeImage({ attached: true, attachedAt: new Date() });
    const unattached = makeImage({ id: OTHER_IMAGE_ID, attached: false });
    const event = makeCommunityEvent({
      heroImageUrl: attached.publicUrl,
    });
    const { repos } = makeRepos({
      event,
      images: [attached, unattached],
      content,
    });

    const result = await getSuggestionBase({ repos }, { eventId: EVENT_ID });

    expect(result.eventId).toBe(EVENT_ID);
    expect(result.slug).toBe(event.slug);
    expect(result.attendanceMode).toBe("RSVP");
    expect(result.stewardship).toBe("COMMUNITY");
    expect(result.base).toMatchObject({
      title: event.title,
      content,
      startsAt: event.startsAt.toISOString(),
      endsAt: event.endsAt!.toISOString(),
      timezone: event.timezone,
      addressText: event.addressText,
      countryCode: event.countryCode,
      region: event.region,
      locality: event.locality,
      postalCode: event.postalCode,
      lat: event.lat,
      lng: event.lng,
      categoryId: null,
      heroImageId: IMAGE_ID,
      ageLimit: null,
    });
    // Unattached (pre-approval suggestion upload) images stay non-public.
    expect(result.attachedImages).toEqual([
      { id: IMAGE_ID, publicUrl: attached.publicUrl },
    ]);
  });

  it("resolves by slug (including redirected legacy slugs)", async () => {
    const event = makeCommunityEvent();
    const { repos, resolveBySlug, getById } = makeRepos({
      event,
      slugResolution: {
        eventId: event.id,
        currentSlug: event.slug!,
        redirect: true,
      },
    });

    const result = await getSuggestionBase({ repos }, { slug: "legacy-slug" });

    expect(resolveBySlug).toHaveBeenCalledWith("legacy-slug");
    expect(getById).toHaveBeenCalledWith(event.id);
    expect(result.eventId).toBe(event.id);
    expect(result.attendanceMode).toBe("RSVP");
    expect(result.stewardship).toBe("COMMUNITY");
  });

  it("collapses missing, unpublished and non-public events to EVENT_NOT_FOUND", async () => {
    for (const event of [
      null,
      makeCommunityEvent({ status: "DRAFT" }),
      makeCommunityEvent({ visibility: "PRIVATE" } as Partial<EventRecord>),
    ]) {
      const { repos } = makeRepos({ event });
      await expect(
        getSuggestionBase({ repos }, { eventId: EVENT_ID }),
      ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
    }
  });

  // COMMUNITY-only (product decision 2026-07-20 reversing FR-006's universal
  // scope): the /suggest page must 404 for OWNED events even when they are
  // PUBLISHED and PUBLIC — same collapse as drafts/private (no stewardship
  // probing on the anonymous surface).
  it("collapses an OWNED PUBLISHED PUBLIC event to EVENT_NOT_FOUND (suggestions are COMMUNITY-only)", async () => {
    const event = makeOrgEvent();
    expect(event.status).toBe("PUBLISHED");
    expect(event.visibility).toBe("PUBLIC");

    const { repos } = makeRepos({ event });
    await expect(
      getSuggestionBase({ repos }, { eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });

    // Same via slug resolution.
    const bySlug = makeRepos({
      event,
      slugResolution: {
        eventId: event.id,
        currentSlug: event.slug!,
        redirect: false,
      },
    });
    await expect(
      getSuggestionBase({ repos: bySlug.repos }, { slug: event.slug! }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("nulls the geo group for OBSCURED and missing location modes (fail closed)", async () => {
    const content = makeValidBody();
    // A missing/unknown mode is redacted too — only the literal "EXACT"
    // keeps the geo group (public-coordinate.ts fail-closed convention).
    for (const locationMode of ["OBSCURED", undefined] as const) {
      const event = makeCommunityEvent({
        locationMode,
        ageLimit: 18,
      } as Partial<EventRecord>);
      const { repos } = makeRepos({ event, content });

      const result = await getSuggestionBase({ repos }, { eventId: EVENT_ID });

      // Structured address/pin never leaves the server for non-EXACT modes.
      expect(result.base).toMatchObject({
        addressText: null,
        countryCode: null,
        region: null,
        locality: null,
        postalCode: null,
        lat: null,
        lng: null,
      });
      // Non-geo fields still hydrate the propose form.
      expect(result.base.title).toBe(event.title);
      expect(result.base.content).toEqual(content);
      expect(result.base.timezone).toBe(event.timezone);
      expect(result.base.ageLimit).toBe(18);
    }
  });

  it("keeps the geo group for the EXACT location mode only", async () => {
    const event = makeCommunityEvent({
      locationMode: "EXACT",
    } as Partial<EventRecord>);
    const { repos } = makeRepos({ event });

    const result = await getSuggestionBase({ repos }, { eventId: EVENT_ID });

    expect(result.base.addressText).toBe(event.addressText);
    expect(result.base.lat).toBe(event.lat);
    expect(result.base.lng).toBe(event.lng);
  });

  // L2: the event row's own mode is not the answer — its venue is a floor.
  describe("venue floor", () => {
    const VENUE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const VENUE_BASE = {
      id: VENUE_ID,
      name: "The Shelby House",
      formattedAddress: "123 Main St, Austin, TX",
      city: "Austin",
      region: "TX",
      countryCode: "US",
      lat: 30.27,
      lng: -97.74,
    };
    const GEO_NULLED = {
      addressText: null,
      countryCode: null,
      region: null,
      locality: null,
      postalCode: null,
      lat: null,
      lng: null,
    };

    it("nulls the geo group for an EXACT event at a venue that WITHHOLDS its address", async () => {
      for (const locationRadiusMeters of [800, null]) {
        const event = makeCommunityEvent({
          locationMode: "EXACT",
          placeId: VENUE_ID,
        } as Partial<EventRecord>);
        const { repos, getPlaceById } = makeRepos({
          event,
          place: { ...VENUE_BASE, locationMode: "OBSCURED", locationRadiusMeters },
        });

        const result = await getSuggestionBase({ repos }, { eventId: EVENT_ID });

        expect(getPlaceById).toHaveBeenCalledWith(VENUE_ID);
        expect(result.base).toMatchObject(GEO_NULLED);
        expect(JSON.stringify(result)).not.toContain("123 Main St");
        // Non-geo fields still hydrate the propose form.
        expect(result.base.title).toBe(event.title);
      }
    });

    it("nulls the geo group when the event's venue is GONE (fail closed, not 'no venue')", async () => {
      const event = makeCommunityEvent({
        locationMode: "EXACT",
        placeId: VENUE_ID,
      } as Partial<EventRecord>);
      const { repos } = makeRepos({ event, place: null });

      const result = await getSuggestionBase({ repos }, { eventId: EVENT_ID });

      expect(result.base).toMatchObject(GEO_NULLED);
    });

    it("keeps the geo group for an EXACT event at an EXACT venue", async () => {
      const event = makeCommunityEvent({
        locationMode: "EXACT",
        placeId: VENUE_ID,
      } as Partial<EventRecord>);
      const { repos } = makeRepos({
        event,
        place: { ...VENUE_BASE, locationMode: "EXACT", locationRadiusMeters: null },
      });

      const result = await getSuggestionBase({ repos }, { eventId: EVENT_ID });

      expect(result.base.addressText).toBe(event.addressText);
      expect(result.base.lat).toBe(event.lat);
      expect(result.base.lng).toBe(event.lng);
    });

    it("an OBSCURED event at an EXACT venue is still redacted", async () => {
      const event = makeCommunityEvent({
        locationMode: "OBSCURED",
        placeId: VENUE_ID,
      } as Partial<EventRecord>);
      const { repos } = makeRepos({
        event,
        place: { ...VENUE_BASE, locationMode: "EXACT", locationRadiusMeters: null },
      });

      const result = await getSuggestionBase({ repos }, { eventId: EVENT_ID });

      expect(result.base).toMatchObject(GEO_NULLED);
    });

    it("a freeform event never reads a place", async () => {
      const { repos, getPlaceById } = makeRepos({
        event: makeCommunityEvent({ locationMode: "EXACT" } as Partial<EventRecord>),
      });
      await getSuggestionBase({ repos }, { eventId: EVENT_ID });
      expect(getPlaceById).not.toHaveBeenCalled();
    });
  });

  it("404s on an unresolvable slug", async () => {
    const { repos } = makeRepos({ slugResolution: null });
    await expect(
      getSuggestionBase({ repos }, { slug: "nope" }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("rejects when neither or both of eventId/slug are provided", async () => {
    const { repos } = makeRepos({ event: makeCommunityEvent() });

    await expect(getSuggestionBase({ repos }, {})).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      getSuggestionBase({ repos }, { eventId: EVENT_ID, slug: "x" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
