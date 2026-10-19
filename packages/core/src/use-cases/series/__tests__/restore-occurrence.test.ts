import { describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { Repos } from "@th/ports/repos";
import type { EventSeriesOccurrenceRecord, EventSeriesRecord } from "@th/types";

import { restoreOccurrence } from "../restore-occurrence";
import type { RestoreOccurrenceDeps } from "../restore-occurrence";

const SERIES_ID = "00000000-0000-4000-8000-000000000001";
const ACTOR_ID = "00000000-0000-4000-8000-000000000002";
const OCC_ID = "00000000-0000-4000-8000-000000000011";
const NOW = new Date("2026-04-01T12:00:00.000Z");

function makeSeries(overrides?: Partial<EventSeriesRecord>): EventSeriesRecord {
  return {
    id: SERIES_ID,
    ownerScope: "HUMAN",
    ownerId: ACTOR_ID,
    name: "Weekly Jam",
    description: null,
    active: true,
    timezone: "UTC",
    schedule: {
      kind: "RRULE",
      rrule: "FREQ=WEEKLY;BYDAY=MO",
      dtstart: "2026-04-06T18:00:00.000Z",
      maxOccurrencesPerExpand: 100,
    },
    templateId: null,
    defaults: null,
    createdByHumanId: ACTOR_ID,
    updatedByHumanId: null,
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    updatedAt: new Date("2026-03-01T00:00:00.000Z"),
    archivedAt: null,
    ...overrides,
  };
}

function makeOccurrence(
  overrides?: Partial<EventSeriesOccurrenceRecord>,
): EventSeriesOccurrenceRecord {
  return {
    id: OCC_ID,
    seriesId: SERIES_ID,
    ordinal: 1,
    startsAt: new Date("2026-04-13T18:00:00.000Z"),
    endsAt: null,
    status: "SKIPPED",
    eventId: null,
    overrides: { skipNote: "band unavailable" },
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    updatedAt: new Date("2026-03-01T00:00:00.000Z"),
    ...overrides,
  };
}

function makeIdempotency(): IdempotencyPort {
  return {
    get: vi.fn(async () => null),
    begin: vi.fn(async () => true),
    commit: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
    run: vi.fn(async () => {
      throw new Error("not used");
    }),
    purgeExpired: async () => 0,
  };
}

type AnyFn = (...args: never[]) => unknown;

type FakeOverrides = {
  seriesGetById?: AnyFn;
  occurrenceGetById?: AnyFn;
  applyOverrides?: AnyFn;
  markStatusIf?: AnyFn;
  auditLog?: AnyFn;
};

function makeDeps(overrides?: FakeOverrides): {
  deps: RestoreOccurrenceDeps;
  fakes: Required<FakeOverrides>;
} {
  const fakes = {
    seriesGetById: overrides?.seriesGetById ?? vi.fn(async () => makeSeries()),
    occurrenceGetById:
      overrides?.occurrenceGetById ?? vi.fn(async () => makeOccurrence()),
    applyOverrides:
      overrides?.applyOverrides ?? vi.fn(async () => ({ id: OCC_ID })),
    markStatusIf:
      overrides?.markStatusIf ?? vi.fn(async () => ({ updated: true })),
    auditLog: overrides?.auditLog ?? vi.fn(async () => undefined),
  };

  const tx = {
    series: { getById: fakes.seriesGetById },
    seriesOccurrences: {
      getById: fakes.occurrenceGetById,
      applyOverrides: fakes.applyOverrides,
      markStatusIf: fakes.markStatusIf,
    },
    humans: {
      getById: vi.fn(async (id: string) => ({ id, status: "ACTIVE" })),
    },
    organizations: {
      getById: vi.fn(async (id: string) => ({ id, status: "ACTIVE" })),
    },
    authz: {
      getHumanDelegation: vi.fn(async () => null),
      getOrgMembership: vi.fn(async () => ({ role: "EDITOR" })),
    },
    audit: { log: fakes.auditLog },
  };

  const repos = {
    tx: async <T>(fn: (t: unknown) => Promise<T>): Promise<T> => fn(tx),
  } as unknown as Repos;

  const clock: ClockPort = { now: () => NOW };

  return {
    deps: { repos, idempotency: makeIdempotency(), clock },
    fakes: fakes as Required<FakeOverrides>,
  };
}

function baseInput(overrides?: Record<string, unknown>) {
  return {
    actorHumanId: ACTOR_ID,
    seriesId: SERIES_ID,
    occurrenceId: OCC_ID,
    clientKey: "restore-key-1",
    ...overrides,
  };
}

describe("restoreOccurrence", () => {
  it("marks a SKIPPED occurrence PLANNED and clears skipNote, preserving other overrides", async () => {
    const { deps, fakes } = makeDeps({
      occurrenceGetById: vi.fn(async () =>
        makeOccurrence({
          overrides: { title: "Special Night", skipNote: "band unavailable" },
        }),
      ),
    });

    const result = await restoreOccurrence(deps, baseInput());

    expect(result).toEqual({ occurrenceId: OCC_ID, status: "PLANNED" });
    expect(fakes.applyOverrides).toHaveBeenCalledWith({
      occurrenceId: OCC_ID,
      overrides: { title: "Special Night" },
      updatedAt: NOW,
    });
    expect(fakes.markStatusIf).toHaveBeenCalledWith({
      occurrenceId: OCC_ID,
      expectStatus: "SKIPPED",
      status: "PLANNED",
      updatedAt: NOW,
    });
    expect(fakes.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "occurrence_restored" }),
    );
  });

  it("collapses overrides to null when skipNote was the only key", async () => {
    const { deps, fakes } = makeDeps();

    await restoreOccurrence(deps, baseInput());

    expect(fakes.applyOverrides).toHaveBeenCalledWith({
      occurrenceId: OCC_ID,
      overrides: null,
      updatedAt: NOW,
    });
  });

  it("preserves the manual flag when restoring a skipped manual occurrence", async () => {
    const { deps, fakes } = makeDeps({
      occurrenceGetById: vi.fn(async () =>
        makeOccurrence({
          overrides: { manual: true, note: "one-off", skipNote: "oops" },
        }),
      ),
    });

    await restoreOccurrence(deps, baseInput());

    expect(fakes.applyOverrides).toHaveBeenCalledWith({
      occurrenceId: OCC_ID,
      overrides: { manual: true, note: "one-off" },
      updatedAt: NOW,
    });
  });

  it("rejects OCCURRENCE_NOT_SKIPPED when the guarded transition loses a race (updated: false)", async () => {
    const { deps, fakes } = makeDeps({
      markStatusIf: vi.fn(async () => ({ updated: false })),
    });

    await expect(restoreOccurrence(deps, baseInput())).rejects.toMatchObject({
      code: "OCCURRENCE_NOT_SKIPPED",
    });

    // Overrides cleanup happens after the guard — never reached on a lost race.
    expect(fakes.applyOverrides).not.toHaveBeenCalled();
    expect(deps.idempotency.fail).toHaveBeenCalled();
    expect(deps.idempotency.commit).not.toHaveBeenCalled();
  });

  it("rejects OCCURRENCE_NOT_SKIPPED for a PLANNED occurrence", async () => {
    const { deps, fakes } = makeDeps({
      occurrenceGetById: vi.fn(async () =>
        makeOccurrence({ status: "PLANNED", overrides: null }),
      ),
    });

    await expect(restoreOccurrence(deps, baseInput())).rejects.toMatchObject({
      code: "OCCURRENCE_NOT_SKIPPED",
    });
    expect(fakes.markStatusIf).not.toHaveBeenCalled();
    expect(deps.idempotency.fail).toHaveBeenCalled();
  });

  it("rejects OCCURRENCE_NOT_FOUND for a missing occurrence", async () => {
    const { deps } = makeDeps({
      occurrenceGetById: vi.fn(async () => null),
    });

    await expect(restoreOccurrence(deps, baseInput())).rejects.toMatchObject({
      code: "OCCURRENCE_NOT_FOUND",
    });
  });

  it("denies an actor who is not the series owner", async () => {
    const { deps } = makeDeps();

    await expect(
      restoreOccurrence(
        deps,
        baseInput({ actorHumanId: "00000000-0000-4000-8000-000000000099" }),
      ),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("replays the stored response without re-executing", async () => {
    const { deps: firstDeps } = makeDeps();
    const first = await restoreOccurrence(firstDeps, baseInput());
    const committed = (firstDeps.idempotency.commit as ReturnType<typeof vi.fn>)
      .mock.calls[0]![1];

    const { deps: replayDeps, fakes } = makeDeps();
    (replayDeps.idempotency.get as ReturnType<typeof vi.fn>).mockResolvedValue(
      committed,
    );

    const replayed = await restoreOccurrence(replayDeps, baseInput());

    expect(replayed).toEqual(first);
    expect(fakes.markStatusIf).not.toHaveBeenCalled();
  });
});
