import { describe, expect, it } from "vitest";

import { computeEventReadiness } from "../event-readiness";
import {
  mapReadinessInput,
  type ReadinessRailState,
} from "../readiness-input";

const baseState = (
  overrides: Partial<ReadinessRailState> = {},
): ReadinessRailState => ({
  title: "House Show",
  startsAt: "2026-08-01T19:00",
  hasVenue: true,
  hasCategory: true,
  detailsNonEmpty: true,
  ticketTypeCount: 1,
  hasPaidTicketTypes: false,
  isOrgOwner: true,
  eventStatus: "DRAFT",
  connectStatusKnown: true,
  payoutsEnabled: false,
  chargebackTermsAcceptedThisSession: false,
  storedChargebackTermsAcceptance: "unknown",
  visibilityMode: "EXACT",
  allHostAttestationChecked: false,
  lineupCount: 1,
  ...overrides,
});

describe("mapReadinessInput", () => {
  it("passes essentials/details/tickets/lineup state through", () => {
    const { input } = mapReadinessInput(
      baseState({
        title: "",
        startsAt: undefined,
        hasVenue: false,
        hasCategory: false,
        detailsNonEmpty: false,
        ticketTypeCount: 0,
        lineupCount: 0,
      }),
    );

    expect(input.title).toBe("");
    expect(input.startsAt).toBe("");
    expect(input.hasVenue).toBe(false);
    expect(input.hasCategory).toBe(false);
    expect(input.detailsNonEmpty).toBe(false);
    expect(input.ticketTypeCount).toBe(0);
    expect(input.lineupCount).toBe(0);
  });

  describe("category item (mirrors publish's EVENT_CATEGORY_MISSING gate)", () => {
    it("blocks readiness when the saved event has no category", () => {
      const { input } = mapReadinessInput(baseState({ hasCategory: false }));
      const readiness = computeEventReadiness(input);

      expect(readiness.items.find((item) => item.id === "category")).toEqual({
        id: "category",
        status: "todo",
        blocking: true,
      });
      expect(readiness.blockers.map((item) => item.id)).toEqual(["category"]);
      expect(readiness.allClear).toBe(false);
    });

    it("reads done when the saved event has a category", () => {
      const { input } = mapReadinessInput(baseState({ hasCategory: true }));
      const readiness = computeEventReadiness(input);

      expect(
        readiness.items.find((item) => item.id === "category")?.status,
      ).toBe("done");
      expect(readiness.allClear).toBe(true);
    });
  });

  describe("stripe item (mirrors blockedByStripeConnect)", () => {
    it("blocks an org-owned DRAFT paid event with payouts disabled", () => {
      const { input, hideStripeItem } = mapReadinessInput(
        baseState({
          hasPaidTicketTypes: true,
          isOrgOwner: true,
          eventStatus: "DRAFT",
          connectStatusKnown: true,
          payoutsEnabled: false,
        }),
      );

      expect(hideStripeItem).toBe(false);
      expect(input.stripeOnboarded).toBe(false);

      const readiness = computeEventReadiness(input);
      expect(
        readiness.blockers.map((item) => item.id),
      ).toContain("stripePayouts");
    });

    it("reads done once payouts are enabled", () => {
      const { input, hideStripeItem } = mapReadinessInput(
        baseState({ hasPaidTicketTypes: true, payoutsEnabled: true }),
      );

      expect(hideStripeItem).toBe(false);
      expect(input.stripeOnboarded).toBe(true);
    });

    it("omits the item for human-owned paid events (no status endpoint — banner was silent)", () => {
      const { input, hideStripeItem } = mapReadinessInput(
        baseState({
          hasPaidTicketTypes: true,
          isOrgOwner: false,
          // Query never runs for human owners; both flags are false-y noise.
          connectStatusKnown: false,
          payoutsEnabled: false,
        }),
      );

      expect(hideStripeItem).toBe(true);
      // Hidden item must never block publish-readiness.
      expect(input.stripeOnboarded).toBe(true);
      expect(computeEventReadiness(input).allClear).toBe(false); // terms still pending
      expect(
        computeEventReadiness(input).blockers.map((item) => item.id),
      ).toEqual(["chargebackTerms"]);
    });

    it("omits the item while the org status query hasn't succeeded", () => {
      const { input, hideStripeItem } = mapReadinessInput(
        baseState({
          hasPaidTicketTypes: true,
          isOrgOwner: true,
          connectStatusKnown: false,
        }),
      );

      expect(hideStripeItem).toBe(true);
      expect(input.stripeOnboarded).toBe(true);
    });

    it("never blocks non-DRAFT events (banner had a DRAFT gate)", () => {
      const { input, hideStripeItem } = mapReadinessInput(
        baseState({
          hasPaidTicketTypes: true,
          eventStatus: "PUBLISHED",
          connectStatusKnown: true,
          payoutsEnabled: false,
        }),
      );

      expect(hideStripeItem).toBe(false);
      expect(input.stripeOnboarded).toBe(true);
    });

    it("does not hide the (absent) item for free-only events", () => {
      const { hideStripeItem } = mapReadinessInput(
        baseState({ hasPaidTicketTypes: false, connectStatusKnown: false }),
      );

      // computeEventReadiness already omits the item when there are no paid
      // ticket types; hideStripeItem only covers the unknowable-status case.
      expect(hideStripeItem).toBe(false);
    });
  });

  describe("chargeback terms", () => {
    it("accepted this session ⇒ done", () => {
      const { input } = mapReadinessInput(
        baseState({
          hasPaidTicketTypes: true,
          chargebackTermsAcceptedThisSession: true,
        }),
      );

      expect(input.chargebackTermsAccepted).toBe(true);
    });

    it("a stored acceptance of the current version ⇒ done, with no in-builder accept", () => {
      const { input } = mapReadinessInput(
        baseState({
          hasPaidTicketTypes: true,
          payoutsEnabled: true,
          chargebackTermsAcceptedThisSession: false,
          storedChargebackTermsAcceptance: "current",
        }),
      );

      expect(input.chargebackTermsAccepted).toBe(true);
      expect(computeEventReadiness(input).blockers).toEqual([]);
    });

    it("a stale-version stored acceptance (required) stays a todo", () => {
      const { input } = mapReadinessInput(
        baseState({
          hasPaidTicketTypes: true,
          payoutsEnabled: true,
          storedChargebackTermsAcceptance: "required",
        }),
      );

      expect(input.chargebackTermsAccepted).toBe(false);
      expect(
        computeEventReadiness(input).blockers.map((item) => item.id),
      ).toEqual(["chargebackTerms"]);
    });

    it.each(["forbidden", "unknown"] as const)(
      "stored %s ⇒ the session flag decides",
      (stored) => {
        expect(
          mapReadinessInput(
            baseState({
              hasPaidTicketTypes: true,
              chargebackTermsAcceptedThisSession: false,
              storedChargebackTermsAcceptance: stored,
            }),
          ).input.chargebackTermsAccepted,
        ).toBe(false);
        expect(
          mapReadinessInput(
            baseState({
              hasPaidTicketTypes: true,
              chargebackTermsAcceptedThisSession: true,
              storedChargebackTermsAcceptance: stored,
            }),
          ).input.chargebackTermsAccepted,
        ).toBe(true);
      },
    );

    it("an in-builder accept wins over a stale stored record", () => {
      expect(
        mapReadinessInput(
          baseState({
            hasPaidTicketTypes: true,
            chargebackTermsAcceptedThisSession: true,
            storedChargebackTermsAcceptance: "required",
          }),
        ).input.chargebackTermsAccepted,
      ).toBe(true);
    });

    it("has no event-status gate: unaccepted stays a todo on a PUBLISHED event", () => {
      const { input } = mapReadinessInput(
        baseState({
          hasPaidTicketTypes: true,
          eventStatus: "PUBLISHED",
          payoutsEnabled: true,
          chargebackTermsAcceptedThisSession: false,
        }),
      );

      expect(input.chargebackTermsAccepted).toBe(false);
      expect(
        computeEventReadiness(input).blockers.map((item) => item.id),
      ).toEqual(["chargebackTerms"]);
    });
  });

  describe("host attestation (mirrors the publish flow's gate)", () => {
    it("is required only for DRAFT + OBSCURED", () => {
      expect(
        mapReadinessInput(
          baseState({ eventStatus: "DRAFT", visibilityMode: "OBSCURED" }),
        ).input.hostAttestationRequired,
      ).toBe(true);
      expect(
        mapReadinessInput(
          baseState({ eventStatus: "PUBLISHED", visibilityMode: "OBSCURED" }),
        ).input.hostAttestationRequired,
      ).toBe(false);
      expect(
        mapReadinessInput(
          baseState({ eventStatus: "DRAFT", visibilityMode: "EXACT" }),
        ).input.hostAttestationRequired,
      ).toBe(false);
    });

    it("mirrors allHostAttestationChecked as completion", () => {
      const { input } = mapReadinessInput(
        baseState({
          visibilityMode: "OBSCURED",
          allHostAttestationChecked: true,
        }),
      );

      expect(input.hostAttestationRequired).toBe(true);
      expect(input.hostAttestationComplete).toBe(true);
      expect(computeEventReadiness(input).allClear).toBe(true);
    });
  });
});
