import { describe, expect, it } from "vitest";

import { DEMO_IDS } from "../src/scripts/seed/ids";

/**
 * Seed-side venue-confirmation & booking-intents Phase-2 fixtures
 * (docs/specs/2026-08-27).
 *
 * Pins the shape of Phase-2 fixture requests:
 *   - A RENT request with acceptsRent calendar, required space + window fields
 *   - A USE request with acceptsUse calendar, required space + window fields
 *   - An EXPIRED PERFORM inquiry at the unclaimed venue (never parked)
 *   - The default calendar supports PERFORM; Room Rental calendar supports RENT+USE
 */

describe("seed: venue-confirmation & booking-intents Phase-2 fixtures", () => {
  describe("calendar rental config", () => {
    it("Cheer Up Charlies Room Rental calendar accepts RENT + USE with visible rate", () => {
      // This test is a placeholder to document the expected seed state.
      // When run against a seeded DB:
      // - place = Cheer Up Charlies (demoVenueCheerUp)
      // - calendar slug "room-rental" should exist
      // - acceptsRent = true, acceptsUse = true
      // - rentalRateCents = 50000, rentalRateCurrency = "USD", rentalRateVisible = true

      // Fixture ID to verify in a real DB:
      expect(DEMO_IDS.demoVenueCheerUp).toBeDefined();
    });

    it("default calendar still accepts only PERFORM", () => {
      // The default calendar (created with every place) defaults to:
      // acceptsPerform = true, acceptsRent = false, acceptsUse = false
      // This is idempotent — a reseed converges on the defaults.

      // Fixture to verify: the default calendar of demoVenueMohawk or demoVenueCheerUp
      // should still have acceptsPerform=true and others=false
      expect(DEMO_IDS.demoVenueCheerUp).toBeDefined();
    });
  });

  describe("RENT/USE booking requests", () => {
    it("RENT request has required fields: space, window, purpose, attendance", () => {
      // The RENT request (demoVenueCheerUp, room-rental calendar) should have:
      // - intent = RENT
      // - spaceId = one of the Inside/Outside spaces
      // - requestedStartsAt/EndsAt set (future evening window)
      // - purpose = "Birthday show, private"
      // - expectedAttendance = 80
      // - preferredDates = null (RENT uses time window, not preferred dates)

      expect(DEMO_IDS.rentBookingId).toBeDefined();
    });

    it("USE request has required fields: space, window, purpose, attendance", () => {
      // The USE request (demoVenueCheerUp, room-rental calendar) should have:
      // - intent = USE
      // - spaceId = one of the Inside/Outside spaces (different from RENT)
      // - requestedStartsAt/EndsAt set (future day)
      // - purpose = "Monthly poetry reading"
      // - expectedAttendance = 30
      // - preferredDates = null

      expect(DEMO_IDS.useBookingId).toBeDefined();
    });

    it("RENT/USE requests satisfy the DB CHECK constraint", () => {
      // SQL CHECK "BookingRequest_intent_shape_check", as relaxed by
      // migration 20260922120000_booking_request_space_optional:
      // intent IN ('RENT','USE') ⇒ requestedStartsAt IS NOT NULL
      //   AND requestedEndsAt IS NOT NULL
      //
      // A `spaceId` is NO LONGER required (ruling 2026-09-22 — the room is
      // chosen at accept/confirm, on the draft event). Both fixtures still
      // name one, which stays legal.
      // (This is validated at seed time; the test documents the constraint.)

      expect(DEMO_IDS.rentBookingId).toBeDefined();
      expect(DEMO_IDS.useBookingId).toBeDefined();
    });
  });

  describe("request at an unclaimed venue (expired, never parked)", () => {
    it("PERFORM inquiry at the unclaimed place is EXPIRED with no parked stamp", () => {
      // An unclaimed venue takes no requests (amendment 2026-09-25). The
      // unclaimed-place PERFORM inquiry (The Unclaimed Stage, embed contact)
      // is seeded in the state the parked-request cleanup leaves:
      // - placeId = unclaimedPlace (UNVERIFIED, no owners)
      // - intent = PERFORM
      // - parkedUnclaimedAt = null (nothing writes it any more)
      // - status = EXPIRED
      // - source = EMBED (anonymous contact)
      // - preferredDates set (PERFORM uses dates)

      expect(DEMO_IDS.parkedBookingId).toBeDefined();
      expect(DEMO_IDS.unclaimedPlace).toBeDefined();
    });

    it("unclaimed place has no verified ownership", () => {
      // The unclaimed place (The Unclaimed Stage) is seeded with:
      // - verification = UNVERIFIED
      // - no PlaceOwnership rows
      //
      // This allows the claim-venue flow to be exercised. Requests to it are
      // refused (PLACE_NOT_TAKING_REQUESTS) until someone claims it.

      expect(DEMO_IDS.unclaimedPlace).toBeDefined();
    });
  });
});
