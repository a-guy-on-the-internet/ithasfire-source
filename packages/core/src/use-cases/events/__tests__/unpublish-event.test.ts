import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";

import { unpublishEvent } from "../unpublish-event";

const EVENT_ID = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-000000000002";
const ACTOR_ID = "00000000-0000-4000-8000-000000000003";
const ATTESTATION_ID = "attestation-1";

const buildEvent = (overrides: Partial<EventRecord> = {}): EventRecord =>
  ({
    id: EVENT_ID,
    orgId: ORG_ID,
    humanId: null,
    status: "PUBLISHED",
    title: "Published Event",
    publishedAt: new Date("2026-05-15T12:00:00.000Z"),
    currentAttestationId: ATTESTATION_ID,
    ...overrides,
  }) as EventRecord;

function makeContext(
  eventOverrides: Partial<EventRecord> = {},
  opts: { eventChangeNoticesCreate?: ReturnType<typeof vi.fn> } = {},
) {
  let currentEvent = buildEvent(eventOverrides);
  const attestationHistory = [ATTESTATION_ID];

  const events = {
    lockRows: vi.fn(async (_input: { ids: string[]; mode: string }) => {}),
    getById: vi.fn(async (eventId: string) =>
      eventId === currentEvent.id ? { ...currentEvent } : null,
    ),
    unpublish: vi.fn(async ({ eventId }: { eventId: string }) => {
      if (eventId !== currentEvent.id) {
        throw new Error("event not found");
      }
      currentEvent = {
        ...currentEvent,
        status: "DRAFT",
        currentAttestationId: null,
      };
      return { ...currentEvent };
    }),
  };
  const authz = {
    getOrgMembership: vi.fn(async () => ({
      orgId: ORG_ID,
      humanId: ACTOR_ID,
      role: "ADMIN",
    })),
  };
  const orders = {
    listAll: vi.fn(async () => ({ items: [], total: 0 })),
  };
  const eventChangeNotices = {
    create:
      opts.eventChangeNoticesCreate ??
      vi.fn(async () => ({ id: "notice-1", createdAt: new Date() })),
  };

  const txRepos = {
    events,
    eventChangeNotices,
  } as unknown as TxRepos;

  const repos = {
    events,
    authz,
    orders,
    eventChangeNotices,
    // Real transactions roll back on throw: snapshot the mutable event state
    // before running the callback and restore it if the callback rejects, so a
    // failed notice write also reverts the unpublish (atomicity).
    tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) => {
      const snapshot = currentEvent;
      try {
        return await fn(txRepos);
      } catch (error) {
        currentEvent = snapshot;
        throw error;
      }
    }),
  } as unknown as Repos;

  return {
    // The unpublish stamps its search reindex mark with the clock.
    deps: { repos, clock: { now: () => new Date("2026-06-01T12:00:00.000Z") } },
    events,
    orders,
    eventChangeNotices,
    getCurrentEvent: () => currentEvent,
    /** A concurrent writer committing (e.g. `cancelEvent`). */
    setCurrentEvent: (overrides: Partial<EventRecord>) => {
      currentEvent = { ...currentEvent, ...overrides };
    },
    attestationHistory,
  };
}

describe("unpublishEvent", () => {
  it("clears the current attestation pointer and preserves attestation history", async () => {
    const ctx = makeContext();

    const result = await unpublishEvent(ctx.deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
    });

    expect(result).toEqual({ eventId: EVENT_ID, status: "DRAFT" });
    expect(ctx.events.unpublish).toHaveBeenCalledWith({ eventId: EVENT_ID });
    expect(ctx.getCurrentEvent().currentAttestationId).toBeNull();
    expect(ctx.attestationHistory).toEqual([ATTESTATION_ID]);
  });

  it("does not require a current attestation to unpublish", async () => {
    const ctx = makeContext({ currentAttestationId: null });

    await expect(
      unpublishEvent(ctx.deps, {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
      }),
    ).resolves.toEqual({ eventId: EVENT_ID, status: "DRAFT" });

    expect(ctx.events.unpublish).toHaveBeenCalledWith({ eventId: EVENT_ID });
  });

  it("writes an UNPUBLISHED change-notice for the event's watchers", async () => {
    const ctx = makeContext({ title: "Riverside Jazz" });

    await unpublishEvent(ctx.deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
    });

    expect(ctx.eventChangeNotices.create).toHaveBeenCalledTimes(1);
    expect(ctx.eventChangeNotices.create).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      changeType: "UNPUBLISHED",
      payload: { eventTitle: "Riverside Jazz" },
    });
  });

  it("rolls the unpublish back with the notice write when the notice fails (atomic)", async () => {
    const failingCreate = vi.fn(async () => {
      throw new Error("notice insert failed");
    });
    const ctx = makeContext(
      { title: "Riverside Jazz" },
      { eventChangeNoticesCreate: failingCreate },
    );

    await expect(
      unpublishEvent(ctx.deps, {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
      }),
    ).rejects.toThrow("notice insert failed");

    // The unpublish leg ran inside the same tx…
    expect(ctx.events.unpublish).toHaveBeenCalledWith({ eventId: EVENT_ID });
    // …but the failed notice write rolled the whole tx back: still PUBLISHED.
    expect(ctx.getCurrentEvent().status).toBe("PUBLISHED");
  });

  it("re-reads the event under a FOR UPDATE lock inside the tx before flipping it", async () => {
    const ctx = makeContext();

    await unpublishEvent(ctx.deps, { actorHumanId: ACTOR_ID, eventId: EVENT_ID });

    expect(ctx.events.lockRows).toHaveBeenCalledWith({
      ids: [EVENT_ID],
      mode: "update",
    });
    const lockOrder = ctx.events.lockRows.mock.invocationCallOrder[0]!;
    const getByIdOrders = ctx.events.getById.mock.invocationCallOrder;
    // A re-read AFTER the lock, and the flip after that.
    expect(getByIdOrders.some((o) => o > lockOrder)).toBe(true);
    expect(ctx.events.unpublish.mock.invocationCallOrder[0]!).toBeGreaterThan(
      Math.max(...getByIdOrders),
    );
  });

  it("refuses, writing nothing, when a cancel committed while it waited for the row lock (TOCTOU)", async () => {
    const ctx = makeContext();
    // The pre-tx load saw PUBLISHED; `cancelEvent` commits before our lock is
    // granted, so the in-tx re-read sees CANCELLED.
    ctx.events.lockRows.mockImplementationOnce(async () => {
      ctx.setCurrentEvent({ status: "CANCELLED" });
    });

    await expect(
      unpublishEvent(ctx.deps, { actorHumanId: ACTOR_ID, eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_PUBLISHED" });

    expect(ctx.events.unpublish).not.toHaveBeenCalled();
    expect(ctx.eventChangeNotices.create).not.toHaveBeenCalled();
  });

  it("refuses with EVENT_NOT_FOUND when the row is gone by the in-tx re-read", async () => {
    const ctx = makeContext();
    ctx.events.getById
      .mockImplementationOnce(async () => ({ ...ctx.getCurrentEvent() }))
      .mockImplementationOnce(async () => null);

    await expect(
      unpublishEvent(ctx.deps, { actorHumanId: ACTOR_ID, eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
    expect(ctx.events.unpublish).not.toHaveBeenCalled();
  });
});
