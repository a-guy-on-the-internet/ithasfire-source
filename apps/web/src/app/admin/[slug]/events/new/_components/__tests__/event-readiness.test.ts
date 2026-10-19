import { describe, expect, it } from "vitest";

import {
  computeEventReadiness,
  type EventReadinessInput,
} from "../event-readiness";

const baseInput = (
  overrides: Partial<EventReadinessInput> = {},
): EventReadinessInput => ({
  title: "House Show",
  startsAt: "2026-08-01T19:00",
  hasVenue: true,
  hasCategory: true,
  detailsNonEmpty: true,
  ticketTypeCount: 1,
  hasPaidTicketTypes: false,
  stripeOnboarded: false,
  chargebackTermsAccepted: false,
  hostAttestationRequired: false,
  hostAttestationComplete: false,
  lineupCount: 1,
  ...overrides,
});

const itemIds = (result: ReturnType<typeof computeEventReadiness>) =>
  result.items.map((item) => item.id);

const findItem = (
  result: ReturnType<typeof computeEventReadiness>,
  id: string,
) => result.items.find((item) => item.id === id);

describe("computeEventReadiness", () => {
  it("returns all-clear when every check passes (free event)", () => {
    const result = computeEventReadiness(baseInput());

    expect(result.allClear).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.items.every((item) => item.status === "done")).toBe(true);
  });

  it("keeps a fixed item order", () => {
    const result = computeEventReadiness(
      baseInput({ hasPaidTicketTypes: true, hostAttestationRequired: true }),
    );

    expect(itemIds(result)).toEqual([
      "essentials",
      "category",
      "details",
      "ticketTypes",
      "lineup",
      "stripePayouts",
      "chargebackTerms",
      "hostAttestation",
    ]);
  });

  it("omits the Stripe and chargeback items entirely for free-only events", () => {
    const result = computeEventReadiness(
      baseInput({ hasPaidTicketTypes: false, stripeOnboarded: false }),
    );

    expect(itemIds(result)).not.toContain("stripePayouts");
    expect(itemIds(result)).not.toContain("chargebackTerms");
    expect(result.allClear).toBe(true);
  });

  it("blocks a paid event when Stripe payouts are not onboarded", () => {
    const result = computeEventReadiness(
      baseInput({
        hasPaidTicketTypes: true,
        stripeOnboarded: false,
        chargebackTermsAccepted: true,
      }),
    );

    expect(findItem(result, "stripePayouts")).toEqual({
      id: "stripePayouts",
      status: "todo",
      blocking: true,
    });
    expect(result.blockers.map((item) => item.id)).toEqual(["stripePayouts"]);
    expect(result.allClear).toBe(false);
  });

  it("passes a paid event once Stripe payouts are onboarded", () => {
    const result = computeEventReadiness(
      baseInput({
        hasPaidTicketTypes: true,
        stripeOnboarded: true,
        chargebackTermsAccepted: true,
      }),
    );

    expect(findItem(result, "stripePayouts")?.status).toBe("done");
    expect(result.allClear).toBe(true);
  });

  it("blocks a paid event while chargeback terms are pending", () => {
    const result = computeEventReadiness(
      baseInput({
        hasPaidTicketTypes: true,
        stripeOnboarded: true,
        chargebackTermsAccepted: false,
      }),
    );

    expect(findItem(result, "chargebackTerms")).toEqual({
      id: "chargebackTerms",
      status: "todo",
      blocking: true,
    });
    expect(result.blockers.map((item) => item.id)).toEqual(["chargebackTerms"]);
    expect(result.allClear).toBe(false);
  });

  it("blocks when host attestation is required but incomplete", () => {
    const result = computeEventReadiness(
      baseInput({
        hostAttestationRequired: true,
        hostAttestationComplete: false,
      }),
    );

    expect(findItem(result, "hostAttestation")).toEqual({
      id: "hostAttestation",
      status: "todo",
      blocking: true,
    });
    expect(result.allClear).toBe(false);
  });

  it("marks host attestation done when required and complete", () => {
    const result = computeEventReadiness(
      baseInput({
        hostAttestationRequired: true,
        hostAttestationComplete: true,
      }),
    );

    expect(findItem(result, "hostAttestation")?.status).toBe("done");
    expect(result.allClear).toBe(true);
  });

  it("omits the host attestation item when not required", () => {
    const result = computeEventReadiness(
      baseInput({
        hostAttestationRequired: false,
        // Complete flag is irrelevant when not required.
        hostAttestationComplete: false,
      }),
    );

    expect(itemIds(result)).not.toContain("hostAttestation");
    expect(result.allClear).toBe(true);
  });

  it("treats an empty lineup as informational, never blocking", () => {
    const result = computeEventReadiness(baseInput({ lineupCount: 0 }));

    expect(findItem(result, "lineup")).toEqual({
      id: "lineup",
      status: "info",
      blocking: false,
    });
    expect(result.blockers).toEqual([]);
    expect(result.allClear).toBe(true);
  });

  it("marks the lineup done when at least one entry exists", () => {
    const result = computeEventReadiness(baseInput({ lineupCount: 2 }));

    expect(findItem(result, "lineup")).toEqual({
      id: "lineup",
      status: "done",
      blocking: false,
    });
  });

  it("blocks on missing essentials (title, starts-at, venue)", () => {
    for (const overrides of [
      { title: "" },
      { startsAt: "" },
      { hasVenue: false },
    ] satisfies Partial<EventReadinessInput>[]) {
      const result = computeEventReadiness(baseInput(overrides));

      expect(findItem(result, "essentials")).toEqual({
        id: "essentials",
        status: "todo",
        blocking: true,
      });
      expect(result.allClear).toBe(false);
    }
  });

  it("blocks when the event has no category (publish refuses EVENT_CATEGORY_MISSING)", () => {
    const result = computeEventReadiness(baseInput({ hasCategory: false }));

    expect(findItem(result, "category")).toEqual({
      id: "category",
      status: "todo",
      blocking: true,
    });
    expect(result.blockers.map((item) => item.id)).toEqual(["category"]);
    expect(result.allClear).toBe(false);
  });

  it("marks the category done once the event has one", () => {
    const result = computeEventReadiness(baseInput({ hasCategory: true }));

    expect(findItem(result, "category")).toEqual({
      id: "category",
      status: "done",
      blocking: true,
    });
    expect(result.allClear).toBe(true);
  });

  it("blocks on empty details and on zero ticket types", () => {
    const noDetails = computeEventReadiness(
      baseInput({ detailsNonEmpty: false }),
    );
    expect(findItem(noDetails, "details")?.status).toBe("todo");
    expect(noDetails.allClear).toBe(false);

    const noTickets = computeEventReadiness(baseInput({ ticketTypeCount: 0 }));
    expect(findItem(noTickets, "ticketTypes")?.status).toBe("todo");
    expect(noTickets.allClear).toBe(false);
  });

  it("collects every unmet blocking item in blockers, in order", () => {
    const result = computeEventReadiness(
      baseInput({
        title: "",
        hasCategory: false,
        detailsNonEmpty: false,
        ticketTypeCount: 0,
        hasPaidTicketTypes: true,
        stripeOnboarded: false,
        chargebackTermsAccepted: false,
        hostAttestationRequired: true,
        hostAttestationComplete: false,
        lineupCount: 0,
      }),
    );

    expect(result.blockers.map((item) => item.id)).toEqual([
      "essentials",
      "category",
      "details",
      "ticketTypes",
      "stripePayouts",
      "chargebackTerms",
      "hostAttestation",
    ]);
    expect(result.allClear).toBe(false);
  });
});
