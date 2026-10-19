import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type { EventDateRecord } from "@th/types";
import type { EventRecord } from "@th/ports/repos/events";
import type {
  ImageModerationRecord,
  ImageModerationStatus,
} from "@th/ports/repos/image-moderation-records";
import type { PrimaryImageRef } from "@th/ports/repos/images";

import {
  getEventGatedPreview,
  type GetEventGatedPreviewDeps,
} from "../get-event-gated-preview";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const KEY = "events/event-1/images/img-1.png";
const URL = `https://cdn.example/${KEY}`;

const BASE_EVENT = {
  id: EVENT_ID,
  slug: "secret-show",
  title: "Secret Show",
  status: "PUBLISHED",
  publishedAt: new Date("2026-07-01T00:00:00.000Z"),
  startsAt: new Date("2026-10-10T01:00:00.000Z"),
  timezone: "America/Chicago",
  recurrenceSchedule: null,
  // Location columns a careless spread would leak — the preview must not.
  city: "Nashville",
  region: "TN",
  addressLine1: "1 Secret St",
  locationLabel: "The Back Room",
  placeId: "22222222-2222-4222-8222-222222222222",
} as unknown as EventRecord;

const NOW = new Date("2026-10-01T12:00:00.000Z");

function makeRecord(status: ImageModerationStatus): ImageModerationRecord {
  return {
    id: "rec-1",
    storageKey: KEY,
    kind: "EVENT_HERO",
    status,
    subjectType: "EVENT",
    subjectId: EVENT_ID,
    publicUrl: URL,
    contentType: "image/png",
    createdByHumanId: "human-1",
    maxSeverity: null,
    categories: null,
    provider: null,
    degraded: false,
    moderatedAt: null,
    reviewedByHumanId: null,
    reviewedAt: null,
    reviewNote: null,
    attempts: 0,
    lastError: null,
    nextAttemptAt: new Date("2026-07-08T00:00:00.000Z"),
    createdAt: new Date("2026-07-08T00:00:00.000Z"),
    updatedAt: new Date("2026-07-08T00:00:00.000Z"),
  };
}

function makeDeps(args: {
  primaryRef?: PrimaryImageRef | null;
  record?: ImageModerationRecord | null;
  event?: EventRecord;
  upcomingDates?: EventDateRecord[] | Error;
  reportError?: GetEventGatedPreviewDeps["reportError"];
}): GetEventGatedPreviewDeps {
  const refMap = new Map<string, PrimaryImageRef>();
  if (args.primaryRef !== null && args.primaryRef !== undefined) {
    refMap.set(EVENT_ID, args.primaryRef);
  }
  const recordMap = new Map<string, ImageModerationRecord>();
  if (args.record) recordMap.set(args.record.storageKey, args.record);

  const repos = {
    events: {
      getById: vi.fn(async () => args.event ?? BASE_EVENT),
    },
    images: {
      getPrimaryImageRefs: vi.fn(async () => refMap),
    },
    imageModerationRecords: {
      resolveByKeys: vi.fn(
        async (keys: string[]) =>
          new Map(
            keys
              .filter((k) => recordMap.has(k))
              .map((k) => [k, recordMap.get(k)!]),
          ),
      ),
    },
    eventDates: {
      listUpcoming: vi.fn(async () => {
        if (args.upcomingDates instanceof Error) throw args.upcomingDates;
        return args.upcomingDates ?? [];
      }),
    },
  } as unknown as Repos;

  return {
    repos,
    clock: { now: () => NOW },
    ...(args.reportError ? { reportError: args.reportError } : {}),
  };
}

function eventDate(
  ordinal: number,
  startsAt: string,
  status: EventDateRecord["status"],
): EventDateRecord {
  return {
    id: `date-${ordinal}`,
    eventId: EVENT_ID,
    ordinal,
    startsAt: new Date(startsAt),
    endsAt: null,
    status,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const RECURRING_EVENT = {
  ...BASE_EVENT,
  // A recurring listing's own startsAt is a past/synthetic instant.
  startsAt: new Date("2026-01-07T02:00:00.000Z"),
  recurrenceSchedule: { kind: "RRULE", rrule: "FREQ=WEEKLY" },
} as unknown as EventRecord;

describe("getEventGatedPreview hero moderation gate", () => {
  it("shows the hero when the moderation record is APPROVED", async () => {
    const deps = makeDeps({
      primaryRef: { publicUrl: URL, key: KEY },
      record: makeRecord("APPROVED"),
    });
    const result = await getEventGatedPreview(deps, { eventId: EVENT_ID });
    expect(result.heroImageUrl).toBe(URL);
  });

  it.each<ImageModerationStatus>(["PENDING", "FLAGGED", "REJECTED"])(
    "omits the hero when the moderation record is %s",
    async (status) => {
      const deps = makeDeps({
        primaryRef: { publicUrl: URL, key: KEY },
        record: makeRecord(status),
      });
      const result = await getEventGatedPreview(deps, { eventId: EVENT_ID });
      expect(result.heroImageUrl).toBeNull();
    },
  );

  it("shows a legacy hero with NO moderation record (fail-open)", async () => {
    const deps = makeDeps({
      primaryRef: { publicUrl: URL, key: KEY },
      record: null,
    });
    const result = await getEventGatedPreview(deps, { eventId: EVENT_ID });
    expect(result.heroImageUrl).toBe(URL);
  });

  it("returns null hero when the event has no primary image", async () => {
    const deps = makeDeps({ primaryRef: null });
    const result = await getEventGatedPreview(deps, { eventId: EVENT_ID });
    expect(result.heroImageUrl).toBeNull();
  });
});

describe("getEventGatedPreview — public only for a page that was public (N3)", () => {
  it("a DRAFT is EVENT_NOT_FOUND: the preview is no longer an any-id → slug oracle", async () => {
    const deps = makeDeps({
      primaryRef: null,
      event: { ...BASE_EVENT, status: "DRAFT", publishedAt: null },
    });
    await expect(
      getEventGatedPreview(deps, { eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
    expect(deps.repos.images.getPrimaryImageRefs).not.toHaveBeenCalled();
  });

  it("an event cancelled without ever going live is EVENT_NOT_FOUND", async () => {
    const deps = makeDeps({
      primaryRef: null,
      event: { ...BASE_EVENT, status: "CANCELLED", publishedAt: null },
    });
    await expect(
      getEventGatedPreview(deps, { eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("a PUBLISHED event (and one that ended after going live) still previews", async () => {
    for (const status of ["PUBLISHED", "COMPLETED"] as const) {
      const deps = makeDeps({ primaryRef: null, event: { ...BASE_EVENT, status } });
      await expect(
        getEventGatedPreview(deps, { eventId: EVENT_ID }),
      ).resolves.toMatchObject({ slug: "secret-show", title: "Secret Show" });
    }
  });
});

describe("getEventGatedPreview — the gate shows the DATE, never the place", () => {
  it("a single-date event returns its LOCAL calendar day, computed in the event's zone", async () => {
    const deps = makeDeps({ primaryRef: null });
    const result = await getEventGatedPreview(deps, { eventId: EVENT_ID });
    // 2026-10-10T01:00Z is 8pm on the 9th in Chicago.
    expect(result.gateDate).toBe("2026-10-09");
    // No occurrence read for a single-date event.
    expect(deps.repos.eventDates.listUpcoming).not.toHaveBeenCalled();
  });

  it("an instant on the 18th in UTC but the 17th in Los Angeles gives the 17th", async () => {
    const deps = makeDeps({
      primaryRef: null,
      event: {
        ...BASE_EVENT,
        // 03:00Z on the 18th = 8pm PDT on the 17th.
        startsAt: new Date("2026-10-18T03:00:00.000Z"),
        timezone: "America/Los_Angeles",
      } as unknown as EventRecord,
    });
    const result = await getEventGatedPreview(deps, { eventId: EVENT_ID });
    expect(result.gateDate).toBe("2026-10-17");
  });

  it("an event with no zone, or an unknown one, shows NO date — never a guess", async () => {
    for (const timezone of [null, "Not/AZone"]) {
      const error = vi.fn();
      const deps = makeDeps({
        primaryRef: null,
        event: { ...BASE_EVENT, timezone } as unknown as EventRecord,
      });
      deps.logger = {
        trace: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error,
        fatal: vi.fn(),
      } as unknown as GetEventGatedPreviewDeps["logger"];
      const result = await getEventGatedPreview(deps, { eventId: EVENT_ID });
      expect(result.gateDate).toBeNull();
      // An unknown zone is a data defect and is logged at error (Sentry);
      // a missing one is just an event without a zone.
      if (timezone) {
        expect(error).toHaveBeenCalledWith(
          "events.get_gated_preview.invalid_timezone",
          expect.objectContaining({ timezone }),
        );
      } else {
        expect(error).not.toHaveBeenCalled();
      }
    }
  });

  it("returns EXACTLY the identity-free preview keys — no location, no zone, no instant, no viewer data", async () => {
    const deps = makeDeps({ primaryRef: null });
    const result = await getEventGatedPreview(deps, { eventId: EVENT_ID });
    expect(Object.keys(result).sort()).toEqual(
      ["eventId", "gateDate", "heroImageUrl", "slug", "title"].sort(),
    );
    expect(result).not.toHaveProperty("timezone");
    expect(result).not.toHaveProperty("startsAt");
    const serialized = JSON.stringify(result);
    // The IANA zone names a city ("America/Chicago"); the raw instant is a
    // zone oracle once paired with the local day.
    for (const leak of [
      "Nashville",
      "TN",
      "Secret St",
      "Back Room",
      "22222222",
      "America",
      "Chicago",
      "T01:00",
    ]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it("a recurring listing shows its first upcoming SCHEDULED occurrence, skipping a called-off night", async () => {
    const deps = makeDeps({
      primaryRef: null,
      event: RECURRING_EVENT,
      upcomingDates: [
        eventDate(1, "2026-10-08T01:00:00.000Z", "CANCELLED"),
        eventDate(2, "2026-10-15T01:00:00.000Z", "SCHEDULED"),
        eventDate(3, "2026-10-22T01:00:00.000Z", "SCHEDULED"),
      ],
    });
    const result = await getEventGatedPreview(deps, { eventId: EVENT_ID });
    // 2026-10-15T01:00Z is the evening of the 14th in Chicago.
    expect(result.gateDate).toBe("2026-10-14");
    expect(deps.repos.eventDates.listUpcoming).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: EVENT_ID, now: NOW }),
    );
  });

  it("a drained recurring listing shows NO date — never the row's own past startsAt", async () => {
    const deps = makeDeps({
      primaryRef: null,
      event: RECURRING_EVENT,
      upcomingDates: [eventDate(1, "2026-10-08T01:00:00.000Z", "CANCELLED")],
    });
    const result = await getEventGatedPreview(deps, { eventId: EVENT_ID });
    expect(result.gateDate).toBeNull();
  });

  it("a failed occurrence read degrades to no date and is REPORTED, not thrown", async () => {
    const boom = new Error("event dates down");
    const reportError = vi.fn();
    const deps = makeDeps({
      primaryRef: null,
      event: RECURRING_EVENT,
      upcomingDates: boom,
      reportError,
    });
    const result = await getEventGatedPreview(deps, { eventId: EVENT_ID });
    expect(result.gateDate).toBeNull();
    expect(result.title).toBe("Secret Show");
    expect(reportError).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({
        tags: expect.objectContaining({ useCase: "getEventGatedPreview" }),
      }),
    );
  });

  it("a THROWING reporter cannot turn the fallback into a failure", async () => {
    const deps = makeDeps({
      primaryRef: null,
      event: RECURRING_EVENT,
      upcomingDates: new Error("event dates down"),
      reportError: () => {
        throw new Error("sentry down");
      },
    });
    await expect(
      getEventGatedPreview(deps, { eventId: EVENT_ID }),
    ).resolves.toMatchObject({ gateDate: null });
  });
});
