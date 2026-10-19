import { beforeEach, describe, expect, it, vi } from "vitest";

import * as createEventSeriesModule from "@th/core/use-cases/series/create-event-series";
import * as updateEventSeriesModule from "@th/core/use-cases/series/update-event-series";
import * as archiveEventSeriesModule from "@th/core/use-cases/series/archive-event-series";
import * as expandSeriesModule from "@th/core/use-cases/series/expand-series";
import * as listEventSeriesModule from "@th/core/use-cases/series/list-event-series";
import * as listSeriesOccurrencesModule from "@th/core/use-cases/series/list-series-occurrences";
import * as convertEventToSeriesModule from "@th/core/use-cases/series/convert-event-to-series";
import * as generateEventsFromSeriesModule from "@th/core/use-cases/series/generate-events-from-series";
import * as syncSeriesDraftsModule from "@th/core/use-cases/series/sync-series-drafts";
import * as skipOccurrenceModule from "@th/core/use-cases/series/skip-occurrence";
import * as restoreOccurrenceModule from "@th/core/use-cases/series/restore-occurrence";
import * as addSeriesOccurrenceModule from "@th/core/use-cases/series/add-series-occurrence";
import * as listSeriesDatesForAdminModule from "@th/core/use-cases/series/list-series-dates-for-admin";
import { AppError } from "@th/errors";

import { seriesRouter } from "../series";
import { createCaller } from "./test-helpers";

describe("seriesRouter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards dependencies and actor human id to createEventSeries", async () => {
    const createSpy = vi
      .spyOn(createEventSeriesModule, "createEventSeries")
      .mockResolvedValue({
        seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      });

    const { caller, ctx } = createCaller(seriesRouter);

    const input = {
      ownerScope: "ORGANIZATION" as const,
      ownerId: "33333333-3333-4333-8333-333333333333",
      name: "Weekly Series",
      timezone: "America/Chicago",
      schedule: {
        kind: "RRULE" as const,
        rrule: "FREQ=WEEKLY;BYDAY=MO",
        dtstart: "2024-04-01T12:00:00.000Z",
      },
      clientKey: "series-key",
    };

    const result = await caller.createEventSeries(input);

    expect(result).toEqual({
      seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        repos: ctx.repos,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: expect.anything(),
      }),
      expect.objectContaining({
        actorHumanId: ctx.actorHumanId,
        ownerScope: input.ownerScope,
        ownerId: input.ownerId,
      }),
    );
  });

  it("maps use case errors from createEventSeries", async () => {
    vi.spyOn(createEventSeriesModule, "createEventSeries").mockRejectedValue({
      code: "conflict",
      message: "series_name_taken",
    });

    const { caller } = createCaller(seriesRouter);

    await expect(
      caller.createEventSeries({
        ownerScope: "HUMAN",
        ownerId: "44444444-4444-4444-8444-444444444444",
        name: "Personal Series",
        timezone: "America/New_York",
        schedule: {
          kind: "FIXED_DATES",
          dates: ["2024-06-01T12:00:00.000Z"],
        },
        clientKey: "series-key",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "series_name_taken" });
  });

  it("forwards dependencies to listEventSeries", async () => {
    const now = new Date("2024-03-01T10:00:00.000Z");
    const listSpy = vi
      .spyOn(listEventSeriesModule, "listEventSeries")
      .mockResolvedValue({
        items: [
          {
            id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            ownerScope: "ORGANIZATION" as const,
            ownerId: "33333333-3333-4333-8333-333333333333",
            name: "Weekly Series",
            description: null,
            active: true,
            timezone: "America/Chicago",
            schedule: {
              kind: "RRULE" as const,
              rrule: "FREQ=WEEKLY;BYDAY=MO",
              dtstart: "2024-04-01T12:00:00.000Z",
              dates: undefined,
              until: undefined,
              windowStart: undefined,
              windowEnd: undefined,
              maxOccurrencesPerExpand: 100,
            },
            templateId: null,
            defaults: null,
            createdByHumanId: "11111111-1111-4111-8111-111111111111",
            updatedByHumanId: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
          },
        ],
        nextCursor: undefined,
      });

    const { caller, ctx } = createCaller(seriesRouter);

    const result = await caller.listEventSeries({
      ownerScope: "ORGANIZATION",
      ownerId: "33333333-3333-4333-8333-333333333333",
    });

    expect(result.items).toHaveLength(1);
    expect(listSpy).toHaveBeenCalledWith(
      expect.objectContaining({ repos: ctx.repos, logger: expect.anything() }),
      expect.objectContaining({
        actorHumanId: ctx.actorHumanId,
        ownerScope: "ORGANIZATION",
        ownerId: "33333333-3333-4333-8333-333333333333",
      }),
    );
  });

  it("rejects when actor human id missing for create", async () => {
    const createSpy = vi
      .spyOn(createEventSeriesModule, "createEventSeries")
      .mockResolvedValue({
        seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      });

    const overrides = {
      actorHumanId: null,
      auth: null,
      authToken: null,
    } as const;
    const { caller } = createCaller(seriesRouter, overrides);

    await expect(
      caller.createEventSeries({
        ownerScope: "ORGANIZATION",
        ownerId: "33333333-3333-4333-8333-333333333333",
        name: "Weekly Series",
        timezone: "America/Chicago",
        schedule: {
          kind: "RRULE",
          rrule: "FREQ=WEEKLY;BYDAY=MO",
          dtstart: "2024-04-01T12:00:00.000Z",
        },
        clientKey: "series-key",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("forwards dependencies to updateEventSeries", async () => {
    const updateSpy = vi
      .spyOn(updateEventSeriesModule, "updateEventSeries")
      .mockResolvedValue({ ok: true });

    const { caller, ctx } = createCaller(seriesRouter);

    const result = await caller.updateEventSeries({
      seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      patch: { name: "Renamed Series" },
      clientKey: "update-key",
    });

    expect(result).toEqual({ ok: true });
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        repos: ctx.repos,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
      }),
      expect.objectContaining({
        actorHumanId: ctx.actorHumanId,
        seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        patch: { name: "Renamed Series" },
        clientKey: "update-key",
      }),
    );
  });

  it("maps use case errors from updateEventSeries", async () => {
    vi.spyOn(updateEventSeriesModule, "updateEventSeries").mockRejectedValue({
      code: "not_found",
      message: "series_not_found",
    });

    const { caller } = createCaller(seriesRouter);

    await expect(
      caller.updateEventSeries({
        seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        patch: { name: "Renamed" },
        clientKey: "update-key",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "series_not_found" });
  });

  it("forwards dependencies to archiveEventSeries", async () => {
    const archiveSpy = vi
      .spyOn(archiveEventSeriesModule, "archiveEventSeries")
      .mockResolvedValue({ ok: true });

    const { caller, ctx } = createCaller(seriesRouter);

    const result = await caller.archiveEventSeries({
      seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      clientKey: "archive-key",
    });

    expect(result).toEqual({ ok: true });
    expect(archiveSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        repos: ctx.repos,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
      }),
      expect.objectContaining({
        actorHumanId: ctx.actorHumanId,
        seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        clientKey: "archive-key",
      }),
    );
  });

  it("forwards dependencies to expandSeries", async () => {
    const now = new Date("2024-06-01T12:00:00.000Z");
    const expandSpy = vi
      .spyOn(expandSeriesModule, "expandSeries")
      .mockResolvedValue({
        seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        occurrencesCreated: 4,
        occurrences: [
          {
            id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            ordinal: 1,
            startsAt: now,
            endsAt: null,
            status: "PLANNED" as const,
            eventId: null,
            overrides: null,
            createdAt: now,
            updatedAt: now,
          },
        ],
      });

    const { caller, ctx } = createCaller(seriesRouter);

    const result = await caller.expandSeries({
      seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      windowStart: "2024-06-01T00:00:00.000Z",
      windowEnd: "2024-12-31T23:59:59.000Z",
      clientKey: "expand-key",
    });

    expect(result.seriesId).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(result.occurrencesCreated).toBe(4);
    expect(expandSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        repos: ctx.repos,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
      }),
      expect.objectContaining({
        actorHumanId: ctx.actorHumanId,
        seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        windowStart: "2024-06-01T00:00:00.000Z",
        windowEnd: "2024-12-31T23:59:59.000Z",
        clientKey: "expand-key",
      }),
    );
  });

  it("forwards dependencies to listSeriesOccurrences", async () => {
    const now = new Date("2024-06-01T12:00:00.000Z");
    const listOccSpy = vi
      .spyOn(listSeriesOccurrencesModule, "listSeriesOccurrences")
      .mockResolvedValue({
        items: [
          {
            id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            ordinal: 1,
            startsAt: now,
            endsAt: null,
            status: "PLANNED" as const,
            eventId: null,
            overrides: null,
            createdAt: now,
            updatedAt: now,
          },
        ],
        nextCursor: undefined,
      });

    const { caller, ctx } = createCaller(seriesRouter);

    const result = await caller.listSeriesOccurrences({
      seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].status).toBe("PLANNED");
    expect(listOccSpy).toHaveBeenCalledWith(
      expect.objectContaining({ repos: ctx.repos }),
      expect.objectContaining({
        actorHumanId: ctx.actorHumanId,
        seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    );
  });

  it("forwards dependencies and actor human id to convertEventToSeries", async () => {
    const convertSpy = vi
      .spyOn(convertEventToSeriesModule, "convertEventToSeries")
      .mockResolvedValue({
        seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        occurrenceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      });

    const { caller, ctx } = createCaller(seriesRouter);

    const input = {
      eventId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      name: "Monday Residency",
      schedule: {
        kind: "RRULE" as const,
        rrule: "FREQ=WEEKLY;BYDAY=MO",
        dtstart: "2024-04-01T12:00:00.000Z",
      },
      clientKey: "convert-key",
    };

    const result = await caller.convertEventToSeries(input);

    expect(result).toEqual({
      seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      occurrenceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    });
    expect(convertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        repos: ctx.repos,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: expect.anything(),
      }),
      expect.objectContaining({
        actorHumanId: ctx.actorHumanId,
        eventId: input.eventId,
        name: input.name,
        clientKey: input.clientKey,
      }),
    );
  });

  it("maps use case errors from convertEventToSeries", async () => {
    vi.spyOn(
      convertEventToSeriesModule,
      "convertEventToSeries",
    ).mockRejectedValue({
      code: "conflict",
      message: "event_already_in_series",
    });

    const { caller } = createCaller(seriesRouter);

    await expect(
      caller.convertEventToSeries({
        eventId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        schedule: {
          kind: "FIXED_DATES",
          dates: ["2024-06-01T12:00:00.000Z"],
        },
        clientKey: "convert-key",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "event_already_in_series",
    });
  });

  it("forwards dependencies and actor human id to generateEventsFromSeries", async () => {
    const generateSpy = vi
      .spyOn(generateEventsFromSeriesModule, "generateEventsFromSeries")
      .mockResolvedValue({
        generated: [
          {
            occurrenceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            eventId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            // Required on the result schema (Q-005): how many copied ticket
            // types lost an already-elapsed scheduled price change. The entry
            // schema is `.strict()`, so omitting it fails output validation.
            scheduledPricesDropped: 0,
            // Same contract for the FR-014 sales window: how many copied types
            // lost an already-CLOSED window. Also required by the `.strict()`
            // entry schema.
            salesWindowsDropped: 0,
          },
        ],
        skipped: ["dddddddd-dddd-4ddd-8ddd-dddddddddddd"],
      });

    const { caller, ctx } = createCaller(seriesRouter);

    const result = await caller.generateEventsFromSeries({
      seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      limit: 5,
      clientKey: "generate-key",
    });

    expect(result.generated).toHaveLength(1);
    expect(result.skipped).toEqual([
      "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    ]);
    expect(generateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        repos: ctx.repos,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
      }),
      expect.objectContaining({
        actorHumanId: ctx.actorHumanId,
        seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        limit: 5,
        clientKey: "generate-key",
      }),
    );
  });

  it("maps use case errors from generateEventsFromSeries", async () => {
    vi.spyOn(
      generateEventsFromSeriesModule,
      "generateEventsFromSeries",
    ).mockRejectedValue({
      code: "not_found",
      message: "occurrence_not_found",
    });

    const { caller } = createCaller(seriesRouter);

    await expect(
      caller.generateEventsFromSeries({
        seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        occurrenceIds: ["cccccccc-cccc-4ccc-8ccc-cccccccccccc"],
        clientKey: "generate-key",
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "occurrence_not_found",
    });
  });

  it("rejects unauthenticated calls on new routes", async () => {
    const overrides = {
      actorHumanId: null,
      auth: null,
      authToken: null,
    } as const;
    const { caller } = createCaller(seriesRouter, overrides);

    await expect(
      caller.updateEventSeries({
        seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        patch: { name: "X" },
        clientKey: "k",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    await expect(
      caller.archiveEventSeries({
        seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        clientKey: "k",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    await expect(
      caller.expandSeries({
        seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        windowStart: "2024-06-01T00:00:00.000Z",
        clientKey: "k",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    await expect(
      caller.listSeriesOccurrences({
        seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    await expect(
      caller.convertEventToSeries({
        eventId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        schedule: {
          kind: "FIXED_DATES",
          dates: ["2024-06-01T12:00:00.000Z"],
        },
        clientKey: "convert-k",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    await expect(
      caller.generateEventsFromSeries({
        seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        limit: 1,
        clientKey: "generate-k",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("forwards dependencies and actor human id to syncSeriesDrafts", async () => {
    const syncSpy = vi
      .spyOn(syncSeriesDraftsModule, "syncSeriesDrafts")
      .mockResolvedValue({
        updatedDraftCount: 3,
        skippedPublishedCount: 2,
        skippedPastCount: 1,
      });

    const { caller, ctx } = createCaller(seriesRouter);

    const result = await caller.syncSeriesDrafts({
      seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      sourceEventId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      scope: "future",
      clientKey: "sync-key-1",
    });

    expect(result).toEqual({
      updatedDraftCount: 3,
      skippedPublishedCount: 2,
      skippedPastCount: 1,
    });
    expect(syncSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        repos: ctx.repos,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: expect.anything(),
      }),
      expect.objectContaining({
        actorHumanId: ctx.actorHumanId,
        seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        sourceEventId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        scope: "future",
        clientKey: "sync-key-1",
        // Owner Q13: replacing a sibling's areas is off unless asked for.
        includeArrivalAreas: false,
      }),
    );
  });

  it("forwards includeArrivalAreas: true to syncSeriesDrafts (owner Q13)", async () => {
    const syncSpy = vi
      .spyOn(syncSeriesDraftsModule, "syncSeriesDrafts")
      .mockResolvedValue({
        updatedDraftCount: 1,
        skippedPublishedCount: 0,
        skippedPastCount: 0,
      });

    const { caller } = createCaller(seriesRouter);

    await caller.syncSeriesDrafts({
      seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      sourceEventId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      scope: "all",
      clientKey: "sync-key-2",
      includeArrivalAreas: true,
    });

    expect(syncSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ includeArrivalAreas: true }),
    );
  });

  it("maps OCCURRENCE_NOT_FOUND from syncSeriesDrafts to NOT_FOUND", async () => {
    vi.spyOn(syncSeriesDraftsModule, "syncSeriesDrafts").mockRejectedValue(
      new AppError("OCCURRENCE_NOT_FOUND"),
    );

    const { caller } = createCaller(seriesRouter);

    await expect(
      caller.syncSeriesDrafts({
        seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        sourceEventId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        scope: "all",
        clientKey: "sync-key-1",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects unauthenticated syncSeriesDrafts calls", async () => {
    const syncSpy = vi
      .spyOn(syncSeriesDraftsModule, "syncSeriesDrafts")
      .mockResolvedValue({
        updatedDraftCount: 0,
        skippedPublishedCount: 0,
        skippedPastCount: 0,
      });
    const { caller } = createCaller(seriesRouter, {
      actorHumanId: null,
      auth: null,
      authToken: null,
    });

    await expect(
      caller.syncSeriesDrafts({
        seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        sourceEventId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        scope: "future",
        clientKey: "sync-key-1",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(syncSpy).not.toHaveBeenCalled();
  });

  it("forwards dependencies and actor human id to skipOccurrence", async () => {
    const skipSpy = vi
      .spyOn(skipOccurrenceModule, "skipOccurrence")
      .mockResolvedValue({
        occurrenceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        status: "SKIPPED",
      });

    const { caller, ctx } = createCaller(seriesRouter);

    const result = await caller.skipOccurrence({
      seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      occurrenceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      note: "band unavailable",
      clientKey: "skip-key-1",
    });

    expect(result).toEqual({
      occurrenceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      status: "SKIPPED",
    });
    expect(skipSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        repos: ctx.repos,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: expect.anything(),
      }),
      expect.objectContaining({
        actorHumanId: ctx.actorHumanId,
        seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        occurrenceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        note: "band unavailable",
      }),
    );
  });

  it("maps OCCURRENCE_NOT_SKIPPABLE from skipOccurrence to CONFLICT", async () => {
    vi.spyOn(skipOccurrenceModule, "skipOccurrence").mockRejectedValue(
      new AppError("OCCURRENCE_NOT_SKIPPABLE"),
    );

    const { caller } = createCaller(seriesRouter);

    await expect(
      caller.skipOccurrence({
        seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        occurrenceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        clientKey: "skip-key-1",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("forwards dependencies and actor human id to restoreOccurrence", async () => {
    const restoreSpy = vi
      .spyOn(restoreOccurrenceModule, "restoreOccurrence")
      .mockResolvedValue({
        occurrenceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        status: "PLANNED",
      });

    const { caller, ctx } = createCaller(seriesRouter);

    const result = await caller.restoreOccurrence({
      seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      occurrenceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      clientKey: "restore-key-1",
    });

    expect(result).toEqual({
      occurrenceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      status: "PLANNED",
    });
    expect(restoreSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        repos: ctx.repos,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
      }),
      expect.objectContaining({
        actorHumanId: ctx.actorHumanId,
        occurrenceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      }),
    );
  });

  it("maps OCCURRENCE_NOT_SKIPPED from restoreOccurrence to CONFLICT", async () => {
    vi.spyOn(restoreOccurrenceModule, "restoreOccurrence").mockRejectedValue(
      new AppError("OCCURRENCE_NOT_SKIPPED"),
    );

    const { caller } = createCaller(seriesRouter);

    await expect(
      caller.restoreOccurrence({
        seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        occurrenceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        clientKey: "restore-key-1",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("forwards dependencies and actor human id to addSeriesOccurrence", async () => {
    const addSpy = vi
      .spyOn(addSeriesOccurrenceModule, "addSeriesOccurrence")
      .mockResolvedValue({
        occurrenceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      });

    const { caller, ctx } = createCaller(seriesRouter);

    const result = await caller.addSeriesOccurrence({
      seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      startsAt: "2026-04-08T20:00:00.000Z",
      endsAt: "2026-04-08T23:00:00.000Z",
      note: "one-off",
      clientKey: "add-key-1",
    });

    expect(result).toEqual({
      occurrenceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    });
    expect(addSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        repos: ctx.repos,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
      }),
      expect.objectContaining({
        actorHumanId: ctx.actorHumanId,
        startsAt: "2026-04-08T20:00:00.000Z",
        endsAt: "2026-04-08T23:00:00.000Z",
        note: "one-off",
      }),
    );
  });

  it("maps OCCURRENCE_DUPLICATE_DATE from addSeriesOccurrence to CONFLICT", async () => {
    vi.spyOn(
      addSeriesOccurrenceModule,
      "addSeriesOccurrence",
    ).mockRejectedValue(new AppError("OCCURRENCE_DUPLICATE_DATE"));

    const { caller } = createCaller(seriesRouter);

    await expect(
      caller.addSeriesOccurrence({
        seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        startsAt: "2026-04-08T20:00:00.000Z",
        clientKey: "add-key-1",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("forwards dependencies and actor human id to listSeriesDatesForAdmin", async () => {
    const now = new Date("2026-04-06T18:00:00.000Z");
    const listSpy = vi
      .spyOn(listSeriesDatesForAdminModule, "listSeriesDatesForAdmin")
      .mockResolvedValue({
        series: {
          seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          name: "Weekly Jam",
          timezone: "America/Chicago",
          schedule: {
            kind: "RRULE" as const,
            rrule: "FREQ=WEEKLY;BYDAY=MO",
            until: null,
          },
          totalCount: 1,
        },
        items: [
          {
            occurrenceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            startsAt: now,
            endsAt: null,
            status: "PUBLISHED" as const,
            manual: false,
            skipNote: null,
            note: null,
            event: {
              eventId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
              title: "Weekly Jam — Apr 6",
              slug: "weekly-jam-apr-6",
              status: "PUBLISHED" as const,
              ticketTypeCount: 2,
              soldCount: 42,
            },
          },
        ],
        nextCursor: undefined,
      });

    const { caller, ctx } = createCaller(seriesRouter);

    const result = await caller.listSeriesDatesForAdmin({
      seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      limit: 25,
    });

    expect(result.series.totalCount).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.event?.soldCount).toBe(42);
    expect(listSpy).toHaveBeenCalledWith(
      expect.objectContaining({ repos: ctx.repos, logger: expect.anything() }),
      expect.objectContaining({
        actorHumanId: ctx.actorHumanId,
        seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        limit: 25,
      }),
    );
  });

  it("rejects when actor human id missing for the Dates page procedures", async () => {
    const { caller } = createCaller(seriesRouter, { actorHumanId: null });

    await expect(
      caller.skipOccurrence({
        seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        occurrenceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        clientKey: "skip-key-1",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    await expect(
      caller.restoreOccurrence({
        seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        occurrenceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        clientKey: "restore-key-1",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    await expect(
      caller.addSeriesOccurrence({
        seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        startsAt: "2026-04-08T20:00:00.000Z",
        clientKey: "add-key-1",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    await expect(
      caller.listSeriesDatesForAdmin({
        seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
