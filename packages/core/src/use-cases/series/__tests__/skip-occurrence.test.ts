import { describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { Repos } from "@th/ports/repos";
import type { EventSeriesOccurrenceRecord, EventSeriesRecord } from "@th/types";

import { skipOccurrence } from "../skip-occurrence";
import type { SkipOccurrenceDeps } from "../skip-occurrence";

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
    status: "PLANNED",
    eventId: null,
    overrides: null,
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
  deps: SkipOccurrenceDeps;
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
    clientKey: "skip-key-1",
    ...overrides,
  };
}

describe("skipOccurrence", () => {
  it("marks a PLANNED occurrence SKIPPED and stores the note in overrides.skipNote", async () => {
    const existing = makeOccurrence({
      overrides: { title: "Special Night" },
    });
    const { deps, fakes } = makeDeps({
      occurrenceGetById: vi.fn(async () => existing),
    });

    const result = await skipOccurrence(
      deps,
      baseInput({ note: "band unavailable" }),
    );

    expect(result).toEqual({ occurrenceId: OCC_ID, status: "SKIPPED" });
    // Other overrides keys preserved, skipNote added.
    expect(fakes.applyOverrides).toHaveBeenCalledWith({
      occurrenceId: OCC_ID,
      overrides: { title: "Special Night", skipNote: "band unavailable" },
      updatedAt: NOW,
    });
    expect(fakes.markStatusIf).toHaveBeenCalledWith({
      occurrenceId: OCC_ID,
      expectStatus: "PLANNED",
      expectNoEvent: true,
      status: "SKIPPED",
      updatedAt: NOW,
    });
    expect(fakes.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "event_series",
        entityId: SERIES_ID,
        action: "occurrence_skipped",
        data: expect.objectContaining({ occurrenceId: OCC_ID, hasNote: true }),
      }),
    );
    expect(deps.idempotency.commit).toHaveBeenCalled();
  });

  it("skips without touching overrides when no note is given and none exist", async () => {
    const { deps, fakes } = makeDeps();

    const result = await skipOccurrence(deps, baseInput());

    expect(result.status).toBe("SKIPPED");
    expect(fakes.applyOverrides).not.toHaveBeenCalled();
    expect(fakes.markStatusIf).toHaveBeenCalledWith(
      expect.objectContaining({ status: "SKIPPED" }),
    );
  });

  it("sanitizes the note (HTML stripped before storage)", async () => {
    const { deps, fakes } = makeDeps();

    await skipOccurrence(
      deps,
      baseInput({ note: "<script>alert(1)</script>venue closed" }),
    );

    const call = (fakes.applyOverrides as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as { overrides: { skipNote?: string } };
    expect(call.overrides.skipNote).toBeDefined();
    expect(call.overrides.skipNote).not.toContain("<script>");
    expect(call.overrides.skipNote).toContain("venue closed");
  });

  it("rejects OCCURRENCE_NOT_SKIPPABLE when the guarded transition loses a race (updated: false)", async () => {
    // Pre-read sees a clean PLANNED row, but a concurrent generate attaches
    // an event before the write — the guarded UPDATE matches nothing.
    const { deps, fakes } = makeDeps({
      markStatusIf: vi.fn(async () => ({ updated: false })),
    });

    await expect(
      skipOccurrence(deps, baseInput({ note: "too late" })),
    ).rejects.toMatchObject({ code: "OCCURRENCE_NOT_SKIPPABLE" });

    // Overrides write happens after the guard — never reached on a lost race.
    expect(fakes.applyOverrides).not.toHaveBeenCalled();
    expect(deps.idempotency.fail).toHaveBeenCalled();
    expect(deps.idempotency.commit).not.toHaveBeenCalled();
  });

  it("rejects OCCURRENCE_NOT_SKIPPABLE for a non-PLANNED occurrence", async () => {
    const { deps, fakes } = makeDeps({
      occurrenceGetById: vi.fn(async () =>
        makeOccurrence({
          status: "GENERATED",
          eventId: "00000000-0000-4000-8000-000000000021",
        }),
      ),
    });

    await expect(skipOccurrence(deps, baseInput())).rejects.toMatchObject({
      code: "OCCURRENCE_NOT_SKIPPABLE",
    });
    expect(fakes.markStatusIf).not.toHaveBeenCalled();
    expect(deps.idempotency.fail).toHaveBeenCalled();
  });

  it("rejects OCCURRENCE_NOT_SKIPPABLE for a PLANNED occurrence with an event attached", async () => {
    const { deps } = makeDeps({
      occurrenceGetById: vi.fn(async () =>
        makeOccurrence({
          status: "PLANNED",
          eventId: "00000000-0000-4000-8000-000000000021",
        }),
      ),
    });

    await expect(skipOccurrence(deps, baseInput())).rejects.toMatchObject({
      code: "OCCURRENCE_NOT_SKIPPABLE",
    });
  });

  it("rejects OCCURRENCE_NOT_FOUND for an occurrence of another series", async () => {
    const { deps } = makeDeps({
      occurrenceGetById: vi.fn(async () =>
        makeOccurrence({ seriesId: "00000000-0000-4000-8000-00000000ffff" }),
      ),
    });

    await expect(skipOccurrence(deps, baseInput())).rejects.toMatchObject({
      code: "OCCURRENCE_NOT_FOUND",
    });
  });

  it("rejects SERIES_INACTIVE for an archived series", async () => {
    const { deps } = makeDeps({
      seriesGetById: vi.fn(async () =>
        makeSeries({ active: false, archivedAt: new Date() }),
      ),
    });

    await expect(skipOccurrence(deps, baseInput())).rejects.toMatchObject({
      code: "SERIES_INACTIVE",
    });
  });

  it("denies an actor who is not the series owner", async () => {
    const { deps } = makeDeps();

    await expect(
      skipOccurrence(
        deps,
        baseInput({ actorHumanId: "00000000-0000-4000-8000-000000000099" }),
      ),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("replays the stored response without re-executing", async () => {
    const { deps: firstDeps } = makeDeps();
    const first = await skipOccurrence(firstDeps, baseInput());
    const committed = (firstDeps.idempotency.commit as ReturnType<typeof vi.fn>)
      .mock.calls[0]![1];

    const { deps: replayDeps, fakes } = makeDeps();
    (replayDeps.idempotency.get as ReturnType<typeof vi.fn>).mockResolvedValue(
      committed,
    );

    const replayed = await skipOccurrence(replayDeps, baseInput());

    expect(replayed).toEqual(first);
    expect(fakes.markStatusIf).not.toHaveBeenCalled();
    expect(replayDeps.idempotency.begin).not.toHaveBeenCalled();
  });

  it("throws IDEMPOTENCY_KEY_CONFLICT when the replayed payload differs", async () => {
    const { deps } = makeDeps();
    (deps.idempotency.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      payloadHash: "different-hash",
      response: { occurrenceId: OCC_ID, status: "SKIPPED" },
    });

    await expect(skipOccurrence(deps, baseInput())).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_CONFLICT",
    });
  });
});
