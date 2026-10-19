import { describe, expect, it, vi } from "vitest";

import {
  createCommunityListing,
  type CreateCommunityListingDeps,
} from "../create-community-listing";
import type { CreateCommunityListingInput as RepoCreateInput } from "@th/ports/repos/events";
import { ADMIN_ID, MODERATOR_ID, NOW, makeClock, makeContentFilter, makeStaffAuthz } from "./helpers";

const CREATED_EVENT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const BASE_INPUT = {
  actorHumanId: MODERATOR_ID,
  title: "Weekly Open Mic",
  // Duration template: 3 hours.
  startsAt: new Date("2026-08-04T20:00:00.000Z"),
  endsAt: new Date("2026-08-04T23:00:00.000Z"),
  timezone: "UTC",
  addressText: "123 Main St, Austin, TX",
  countryCode: "us",
  region: "TX",
  locality: "Austin",
  postalCode: "78701",
  lat: 30.27,
  lng: -97.74,
};

const WEEKLY_SCHEDULE = {
  kind: "RRULE" as const,
  rrule: "FREQ=WEEKLY",
  dtstart: "2026-08-04T20:00:00",
};

/**
 * tx fake wired for the recurrence path: create returns a stub row, an
 * in-memory `eventDates.bulkReplaceForEvent` records the dates and echoes them
 * back as SCHEDULED rows, and `applyCommunityEdit` captures the startsAt/endsAt
 * the use-case pins the Event to.
 */
type BulkReplaceRow = {
  id: string;
  eventId: string;
  ordinal: number;
  startsAt: Date;
  endsAt: Date | null;
  status: "SCHEDULED" | "CANCELLED";
  createdAt: Date;
  updatedAt: Date;
};

function buildDeps(
  overrides: {
    /** Override the rows `bulkReplaceForEvent` returns (post-reconciliation). */
    bulkReplaceReturn?: (args: {
      eventId: string;
      dates: Array<{ startsAt: Date; endsAt?: Date | null }>;
    }) => BulkReplaceRow[];
  } = {},
) {
  const createdRow = {
    id: CREATED_EVENT_ID,
    orgId: null,
    humanId: null,
    title: BASE_INPUT.title,
    status: "PUBLISHED" as const,
    attendanceMode: "RSVP" as const,
    stewardship: "COMMUNITY" as const,
    visibility: "PUBLIC",
    gateType: "NONE",
    timezone: BASE_INPUT.timezone,
    startsAt: BASE_INPUT.startsAt,
    endsAt: BASE_INPUT.endsAt,
    slug: "event/us/austin/weekly-open-mic",
    shortId: "abc123",
    publishedAt: NOW,
  };

  const createCommunityListingMock = vi.fn(async (input: RepoCreateInput) => ({
    ...createdRow,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    recurrenceSchedule: input.recurrenceSchedule ?? null,
  }));

  let lastBulkReplaceArgs: unknown = null;
  const bulkReplaceForEvent = vi.fn(
    async (args: {
      eventId: string;
      now: Date;
      dates: Array<{ startsAt: Date; endsAt?: Date | null }>;
    }) => {
      lastBulkReplaceArgs = args;
      const scheduled = overrides.bulkReplaceReturn
        ? overrides.bulkReplaceReturn(args)
        : args.dates
            .slice()
            .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
            .map((d, i) => ({
              id: `date-${i}`,
              eventId: args.eventId,
              ordinal: i + 1,
              startsAt: d.startsAt,
              endsAt: d.endsAt ?? null,
              status: "SCHEDULED" as const,
              createdAt: NOW,
              updatedAt: NOW,
            }));
      // A listing born in this tx has no prior occurrences, so the
      // reconciliation can never report a cancelled one.
      return { scheduled, cancelledDateIds: [] };
    },
  );

  const applyCommunityEdit = vi.fn(
    async (args: { eventId: string; fields: { startsAt?: Date; endsAt?: Date } }) => ({
      ...createdRow,
      startsAt: args.fields.startsAt ?? createdRow.startsAt,
      endsAt: args.fields.endsAt ?? createdRow.endsAt,
    }),
  );

  const audit = { log: vi.fn() };
  const categories = { getById: vi.fn(async () => ({ id: "c", active: true })) };

  const txRepos = {
    events: { createCommunityListing: createCommunityListingMock, applyCommunityEdit },
    eventDates: { bulkReplaceForEvent },
    categories,
    audit,
  };

  const deps: CreateCommunityListingDeps = {
    repos: {
      tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txRepos)),
    } as unknown as CreateCommunityListingDeps["repos"],
    authz: makeStaffAuthz({
      [MODERATOR_ID]: ["COMMUNITY_MODERATOR"],
      [ADMIN_ID]: ["ADMIN"],
    }),
    clock: makeClock(),
    contentFilter: makeContentFilter(),
  };

  return {
    deps,
    createCommunityListingMock,
    bulkReplaceForEvent,
    applyCommunityEdit,
    audit,
    getLastBulkReplaceArgs: () => lastBulkReplaceArgs,
  };
}

describe("createCommunityListing — recurrence", () => {
  it("expands the schedule into EventDate rows and pins Event.startsAt to the first upcoming date", async () => {
    const { deps, createCommunityListingMock, bulkReplaceForEvent, applyCommunityEdit } =
      buildDeps();

    const result = await createCommunityListing(deps, {
      ...BASE_INPUT,
      recurrenceSchedule: WEEKLY_SCHEDULE,
    });

    // The schedule JSON is persisted on the Event.
    expect(createCommunityListingMock.mock.calls[0]![0].recurrenceSchedule).toMatchObject(
      { kind: "RRULE", rrule: "FREQ=WEEKLY" },
    );

    // Occurrences were materialised.
    expect(bulkReplaceForEvent).toHaveBeenCalledTimes(1);
    const bulkArgs = bulkReplaceForEvent.mock.calls[0]![0];
    expect(bulkArgs.eventId).toBe(CREATED_EVENT_ID);
    expect(bulkArgs.now).toEqual(NOW);
    // Aug 4/11/18/25 (weekly, within the 12-month window, capped at 60).
    expect(bulkArgs.dates.length).toBeGreaterThanOrEqual(4);
    expect(bulkArgs.dates[0]!.startsAt.toISOString()).toBe("2026-08-04T20:00:00.000Z");
    // Duration preserved (3h).
    expect(bulkArgs.dates[0]!.endsAt?.toISOString()).toBe("2026-08-04T23:00:00.000Z");

    // Event pinned to the first upcoming occurrence.
    expect(applyCommunityEdit).toHaveBeenCalledTimes(1);
    expect(applyCommunityEdit.mock.calls[0]![0].fields.startsAt?.toISOString()).toBe(
      "2026-08-04T20:00:00.000Z",
    );
    expect(result.event.startsAt.toISOString()).toBe("2026-08-04T20:00:00.000Z");
  });

  it("leaves single-date listings unchanged (no EventDate rows, no pin) when schedule is absent", async () => {
    const { deps, bulkReplaceForEvent, applyCommunityEdit } = buildDeps();

    const result = await createCommunityListing(deps, BASE_INPUT);

    expect(bulkReplaceForEvent).not.toHaveBeenCalled();
    expect(applyCommunityEdit).not.toHaveBeenCalled();
    expect(result.event.startsAt).toEqual(BASE_INPUT.startsAt);
  });

  it("rejects a schedule that yields zero upcoming dates with a typed error", async () => {
    const { deps, bulkReplaceForEvent } = buildDeps();

    await expect(
      createCommunityListing(deps, {
        ...BASE_INPUT,
        // All FIXED_DATES are in the past relative to NOW (2026-07-01).
        recurrenceSchedule: {
          kind: "FIXED_DATES",
          dates: ["2020-01-01T20:00:00", "2020-02-01T20:00:00"],
        },
      }),
    ).rejects.toMatchObject({ code: "RECURRENCE_HAS_NO_UPCOMING_DATES" });

    // Expansion produced nothing → we never touch the EventDate table.
    expect(bulkReplaceForEvent).not.toHaveBeenCalled();
  });

  it("rejects an RRULE schedule missing its rrule string (Zod contract)", async () => {
    const { deps } = buildDeps();

    await expect(
      createCommunityListing(deps, {
        ...BASE_INPUT,
        recurrenceSchedule: { kind: "RRULE", dtstart: "2026-08-04T20:00:00" },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("surfaces the typed error (not a raw throw) for a syntactically malformed rrule", async () => {
    const { deps } = buildDeps();

    // "FREQ=NONSENSE" passes the Zod length check but the rrule package throws
    // on it → expandRecurrenceDates returns [] → typed BAD_REQUEST, not a 500.
    await expect(
      createCommunityListing(deps, {
        ...BASE_INPUT,
        recurrenceSchedule: { kind: "RRULE", rrule: "FREQ=NONSENSE", dtstart: "2026-08-04T20:00:00" },
      }),
    ).rejects.toMatchObject({ code: "RECURRENCE_HAS_NO_UPCOMING_DATES" });
  });

  it("pins Event.startsAt to the first UPCOMING date, never a past SCHEDULED row in the returned set", async () => {
    // Simulate slice 5's rolling-job reuse: bulkReplaceForEvent returns a PAST
    // SCHEDULED row ahead of the future ones (rows are ascending by startsAt).
    const pastStart = new Date("2026-06-01T20:00:00.000Z"); // before NOW (2026-07-01)
    const firstFutureStart = new Date("2026-08-04T20:00:00.000Z");
    const { deps, applyCommunityEdit } = buildDeps({
      bulkReplaceReturn: ({ eventId }) => [
        {
          id: "past",
          eventId,
          ordinal: 1,
          startsAt: pastStart,
          endsAt: new Date("2026-06-01T22:00:00.000Z"),
          status: "SCHEDULED",
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          id: "future-1",
          eventId,
          ordinal: 2,
          startsAt: firstFutureStart,
          endsAt: new Date("2026-08-04T23:00:00.000Z"),
          status: "SCHEDULED",
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    });

    const result = await createCommunityListing(deps, {
      ...BASE_INPUT,
      recurrenceSchedule: WEEKLY_SCHEDULE,
    });

    // The PAST row must NOT be chosen — Event pins to the first upcoming date.
    expect(applyCommunityEdit.mock.calls[0]![0].fields.startsAt?.toISOString()).toBe(
      firstFutureStart.toISOString(),
    );
    expect(result.event.startsAt.toISOString()).toBe(firstFutureStart.toISOString());
    expect(result.event.startsAt.getTime()).toBeGreaterThan(pastStart.getTime());
  });
});
