import { vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type {
  AttendeeReviewRecord,
  AttendeeReviewsRepo,
  CreateAttendeeReviewInput,
} from "@th/ports/repos/attendee-reviews";

import { fail } from "@th/errors";

export const NOW = new Date("2026-07-14T15:00:00.000Z");

export const EVENT_ID = "eeeeeeee-1111-4111-8111-eeeeeeeeeeee";
export const HUMAN_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
export const PLACE_ID = "cccccccc-1111-4111-8111-cccccccccccc";
export const ORG_ID = "dddddddd-1111-4111-8111-dddddddddddd";
export const OWNER_HUMAN_ID = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb";
export const SERIES_ID = "ffffffff-1111-4111-8111-ffffffffffff";

/** Ended 2 days ago — inside the 30-day window relative to NOW. */
export function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: EVENT_ID,
    title: "Loud Night",
    status: "PUBLISHED",
    startsAt: new Date("2026-07-12T22:00:00.000Z"),
    endsAt: new Date("2026-07-12T23:30:00.000Z"),
    placeId: PLACE_ID,
    orgId: ORG_ID,
    humanId: null,
    ...overrides,
  };
}

export function makeClock(now: Date = NOW): ClockPort {
  return { now: vi.fn(() => now) };
}

/**
 * Stateful in-memory AttendeeReviewsRepo: `create` enforces the
 * (eventId, humanId) unique pair exactly like the DB index (throwing the
 * same AppError the adapter maps P2002 to), so duplicate tests exercise
 * both the pre-check and the backstop.
 */
export function makeFakeAttendeeReviewsRepo(args?: {
  seed?: AttendeeReviewRecord[];
  scanned?: boolean;
}) {
  const rows: AttendeeReviewRecord[] = [...(args?.seed ?? [])];
  let counter = 0;

  const repo: AttendeeReviewsRepo = {
    create: vi.fn(async (input: CreateAttendeeReviewInput) => {
      if (
        rows.some(
          (r) => r.eventId === input.eventId && r.humanId === input.humanId,
        )
      ) {
        throw fail("ATTENDEE_REVIEW_ALREADY_SUBMITTED");
      }
      counter += 1;
      const record: AttendeeReviewRecord = {
        // Valid uuid — the submit output schema checks it.
        id: `00000000-0000-4000-8000-00000000000${counter}`,
        eventId: input.eventId,
        humanId: input.humanId,
        anonymousName: null,
        anonymousEmail: null,
        source: "VERIFIED_TICKET",
        overallRating: input.overallRating,
        soundQuality: input.soundQuality ?? null,
        venueComfort: input.venueComfort ?? null,
        organization: input.organization ?? null,
        valueForMoney: input.valueForMoney ?? null,
        text: input.text ?? null,
        placeId: input.placeId ?? null,
        ownerType: input.ownerType ?? null,
        ownerId: input.ownerId ?? null,
        seriesId: input.seriesId ?? null,
        hidden: false,
        flagged: false,
        flagReason: null,
        createdAt: NOW,
        updatedAt: NOW,
      };
      rows.push(record);
      return record;
    }),
    findByEventAndHuman: vi.fn(
      async ({ eventId, humanId }) =>
        rows.find(
          (r) => r.eventId === eventId && r.humanId === humanId,
        ) ?? null,
    ),
    hasScannedTicket: vi.fn(async () => args?.scanned ?? true),
  };

  return { repo, rows };
}
