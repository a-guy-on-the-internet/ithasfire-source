import { describe, expect, it, vi } from "vitest";

import type { Ctx } from "../../context";
import { humansRouter } from "../humans";
import { createCaller } from "./test-helpers";

/**
 * `humans.getMyNextNight` — the navbar account-menu block. Pins the wire:
 * the actor comes from the session (no input can name anyone else), the
 * viewer id reaches every source, the result passes the output schema, a
 * signed-out caller is refused, and a failing source fails the query.
 */
const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const ORDER_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-10-07T18:00:00.000Z");
const STARTS = new Date("2026-10-08T01:00:00.000Z");

function buildRepos(options: { failRsvps?: boolean } = {}) {
  return {
    // A verified actor (B2: an unverified one gets null, see
    // verified-email-gate.test.ts).
    humans: {
      getByIdWithIdentity: vi.fn(async () => ({
        identity: { emailVerified: true },
      })),
    },
    tickets: {
      listUpcomingHeldEvents: vi.fn(async () => [
        {
          eventId: EVENT_ID,
          startsAt: STARTS,
          ticketCount: 2,
          latestOwnOrderId: ORDER_ID,
        },
      ]),
    },
    eventRsvps: {
      listUpcomingEventsForUser: vi.fn(async () => {
        if (options.failRsvps) throw new Error("rsvps down");
        return [];
      }),
    },
    eventHumans: { listLineupsByHuman: vi.fn(async () => []) },
    events: {
      getById: vi.fn(async () => ({
        id: EVENT_ID,
        title: "Late Show",
        slug: "late-show",
        status: "PUBLISHED",
        gateType: "NONE",
        orgId: null,
        humanId: ACTOR_ID,
        placeId: null,
        startsAt: STARTS,
        endsAt: new Date(STARTS.getTime() + 3 * 3600_000),
        timezone: "America/Chicago",
        locationMode: "EXACT",
        addressText: "1 Secret Way",
        locality: "Nashville",
        region: "TN",
      })),
    },
    places: { getById: vi.fn(async () => null) },
  } as unknown as Ctx["repos"];
}

const clock = { now: () => NOW } as unknown as Ctx["clock"];

describe("humansRouter.getMyNextNight", () => {
  it("returns the viewer's next night, scoped to the session actor", async () => {
    const repos = buildRepos();
    const { caller } = createCaller(humansRouter, {
      repos,
      clock,
      actorHumanId: ACTOR_ID,
    });

    const result = await caller.getMyNextNight();

    expect(result).toEqual({
      kind: "ticket",
      eventId: EVENT_ID,
      slug: "late-show",
      title: "Late Show",
      startsAt: STARTS,
      timezone: "America/Chicago",
      placeLabel: "Nashville, TN",
      ticketCount: 2,
      orderId: ORDER_ID,
    });
    expect(repos.tickets.listUpcomingHeldEvents).toHaveBeenCalledWith(
      expect.objectContaining({ humanId: ACTOR_ID, now: NOW }),
    );
    expect(repos.eventRsvps.listUpcomingEventsForUser).toHaveBeenCalledWith(
      expect.objectContaining({ humanId: ACTOR_ID }),
    );
    expect(repos.eventHumans.listLineupsByHuman).toHaveBeenCalledWith(
      expect.objectContaining({ humanId: ACTOR_ID }),
    );
  });

  it("refuses a caller with no actor", async () => {
    const { caller } = createCaller(humansRouter, {
      repos: buildRepos(),
      clock,
      actorHumanId: null,
    });
    await expect(caller.getMyNextNight()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("fails the query when a source throws (no silent fallback)", async () => {
    const { caller } = createCaller(humansRouter, {
      repos: buildRepos({ failRsvps: true }),
      clock,
      actorHumanId: ACTOR_ID,
    });
    await expect(caller.getMyNextNight()).rejects.toBeTruthy();
  });
});
