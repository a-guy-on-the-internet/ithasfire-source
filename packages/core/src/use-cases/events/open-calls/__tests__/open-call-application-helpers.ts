/**
 * Shared setup for the open-call APPLICATION tests (open calls v1 step 4).
 */
import { randomUUID } from "node:crypto";

import type { ClockPort } from "@th/ports/clock";
import type { EventDateRecord } from "@th/ports/repos/event-dates";
import { OC_EVENT_ID, createOpenCallWorld, type OpenCallWorld } from "@th/test-utils/fakes/open-calls";

export const DAY = 24 * 60 * 60 * 1000;

/** The status-token key the tests sign with (>= 32 chars). */
export const TEST_STATUS_TOKEN_SECRET = "test-open-call-status-token-secret-0123456789";

export function setupApplying(opts: { now?: Date } = {}) {
  const world = createOpenCallWorld(opts);
  let now = world.now;
  const clock = { now: () => now } as unknown as ClockPort;
  const deps = { repos: world.repos, clock, statusTokenSecret: TEST_STATUS_TOKEN_SECRET };
  return {
    world,
    deps,
    /** Move the clock (the world's own `now` stays the seeding time). */
    setNow: (d: Date) => {
      now = d;
    },
  };
}

export function addEventDate(
  world: OpenCallWorld,
  startsAt: Date,
  status: EventDateRecord["status"] = "SCHEDULED",
  eventId = OC_EVENT_ID,
): EventDateRecord {
  const row: EventDateRecord = {
    id: randomUUID(),
    eventId,
    ordinal: world.eventDates.length + 1,
    startsAt,
    endsAt: null,
    status,
    createdAt: world.now,
    updatedAt: world.now,
  };
  world.eventDates.push(row);
  return row;
}

export const guest = (overrides: Record<string, unknown> = {}) => ({
  name: "The Moths",
  email: "Moths@Example.com",
  url: "https://moths.example.com",
  ...overrides,
});
