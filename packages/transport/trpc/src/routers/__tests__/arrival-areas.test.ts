import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@th/errors";

// arrival-areas plan step 6: the transport's own decisions (the feature gate,
// server-injected identity and gate pass, the conflict payload). The use
// cases are stubbed; their rules have their own suites in core.
const gateMocks = vi.hoisted(() => ({
  hasFullEventReadAccessByEventId: vi.fn(
    async (_ctx: unknown, _eventId: string): Promise<boolean> => true,
  ),
}));
vi.mock("../../event-read-access", () => ({
  hasFullEventReadAccessByEventId: gateMocks.hasFullEventReadAccessByEventId,
}));

const useCases = vi.hoisted(() => ({
  listArrivalAreasForViewer: vi.fn(),
  listArrivalAreasForEditor: vi.fn(),
  createArrivalArea: vi.fn(),
  updateArrivalArea: vi.fn(),
  reorderArrivalAreas: vi.fn(),
  removeArrivalArea: vi.fn(),
  setEventArrivalAreaHidden: vi.fn(),
}));
vi.mock("@th/core/use-cases/arrival-areas", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@th/core/use-cases/arrival-areas")>();
  return { ...actual, ...useCases };
});

import { createTestLogger } from "@th/test-utils";
import { withConsumeMany } from "@th/test-utils/fakes/rate-limit";

import type { Ctx } from "../../context";
import { router as trpcRouter } from "../../init";
import { router, t } from "../../trpc";
import { arrivalAreasRouter } from "../arrival-areas";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const PLACE_ID = "22222222-2222-4222-8222-222222222222";
const EVENT_ID = "33333333-3333-4333-8333-333333333333";
const AREA_ID = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-10-17T12:00:00.000Z");

const SQUARE = {
  type: "Polygon",
  coordinates: [
    [
      [-86.78, 36.16],
      [-86.779, 36.16],
      [-86.779, 36.161],
      [-86.78, 36.161],
      [-86.78, 36.16],
    ],
  ],
};

const editorRow = (overrides: Record<string, unknown> = {}) => ({
  id: AREA_ID,
  placeId: null,
  eventId: EVENT_ID,
  kind: "PARKING",
  geometry: SQUARE,
  geometryWithheld: false,
  label: "Back lot",
  cost: "FREE",
  priceText: "$5",
  note: "Behind the blue house",
  accessibleSpots: false,
  sortOrder: 0,
  disabledAt: null,
  createdByHumanId: ACTOR_ID,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const fakeRateLimit = () =>
  withConsumeMany({
    consume: vi.fn(async () => ({
      allowed: true,
      remaining: Number.POSITIVE_INFINITY,
      retryAfterSeconds: 0,
    })),
  });

const authedSession = {
  auth: { userId: "user-1", sessionId: null, token: "token" },
  authToken: "token",
} as const;

function buildCtx(options: { gateOn?: boolean; signedIn?: boolean } = {}) {
  const { gateOn = true, signedIn = true } = options;
  const getAll = vi.fn(async () =>
    gateOn ? [{ key: "feature:arrivalAreas", value: "true" }] : [],
  );
  const ctx = {
    repos: { platformSettings: { getAll } } as unknown as Ctx["repos"],
    authz: {
      hasStaffRole: vi.fn(async () => ({ allowed: false })),
    } as unknown as Ctx["authz"],
    clock: { now: () => NOW } as Ctx["clock"],
    rateLimit: fakeRateLimit() as unknown as Ctx["rateLimit"],
    logger: createTestLogger(),
    actorHumanId: signedIn ? ACTOR_ID : null,
    auth: null,
    authToken: null,
    apiKey: null,
    clientIp: "203.0.113.9",
    ...(signedIn ? authedSession : {}),
  } as unknown as Ctx;
  return { ctx, getAll };
}

const callerFor = (ctx: Ctx) =>
  trpcRouter({ arrivalAreas: router(arrivalAreasRouter) }).createCaller(ctx)
    .arrivalAreas;

/** The REAL wire errorFormatter (same probe as entity-reports.test.ts). */
const formatWire = (error: unknown) =>
  (
    t._config.errorFormatter as unknown as (opts: {
      shape: unknown;
      error: unknown;
    }) => { data: Record<string, unknown> }
  )({
    shape: {
      message: "x",
      code: -32600,
      data: { code: "CONFLICT", httpStatus: 409, path: "arrivalAreas.update" },
    },
    error,
  });

const lastInput = (fn: ReturnType<typeof vi.fn>) =>
  fn.mock.calls.at(-1)?.[1] as Record<string, unknown> | undefined;

const VISIBLE = {
  areas: [
    {
      id: AREA_ID,
      source: "PLACE",
      kind: "PARKING",
      label: "Back lot",
      cost: "FREE",
      priceText: null,
      note: null,
      accessibleSpots: false,
      geometry: SQUARE,
      directions: { lat: 36.1605, lng: -86.7795 },
    },
  ],
  cacheablePublic: true,
};

beforeEach(() => {
  for (const fn of Object.values(useCases)) fn.mockReset();
  gateMocks.hasFullEventReadAccessByEventId.mockReset();
  gateMocks.hasFullEventReadAccessByEventId.mockResolvedValue(true);
  useCases.listArrivalAreasForViewer.mockResolvedValue(VISIBLE);
});

// ── FR-017: the feature gate ────────────────────────────────────────────────

describe("arrivalAreas.*: gate off (FR-017)", () => {
  it("the public reads answer with no areas, uncacheable, and never call the projection", async () => {
    const { ctx } = buildCtx({ gateOn: false });
    const caller = callerFor(ctx);
    const empty = { areas: [], cacheablePublic: false };
    await expect(caller.listForPlace({ placeId: PLACE_ID })).resolves.toEqual(empty);
    await expect(caller.listForEvent({ eventId: EVENT_ID })).resolves.toEqual(empty);
    expect(useCases.listArrivalAreasForViewer).not.toHaveBeenCalled();
    expect(gateMocks.hasFullEventReadAccessByEventId).not.toHaveBeenCalled();
  });

  it("the editor read and every mutation answer ARRIVAL_AREA_NOT_FOUND before any use case runs", async () => {
    const { ctx } = buildCtx({ gateOn: false });
    const caller = callerFor(ctx);
    const calls: Array<Promise<unknown>> = [
      caller.listForEditor({ placeId: PLACE_ID }),
      caller.create({
        placeId: PLACE_ID,
        kind: "PARKING",
        label: "Lot",
        geometry: SQUARE,
      }),
      caller.update({
        eventId: EVENT_ID,
        arrivalAreaId: AREA_ID,
        expectedUpdatedAt: NOW,
        patch: { label: "Lot" },
      }),
      caller.reorder({ placeId: PLACE_ID, orderedIds: [AREA_ID] }),
      caller.remove({
        placeId: PLACE_ID,
        arrivalAreaId: AREA_ID,
        expectedUpdatedAt: NOW,
      }),
      caller.setHiddenForEvent({
        eventId: EVENT_ID,
        arrivalAreaId: AREA_ID,
        hidden: true,
      }),
    ];
    for (const call of calls) {
      const err = await call.catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "NOT_FOUND" });
      expect(formatWire(err).data.appCode).toBe("ARRIVAL_AREA_NOT_FOUND");
    }
    for (const fn of Object.values(useCases)) expect(fn).not.toHaveBeenCalled();
  });
});

// ── Server-injected fields ──────────────────────────────────────────────────

describe("arrivalAreas.*: a client cannot supply a server field", () => {
  it("listForEvent refuses viewerHumanId and gateAccessGranted", async () => {
    const caller = callerFor(buildCtx().ctx);
    for (const extra of [{ viewerHumanId: ACTOR_ID }, { gateAccessGranted: true }]) {
      await expect(
        caller.listForEvent({ eventId: EVENT_ID, ...extra } as never),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(useCases.listArrivalAreasForViewer).not.toHaveBeenCalled();
  });

  it("listForPlace refuses viewerHumanId, and takes a place only", async () => {
    const caller = callerFor(buildCtx().ctx);
    await expect(
      caller.listForPlace({ placeId: PLACE_ID, viewerHumanId: ACTOR_ID } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.listForPlace({ placeId: PLACE_ID, eventId: EVENT_ID } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.listForPlace({} as never)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(useCases.listArrivalAreasForViewer).not.toHaveBeenCalled();
  });

  it("the editor read and every mutation refuse actorHumanId", async () => {
    const caller = callerFor(buildCtx().ctx);
    const injected = { actorHumanId: ACTOR_ID };
    const calls: Array<Promise<unknown>> = [
      caller.listForEditor({ placeId: PLACE_ID, ...injected } as never),
      caller.create({
        placeId: PLACE_ID,
        kind: "PARKING",
        label: "Lot",
        geometry: SQUARE,
        ...injected,
      } as never),
      caller.update({
        placeId: PLACE_ID,
        arrivalAreaId: AREA_ID,
        expectedUpdatedAt: NOW,
        patch: {},
        ...injected,
      } as never),
      caller.reorder({ placeId: PLACE_ID, orderedIds: [], ...injected } as never),
      caller.remove({
        placeId: PLACE_ID,
        arrivalAreaId: AREA_ID,
        expectedUpdatedAt: NOW,
        ...injected,
      } as never),
      caller.setHiddenForEvent({
        eventId: EVENT_ID,
        arrivalAreaId: AREA_ID,
        hidden: true,
        ...injected,
      } as never),
    ];
    for (const call of calls) {
      await expect(call).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    for (const fn of Object.values(useCases)) expect(fn).not.toHaveBeenCalled();
  });

  it("the parent refinement survives the omit: exactly one of placeId / eventId", async () => {
    const caller = callerFor(buildCtx().ctx);
    const base = { kind: "PARKING" as const, label: "Lot", geometry: SQUARE };
    await expect(
      caller.create({ ...base, placeId: PLACE_ID, eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.create(base as never)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(caller.listForEditor({} as never)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(useCases.createArrivalArea).not.toHaveBeenCalled();
  });

  it("the actor comes from ctx", async () => {
    useCases.createArrivalArea.mockResolvedValue(editorRow());
    const caller = callerFor(buildCtx().ctx);
    await caller.create({
      eventId: EVENT_ID,
      kind: "PARKING",
      label: "Lot",
      geometry: SQUARE,
    });
    expect(lastInput(useCases.createArrivalArea)).toMatchObject({
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
    });
  });
});

// ── The event page's gate pass ──────────────────────────────────────────────

describe("arrivalAreas.listForEvent: the gate pass is the report path's", () => {
  it("a viewer past the event's gate reaches the projection with gateAccessGranted true and their id", async () => {
    const { ctx } = buildCtx();
    gateMocks.hasFullEventReadAccessByEventId.mockResolvedValue(true);
    await expect(callerFor(ctx).listForEvent({ eventId: EVENT_ID })).resolves.toEqual(
      VISIBLE,
    );
    expect(gateMocks.hasFullEventReadAccessByEventId).toHaveBeenCalledWith(
      expect.objectContaining({ actorHumanId: ACTOR_ID }),
      EVENT_ID,
    );
    expect(lastInput(useCases.listArrivalAreasForViewer)).toEqual({
      eventId: EVENT_ID,
      gateAccessGranted: true,
      viewerHumanId: ACTOR_ID,
    });
  });

  it("a viewer who has not passed it: gateAccessGranted false", async () => {
    gateMocks.hasFullEventReadAccessByEventId.mockResolvedValue(false);
    await callerFor(buildCtx().ctx).listForEvent({ eventId: EVENT_ID });
    expect(lastInput(useCases.listArrivalAreasForViewer)).toMatchObject({
      gateAccessGranted: false,
    });
  });

  it("anonymous: no viewer id", async () => {
    await callerFor(buildCtx({ signedIn: false }).ctx).listForEvent({
      eventId: EVENT_ID,
    });
    expect(lastInput(useCases.listArrivalAreasForViewer)).toEqual({
      eventId: EVENT_ID,
      gateAccessGranted: true,
    });
  });

  it("an event the viewer may not read answers exactly like no areas (no oracle)", async () => {
    gateMocks.hasFullEventReadAccessByEventId.mockRejectedValue(
      new AppError("EVENT_NOT_FOUND"),
    );
    await expect(
      callerFor(buildCtx().ctx).listForEvent({ eventId: EVENT_ID }),
    ).resolves.toEqual({ areas: [], cacheablePublic: false });
    expect(useCases.listArrivalAreasForViewer).not.toHaveBeenCalled();
  });

  it("any other gate-read failure is an error, not an empty answer", async () => {
    gateMocks.hasFullEventReadAccessByEventId.mockRejectedValue(new Error("db down"));
    await expect(
      callerFor(buildCtx().ctx).listForEvent({ eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
  });

  it("listForPlace passes the viewer and never asks an event gate", async () => {
    await callerFor(buildCtx().ctx).listForPlace({ placeId: PLACE_ID });
    expect(lastInput(useCases.listArrivalAreasForViewer)).toEqual({
      placeId: PLACE_ID,
      viewerHumanId: ACTOR_ID,
    });
    expect(gateMocks.hasFullEventReadAccessByEventId).not.toHaveBeenCalled();
  });
});

// ── Authentication ──────────────────────────────────────────────────────────

describe("arrivalAreas.*: signed out", () => {
  it("the editor read and every mutation are UNAUTHORIZED; no use case runs", async () => {
    const caller = callerFor(buildCtx({ signedIn: false }).ctx);
    const calls: Array<Promise<unknown>> = [
      caller.listForEditor({ placeId: PLACE_ID }),
      caller.create({
        placeId: PLACE_ID,
        kind: "PARKING",
        label: "Lot",
        geometry: SQUARE,
      }),
      caller.update({
        placeId: PLACE_ID,
        arrivalAreaId: AREA_ID,
        expectedUpdatedAt: NOW,
        patch: {},
      }),
      caller.reorder({ placeId: PLACE_ID, orderedIds: [] }),
      caller.remove({
        placeId: PLACE_ID,
        arrivalAreaId: AREA_ID,
        expectedUpdatedAt: NOW,
      }),
      caller.setHiddenForEvent({
        eventId: EVENT_ID,
        arrivalAreaId: AREA_ID,
        hidden: false,
      }),
    ];
    for (const call of calls) {
      await expect(call).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    }
    for (const fn of Object.values(useCases)) expect(fn).not.toHaveBeenCalled();
  });
});

// ── NFR-004: the conflict payload ───────────────────────────────────────────

describe("arrivalAreas.update / remove: the stale-write conflict (NFR-004)", () => {
  const updateCall = (ctx: Ctx) =>
    callerFor(ctx)
      .update({
        eventId: EVENT_ID,
        arrivalAreaId: AREA_ID,
        expectedUpdatedAt: new Date("2026-10-17T11:00:00.000Z"),
        patch: { label: "New" },
      })
      .catch((e: unknown) => e);

  it("carries the current row as the editor projection, a user-facing code, known keys only", async () => {
    useCases.updateArrivalArea.mockRejectedValue(
      new AppError("ARRIVAL_AREA_CONFLICT", {
        meta: { current: { ...editorRow(), internalOnly: "x" } },
      }),
    );
    const err = await updateCall(buildCtx().ctx);
    expect(err).toMatchObject({ code: "CONFLICT" });
    const data = formatWire(err).data;
    expect(data.appCode).toBe("ARRIVAL_AREA_CONFLICT");
    const current = (data.meta as { current: Record<string, unknown> }).current;
    expect(current).toMatchObject({ id: AREA_ID, label: "Back lot", geometry: SQUARE });
    expect(current).not.toHaveProperty("internalOnly");
  });

  it("a withheld row reaches the wire without its shape, note or price", async () => {
    useCases.updateArrivalArea.mockRejectedValue(
      new AppError("ARRIVAL_AREA_CONFLICT", {
        meta: {
          current: editorRow({
            geometry: null,
            note: null,
            priceText: null,
            geometryWithheld: true,
          }),
        },
      }),
    );
    const err = await updateCall(buildCtx().ctx);
    const wire = JSON.stringify(formatWire(err).data);
    expect(wire).not.toContain("36.16");
    expect(wire).not.toContain("blue house");
    expect(wire).toContain('"geometryWithheld":true');
  });

  it("a row that claims to be withheld but still carries location data is dropped (fail closed)", async () => {
    useCases.removeArrivalArea.mockRejectedValue(
      new AppError("ARRIVAL_AREA_CONFLICT", {
        meta: { current: editorRow({ geometryWithheld: true }), extra: 1 },
      }),
    );
    const err = await callerFor(buildCtx().ctx)
      .remove({ eventId: EVENT_ID, arrivalAreaId: AREA_ID, expectedUpdatedAt: NOW })
      .catch((e: unknown) => e);
    const data = formatWire(err).data;
    expect(data.appCode).toBe("ARRIVAL_AREA_CONFLICT");
    expect(data.meta).toMatchObject({ extra: 1 });
    expect(data.meta).not.toHaveProperty("current");
    expect(JSON.stringify(data)).not.toContain("36.16");
  });

  it("an unparseable current row is dropped too", async () => {
    useCases.updateArrivalArea.mockRejectedValue(
      new AppError("ARRIVAL_AREA_CONFLICT", {
        meta: { current: { id: AREA_ID, geometry: SQUARE } },
      }),
    );
    const err = await updateCall(buildCtx().ctx);
    expect(formatWire(err).data.meta).not.toHaveProperty("current");
  });

  it("reorder's conflict keeps its id list untouched", async () => {
    useCases.reorderArrivalAreas.mockRejectedValue(
      new AppError("ARRIVAL_AREA_CONFLICT", { meta: { currentIds: [AREA_ID] } }),
    );
    const err = await callerFor(buildCtx().ctx)
      .reorder({ placeId: PLACE_ID, orderedIds: [] })
      .catch((e: unknown) => e);
    expect(formatWire(err).data.meta).toMatchObject({ currentIds: [AREA_ID] });
  });
});

describe("arrivalAreas.*: the promoted error codes reach the client", () => {
  it.each([
    ["ARRIVAL_AREA_NOT_FOUND", "NOT_FOUND"],
    ["ARRIVAL_AREA_LIMIT_REACHED", "CONFLICT"],
    ["ARRIVAL_AREA_INVALID_GEOMETRY", "BAD_REQUEST"],
  ] as const)("%s → %s with its app code and meta", async (code, trpcCode) => {
    useCases.createArrivalArea.mockRejectedValue(
      new AppError(code, { meta: { reason: "OUTSIDE_ENVELOPE", limitMeters: 3000 } }),
    );
    const err = await callerFor(buildCtx().ctx)
      .create({ placeId: PLACE_ID, kind: "PARKING", label: "Lot", geometry: SQUARE })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: trpcCode });
    const data = formatWire(err).data;
    expect(data.appCode).toBe(code);
    expect(data.meta).toMatchObject({ reason: "OUTSIDE_ENVELOPE", limitMeters: 3000 });
  });
});

// ── The handoff: what the transport passes, the use case accepts ────────────

describe("arrivalAreas.*: each use case accepts exactly what the transport hands it", () => {
  it("every procedure's forwarded input passes the use case's own strict schema", async () => {
    const actual =
      await vi.importActual<typeof import("@th/core/use-cases/arrival-areas")>(
        "@th/core/use-cases/arrival-areas",
      );
    useCases.listArrivalAreasForEditor.mockResolvedValue({
      parent: "place",
      placeId: PLACE_ID,
      editorKind: "owner",
      pin: null,
      addressWithheld: false,
      areas: [],
      limit: 10,
    });
    useCases.createArrivalArea.mockResolvedValue(editorRow());
    useCases.updateArrivalArea.mockResolvedValue(editorRow());
    useCases.reorderArrivalAreas.mockResolvedValue([editorRow()]);
    useCases.removeArrivalArea.mockResolvedValue({ id: AREA_ID, removed: true });
    useCases.setEventArrivalAreaHidden.mockResolvedValue({
      parent: "event",
      eventId: EVENT_ID,
      pin: null,
      addressWithheld: false,
      areas: [],
      placeAreas: [],
      allPublicHidden: false,
      limit: 10,
    });
    const caller = callerFor(buildCtx().ctx);
    await caller.listForPlace({ placeId: PLACE_ID });
    await caller.listForEvent({ eventId: EVENT_ID });
    await caller.listForEditor({ eventId: EVENT_ID });
    await caller.create({
      placeId: PLACE_ID,
      kind: "ACCESSIBLE_DROP_OFF",
      label: "  Front door  ",
      priceText: "",
      note: "Ramp on the left",
      geometry: SQUARE,
    });
    await caller.update({
      eventId: EVENT_ID,
      arrivalAreaId: AREA_ID,
      expectedUpdatedAt: NOW.toISOString() as never,
      patch: { note: null, geometry: SQUARE },
    });
    await caller.reorder({ eventId: EVENT_ID, orderedIds: [AREA_ID] });
    await caller.remove({ placeId: PLACE_ID, arrivalAreaId: AREA_ID, expectedUpdatedAt: NOW });
    await caller.setHiddenForEvent({ eventId: EVENT_ID, arrivalAreaId: AREA_ID, hidden: true });

    const pairs = [
      [useCases.listArrivalAreasForViewer, actual.listArrivalAreasForViewerInputSchema],
      [useCases.listArrivalAreasForEditor, actual.listArrivalAreasForEditorInputSchema],
      [useCases.createArrivalArea, actual.createArrivalAreaInputSchema],
      [useCases.updateArrivalArea, actual.updateArrivalAreaInputSchema],
      [useCases.reorderArrivalAreas, actual.reorderArrivalAreasInputSchema],
      [useCases.removeArrivalArea, actual.removeArrivalAreaInputSchema],
      [useCases.setEventArrivalAreaHidden, actual.setEventArrivalAreaHiddenInputSchema],
    ] as const;
    for (const [fn, schema] of pairs) {
      expect(fn).toHaveBeenCalled();
      for (const call of fn.mock.calls) {
        const result = (schema as { safeParse: (v: unknown) => { success: boolean; error?: unknown } }).safeParse(call[1]);
        expect(result.error).toBeUndefined();
        expect(result.success).toBe(true);
      }
    }
  });
});
