import { describe, expect, it } from "vitest";

import {
  DrainFlights,
  MAX_COALESCED_RERUNS,
  MAX_FLIGHT_AGE_MS,
  MAX_FLIGHT_WORK_MS,
  isDrainWakeUp,
  resultHasMore,
} from "../drain-flights";

describe("DrainFlights", () => {
  it("coalesces into an open flight and runs ONE follow-up per burst", async () => {
    const flights = new DrainFlights();
    const flight = flights.begin("community.dispatch-rsvp-confirmations");
    expect(flights.coalesce("community.dispatch-rsvp-confirmations")).toBe(true);
    expect(flights.coalesce("community.dispatch-rsvp-confirmations")).toBe(true);

    const payloads: unknown[] = [];
    const out = await flights.drainReruns(
      "community.dispatch-rsvp-confirmations",
      flight,
      async (p) => {
        payloads.push(p);
        return { hasMore: false };
      },
    );
    expect(out).toEqual({ results: [{ hasMore: false }], capped: false });
    expect(payloads).toEqual([{ freshOnly: true }]);
  });

  it("caps follow-ups and reports it so the caller hands off", async () => {
    const flights = new DrainFlights();
    const name = "moderation.drain-image-moderations";
    const flight = flights.begin(name);
    flight.rerun = true;
    const out = await flights.drainReruns(name, flight, async () => {
      flight.rerun = true; // woken again during every pass
      return {};
    });
    expect(out.results).toHaveLength(MAX_COALESCED_RERUNS);
    expect(out.capped).toBe(true);
  });

  it("stops starting follow-ups once the flight has worked MAX_FLIGHT_WORK_MS (Cloud Run 300s timeout)", async () => {
    let t = 0;
    const flights = new DrainFlights(() => t);
    const name = "events.dispatch-change-notifications";
    const flight = flights.begin(name);
    flight.rerun = true;
    t = MAX_FLIGHT_WORK_MS;
    const run = async () => ({});
    const out = await flights.drainReruns(name, flight, run);
    expect(out).toEqual({ results: [], capped: true });
  });

  it("end() is identity-checked: an older request never closes a newer flight", () => {
    const flights = new DrainFlights();
    const a = flights.begin("x");
    flights.begin("x");
    flights.end("x", a);
    expect(flights.isOpen("x")).toBe(true);
  });

  it("treats a flight older than any request can live as dead", () => {
    let t = 0;
    const flights = new DrainFlights(() => t);
    flights.begin("x");
    t = MAX_FLIGHT_AGE_MS + 1;
    expect(flights.coalesce("x")).toBe(false);
    expect(flights.isOpen("x")).toBe(false);
  });
});

describe("isDrainWakeUp", () => {
  it("matches only the exact trigger payload of a triggered drain", () => {
    expect(isDrainWakeUp("community.dispatch-rsvp-confirmations", { freshOnly: true })).toBe(true);
    expect(isDrainWakeUp("community.dispatch-rsvp-confirmations", {})).toBe(false);
    expect(isDrainWakeUp("moderation.drain-image-moderations", {})).toBe(true);
    expect(isDrainWakeUp("moderation.drain-image-moderations", undefined)).toBe(true);
    expect(isDrainWakeUp("tickets.release-expired-carts", {})).toBe(false);
    // The scheduled safety net marks itself, so it never reads as a wake-up.
    for (const name of [
      "community.dispatch-rsvp-confirmations",
      "events.dispatch-change-notifications",
      "moderation.drain-image-moderations",
    ]) {
      expect(isDrainWakeUp(name, { origin: "schedule" })).toBe(false);
    }
  });
});

describe("resultHasMore", () => {
  it("reads the drain-loop flag", () => {
    expect(resultHasMore({ hasMore: true })).toBe(true);
    expect(resultHasMore({ hasMore: false })).toBe(false);
    expect(resultHasMore(null)).toBe(false);
  });
});
