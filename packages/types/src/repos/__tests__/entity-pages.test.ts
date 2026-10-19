import { describe, expect, it } from "vitest";

import {
  performerAcceptsBookingRequests,
  placeAcceptsBookingRequests,
  type EntitySummary,
} from "../entity-pages";

const HUMAN: Extract<EntitySummary, { type: "HUMAN" }> = {
  type: "HUMAN",
  id: "human-1",
  name: "Alice",
};

const ORG: Extract<EntitySummary, { type: "ORGANIZATION" }> = {
  type: "ORGANIZATION",
  id: "org-1",
  name: "The Band",
  slug: "the-band",
  trustTier: "NEW",
  trustBadgeLabel: null,
};

const PLACE: Extract<EntitySummary, { type: "PLACE" }> = {
  type: "PLACE",
  id: "place-1",
  name: "The Roxy",
  slug: "the-roxy",
  formattedAddress: null,
  city: null,
  region: null,
  lat: null,
  lng: null,
};

describe("performerAcceptsBookingRequests (organizer-booking-requests FR-009)", () => {
  it("is true only when the server set the flag on a HUMAN or ORGANIZATION summary", () => {
    expect(
      performerAcceptsBookingRequests({
        ...HUMAN,
        acceptsBookingRequests: true,
      }),
    ).toBe(true);
    expect(
      performerAcceptsBookingRequests({ ...ORG, acceptsBookingRequests: true }),
    ).toBe(true);
  });

  it("is false for explicit false AND for the undefined client-fallback default", () => {
    expect(
      performerAcceptsBookingRequests({
        ...HUMAN,
        acceptsBookingRequests: false,
      }),
    ).toBe(false);
    expect(performerAcceptsBookingRequests(HUMAN)).toBe(false);
    expect(performerAcceptsBookingRequests(ORG)).toBe(false);
  });

  it("never fires for PLACE summaries — that surface belongs to placeAcceptsBookingRequests", () => {
    expect(
      performerAcceptsBookingRequests({
        ...PLACE,
        acceptsBookingRequests: true,
        verified: true,
      }),
    ).toBe(false);
    // And the venue gate stays untouched by the new helper's fields.
    expect(
      placeAcceptsBookingRequests({
        ...PLACE,
        acceptsBookingRequests: true,
        verified: true,
      }),
    ).toBe(true);
    expect(placeAcceptsBookingRequests({ ...HUMAN, acceptsBookingRequests: true })).toBe(
      false,
    );
  });
});
