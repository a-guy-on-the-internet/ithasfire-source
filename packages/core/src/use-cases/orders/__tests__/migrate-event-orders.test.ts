import { describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { Repos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";

import {
  migrateEventOrders,
  type MigrateEventOrdersDeps,
} from "../migrate-event-orders";

// ── Constants ────────────────────────────────────────────────────────────────

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_HUMAN_ID = "00000000-0000-4000-8000-000000000099";
const SOURCE_EVENT_ID = "00000000-0000-4000-8000-000000000010";
const TARGET_EVENT_ID = "00000000-0000-4000-8000-000000000020";
const ORG_ID = "00000000-0000-4000-8000-000000000030";
const OTHER_ORG_ID = "00000000-0000-4000-8000-000000000031";
const NOW = new Date("2026-04-01T12:00:00.000Z");

const SOURCE_TT_ID = "tt-source-general";
const TARGET_TT_ID = "tt-target-general";

// ── Factories ────────────────────────────────────────────────────────────────

function makeEvent(overrides?: Partial<EventRecord>): EventRecord {
  return {
    id: SOURCE_EVENT_ID,
    orgId: ORG_ID,
    humanId: null,
    title: "Source Event",
    status: "PUBLISHED",
    visibility: "PUBLIC",
    gateType: "NONE",
    locationMode: "EXACT",
    locationRadiusMeters: null,
    locationLabel: null,
    addressRevealAt: null,
    addressRevealPreset: null,
    startsAt: new Date("2026-05-01T18:00:00.000Z"),
    endsAt: new Date("2026-05-01T22:00:00.000Z"),
    placeId: null,
    savedLocationId: null,
    categoryId: null,
    addressText: null,
    lat: null,
    lng: null,
    slug: "source-event",
    shortId: "src123",
    regionCode: null,
    publishedAt: new Date("2026-03-01T00:00:00.000Z"),
    agreementPrimaryId: "agreement-1",
    agreementResaleId: null,
    defaultLocale: null,
    listingPriority: null,
    passwordHash: null,
    passwordUpdatedAt: null,
    waitlistStatus: "DISABLED",
    waitlistPublishAt: null,
    waitlistDescription: null,
    waitlistCap: null,
    payoutTermsId: null,
    resalePayoutTermsId: null,
    placeLayoutId: null,
    refundCutoffAt: null,
    ...overrides,
  };
}

function makeSourceEvent(overrides?: Partial<EventRecord>): EventRecord {
  return makeEvent({
    id: SOURCE_EVENT_ID,
    title: "Source Event",
    ...overrides,
  });
}

function makeTargetEvent(overrides?: Partial<EventRecord>): EventRecord {
  return makeEvent({
    id: TARGET_EVENT_ID,
    title: "Target Event",
    slug: "target-event",
    shortId: "tgt123",
    ...overrides,
  });
}

function makeClock(): ClockPort {
  return { now: () => NOW };
}

function makeIdempotency(
  overrides?: Partial<IdempotencyPort>,
): IdempotencyPort {
  return {
    get: vi.fn(async () => null),
    begin: vi.fn(async () => true),
    commit: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
    ...overrides,
  };
}

function makeTicketType(id: string, name: string, capacity = 100) {
  return {
    id,
    name,
    priceCents: 2500,
    capacity,
    status: "ACTIVE" as const,
    seatSectionId: null,
    resaleAllowed: false,
    resaleCapCents: null,
    transferAllowed: true,
  };
}

type MockCallbacks = {
  eventsGetById?: (id: string) => Promise<EventRecord | null>;
  ordersListAll?: (
    input: any,
  ) => Promise<{ items: any[]; total: number; limit: number; offset: number }>;
  listTicketTypes?: (eventId: string) => Promise<any[]>;
  countIssuedForEvent?: (eventId: string) => Promise<number>;
  bulkMigrateOrders?: (
    input: any,
  ) => Promise<{ updatedCount: number; migratedOrderIds: string[] }>;
  bulkMigrateTickets?: (
    input: any,
  ) => Promise<{ updatedCount: number; migratedTicketIds: string[] }>;
  requireOrgMembership?: () => Promise<any>;
  getHumanDelegation?: (input: {
    principalId: string;
    delegateId: string;
  }) => Promise<any>;
};

function makeRepos(cbs?: MockCallbacks): Repos {
  const sourceEvent = makeSourceEvent();
  const targetEvent = makeTargetEvent();

  const eventsRepo = {
    getById:
      cbs?.eventsGetById ??
      vi.fn(async (id: string) => {
        if (id === SOURCE_EVENT_ID) return sourceEvent;
        if (id === TARGET_EVENT_ID) return targetEvent;
        return null;
      }),
    listTicketTypes:
      cbs?.listTicketTypes ??
      vi.fn(async (eventId: string) => {
        if (eventId === SOURCE_EVENT_ID)
          return [makeTicketType(SOURCE_TT_ID, "General Admission")];
        if (eventId === TARGET_EVENT_ID)
          return [makeTicketType(TARGET_TT_ID, "General Admission")];
        return [];
      }),
  };

  const ordersRepo = {
    listAll:
      cbs?.ordersListAll ??
      vi.fn(async () => ({
        items: [{ id: "order-1" }],
        total: 1,
        limit: 1,
        offset: 0,
      })),
    bulkMigrateToEvent:
      cbs?.bulkMigrateOrders ??
      vi.fn(async () => ({
        updatedCount: 1,
        migratedOrderIds: ["order-1"],
      })),
  };

  const ticketsRepo = {
    countIssuedForEvent: cbs?.countIssuedForEvent ?? vi.fn(async () => 5),
    bulkMigrateToEvent:
      cbs?.bulkMigrateTickets ??
      vi.fn(async () => ({
        updatedCount: 5,
        migratedTicketIds: [
          "ticket-1",
          "ticket-2",
          "ticket-3",
          "ticket-4",
          "ticket-5",
        ],
      })),
  };

  const auditRepo = {
    log: vi.fn(async () => undefined),
  };

  // RBAC: authz repo needs ensureOrgRole for requireOrgMembership
  const authzRepo = {
    getHumanDelegation: cbs?.getHumanDelegation ?? vi.fn(async () => null),
    getOrgMembership: vi.fn(async () => ({
      humanId: ACTOR_ID,
      orgId: ORG_ID,
      role: "ADMIN",
    })),
  };

  const txInner = {
    orders: ordersRepo,
    tickets: ticketsRepo,
    events: eventsRepo,
    audit: auditRepo,
    authz: authzRepo,
  };

  return {
    tx: vi.fn(
      async <T>(fn: (tx: any) => Promise<T>): Promise<T> => fn(txInner),
    ),
    events: eventsRepo,
    orders: ordersRepo,
    tickets: ticketsRepo,
    audit: auditRepo,
    authz: authzRepo,
  } as any;
}

function makeDeps(
  repoCbs?: MockCallbacks,
  idempotencyOverrides?: Partial<IdempotencyPort>,
): MigrateEventOrdersDeps {
  return {
    repos: makeRepos(repoCbs),
    idempotency: makeIdempotency(idempotencyOverrides),
    clock: makeClock(),
  };
}

function baseInput(overrides?: Record<string, unknown>) {
  return {
    actorHumanId: ACTOR_ID,
    sourceEventId: SOURCE_EVENT_ID,
    targetEventId: TARGET_EVENT_ID,
    clientKey: "migration-key-12345678",
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("migrateEventOrders", () => {
  // ── Happy path ───────────────────────────────────────────────────────

  it("migrates orders and tickets from source to target (org-owned)", async () => {
    const deps = makeDeps();
    const result = await migrateEventOrders(deps, baseInput());

    expect(result).toEqual({
      migratedOrderCount: 1,
      migratedTicketCount: 5,
      migratedOrderIds: ["order-1"],
      sourceEventId: SOURCE_EVENT_ID,
      targetEventId: TARGET_EVENT_ID,
    });
  });

  it("migrates orders for human-owned events", async () => {
    const deps = makeDeps({
      eventsGetById: vi.fn(async (id: string) => {
        if (id === SOURCE_EVENT_ID)
          return makeSourceEvent({ orgId: null, humanId: ACTOR_ID });
        if (id === TARGET_EVENT_ID)
          return makeTargetEvent({ orgId: null, humanId: ACTOR_ID });
        return null;
      }),
    });

    const result = await migrateEventOrders(deps, baseInput());

    expect(result.migratedOrderCount).toBe(1);
    expect(result.migratedTicketCount).toBe(5);
  });

  it("writes an audit log entry inside the transaction", async () => {
    const deps = makeDeps();
    let capturedAuditLog: any = null;

    // Intercept the tx to capture audit calls
    const originalTx = deps.repos.tx;
    deps.repos.tx = vi.fn(async (fn: any) => {
      return originalTx(async (tx: any) => {
        const origLog = tx.audit.log;
        tx.audit.log = vi.fn(async (...args: any[]) => {
          capturedAuditLog = args[0];
          return origLog(...args);
        });
        return fn(tx);
      });
    }) as any;

    await migrateEventOrders(deps, baseInput());

    expect(capturedAuditLog).toBeTruthy();
    expect(capturedAuditLog.entity).toBe("event");
    expect(capturedAuditLog.entityId).toBe(SOURCE_EVENT_ID);
    expect(capturedAuditLog.action).toBe("orders_migrated");
    expect(capturedAuditLog.data.targetEventId).toBe(TARGET_EVENT_ID);
  });

  it("commits the idempotency key on success", async () => {
    const idempotency = makeIdempotency();
    const deps = makeDeps(undefined, idempotency);

    await migrateEventOrders(deps, baseInput());

    expect(idempotency.commit).toHaveBeenCalledOnce();
  });

  // ── Idempotency replay ───────────────────────────────────────────────

  it("replays a committed idempotency result", async () => {
    const storedResponse = {
      migratedOrderCount: 3,
      migratedTicketCount: 10,
      migratedOrderIds: ["order-a", "order-b", "order-c"],
      sourceEventId: SOURCE_EVENT_ID,
      targetEventId: TARGET_EVENT_ID,
    };
    const deps = makeDeps(undefined, {
      get: vi.fn(async () => ({
        payloadHash: JSON.stringify({
          sourceEventId: SOURCE_EVENT_ID,
          targetEventId: TARGET_EVENT_ID,
        }),
        response: storedResponse,
      })),
    });

    const result = await migrateEventOrders(deps, baseInput());

    expect(result).toEqual(storedResponse);
    // Should NOT have tried to begin a new lock
    expect(deps.idempotency.begin).not.toHaveBeenCalled();
  });

  it("throws transient when idempotency lock is held", async () => {
    const deps = makeDeps(undefined, {
      get: vi.fn(async () => null),
      begin: vi.fn(async () => false),
    });

    await expect(migrateEventOrders(deps, baseInput())).rejects.toMatchObject({ code: "IDEMPOTENCY_LOCK_IN_PROGRESS" });
  });

  // ── Validation errors ────────────────────────────────────────────────

  it("rejects when source and target are the same event", async () => {
    const deps = makeDeps();

    await expect(
      migrateEventOrders(deps, baseInput({ targetEventId: SOURCE_EVENT_ID })),
    ).rejects.toMatchObject({ code: "SOURCE_AND_TARGET_MUST_DIFFER" });
  });

  it("rejects with not_found when source event does not exist", async () => {
    const deps = makeDeps({
      eventsGetById: vi.fn(async (id: string) => {
        if (id === TARGET_EVENT_ID) return makeTargetEvent();
        return null;
      }),
    });

    await expect(migrateEventOrders(deps, baseInput())).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("rejects with not_found when target event does not exist", async () => {
    const deps = makeDeps({
      eventsGetById: vi.fn(async (id: string) => {
        if (id === SOURCE_EVENT_ID) return makeSourceEvent();
        return null;
      }),
    });

    await expect(migrateEventOrders(deps, baseInput())).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  // ── Same-owner checks ───────────────────────────────────────────────

  it("rejects when org-owned events have different orgIds", async () => {
    const deps = makeDeps({
      eventsGetById: vi.fn(async (id: string) => {
        if (id === SOURCE_EVENT_ID) return makeSourceEvent({ orgId: ORG_ID });
        if (id === TARGET_EVENT_ID)
          return makeTargetEvent({ orgId: OTHER_ORG_ID });
        return null;
      }),
    });

    await expect(migrateEventOrders(deps, baseInput())).rejects.toMatchObject({ code: "EVENTS_DIFFERENT_ORG" });
  });

  it("rejects when human-owned events have different humanIds", async () => {
    const deps = makeDeps({
      eventsGetById: vi.fn(async (id: string) => {
        if (id === SOURCE_EVENT_ID)
          return makeSourceEvent({ orgId: null, humanId: ACTOR_ID });
        if (id === TARGET_EVENT_ID)
          return makeTargetEvent({ orgId: null, humanId: OTHER_HUMAN_ID });
        return null;
      }),
    });

    await expect(migrateEventOrders(deps, baseInput())).rejects.toMatchObject({ code: "EVENTS_DIFFERENT_OWNER" });
  });

  it("rejects when one event is org-owned and the other is human-owned", async () => {
    const deps = makeDeps({
      eventsGetById: vi.fn(async (id: string) => {
        if (id === SOURCE_EVENT_ID)
          return makeSourceEvent({ orgId: ORG_ID, humanId: null });
        if (id === TARGET_EVENT_ID)
          return makeTargetEvent({ orgId: null, humanId: ACTOR_ID });
        return null;
      }),
    });

    await expect(migrateEventOrders(deps, baseInput())).rejects.toMatchObject({ code: "EVENTS_DIFFERENT_OWNER" });
  });

  // ── Target status checks ─────────────────────────────────────────────

  it("rejects when target event is CANCELLED", async () => {
    const deps = makeDeps({
      eventsGetById: vi.fn(async (id: string) => {
        if (id === SOURCE_EVENT_ID) return makeSourceEvent();
        if (id === TARGET_EVENT_ID)
          return makeTargetEvent({ status: "CANCELLED" });
        return null;
      }),
    });

    await expect(migrateEventOrders(deps, baseInput())).rejects.toMatchObject({ code: "TARGET_EVENT_NOT_ACTIVE" });
  });

  it("rejects when target event is COMPLETED", async () => {
    const deps = makeDeps({
      eventsGetById: vi.fn(async (id: string) => {
        if (id === SOURCE_EVENT_ID) return makeSourceEvent();
        if (id === TARGET_EVENT_ID)
          return makeTargetEvent({ status: "COMPLETED" });
        return null;
      }),
    });

    await expect(migrateEventOrders(deps, baseInput())).rejects.toMatchObject({ code: "TARGET_EVENT_NOT_ACTIVE" });
  });

  it("allows migration to a DRAFT target event", async () => {
    const deps = makeDeps({
      eventsGetById: vi.fn(async (id: string) => {
        if (id === SOURCE_EVENT_ID) return makeSourceEvent();
        if (id === TARGET_EVENT_ID) return makeTargetEvent({ status: "DRAFT" });
        return null;
      }),
    });

    const result = await migrateEventOrders(deps, baseInput());
    expect(result.migratedOrderCount).toBe(1);
  });

  // ── RBAC ──────────────────────────────────────────────────────────────

  it("rejects when human actor does not own the human event", async () => {
    const deps = makeDeps({
      eventsGetById: vi.fn(async (id: string) => {
        if (id === SOURCE_EVENT_ID)
          return makeSourceEvent({ orgId: null, humanId: OTHER_HUMAN_ID });
        if (id === TARGET_EVENT_ID)
          return makeTargetEvent({ orgId: null, humanId: OTHER_HUMAN_ID });
        return null;
      }),
    });

    await expect(migrateEventOrders(deps, baseInput())).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  // ── A human owner's delegates (owner ruling 2026-09-28) ─────────────────
  // Migration is an ORG_ADMIN_ROLES action, so an OWNER/ADMIN delegate may,
  // an EDITOR delegate may not. And a delegate can never divert the
  // principal's orders onto an event of their OWN: same-owner is checked
  // first, whatever the delegate's role.
  describe("a delegate of the human owner", () => {
    const humanPair = (targetOwner: string) =>
      vi.fn(async (id: string) => {
        if (id === SOURCE_EVENT_ID)
          return makeSourceEvent({ orgId: null, humanId: OTHER_HUMAN_ID });
        if (id === TARGET_EVENT_ID)
          return makeTargetEvent({ orgId: null, humanId: targetOwner });
        return null;
      });
    const delegation = (role: string) =>
      vi.fn(async () => ({
        orgId: OTHER_HUMAN_ID,
        humanId: ACTOR_ID,
        role,
      }));

    it("an ADMIN delegate migrates between the principal's events", async () => {
      const getHumanDelegation = delegation("ADMIN");
      const deps = makeDeps({
        eventsGetById: humanPair(OTHER_HUMAN_ID),
        getHumanDelegation,
      });

      const result = await migrateEventOrders(deps, baseInput());

      expect(result.migratedOrderCount).toBe(1);
      expect(getHumanDelegation).toHaveBeenCalledWith({
        principalId: OTHER_HUMAN_ID,
        delegateId: ACTOR_ID,
      });
    });

    it("an EDITOR delegate is refused (ORG_ADMIN_ROLES) and nothing moves", async () => {
      const bulkMigrateOrders = vi.fn();
      const bulkMigrateTickets = vi.fn();
      const deps = makeDeps({
        eventsGetById: humanPair(OTHER_HUMAN_ID),
        getHumanDelegation: delegation("EDITOR"),
        bulkMigrateOrders,
        bulkMigrateTickets,
      });

      await expect(migrateEventOrders(deps, baseInput())).rejects.toMatchObject({
        code: "NOT_RESOURCE_OWNER",
      });
      expect(bulkMigrateOrders).not.toHaveBeenCalled();
      expect(bulkMigrateTickets).not.toHaveBeenCalled();
    });

    it("an OWNER-role delegate cannot divert the principal's orders onto their OWN event", async () => {
      const bulkMigrateOrders = vi.fn();
      const bulkMigrateTickets = vi.fn();
      const deps = makeDeps({
        // Source: the principal's. Target: the delegate's own event.
        eventsGetById: humanPair(ACTOR_ID),
        getHumanDelegation: delegation("OWNER"),
        bulkMigrateOrders,
        bulkMigrateTickets,
      });

      await expect(migrateEventOrders(deps, baseInput())).rejects.toMatchObject({
        code: "EVENTS_DIFFERENT_OWNER",
      });
      expect(bulkMigrateOrders).not.toHaveBeenCalled();
      expect(bulkMigrateTickets).not.toHaveBeenCalled();
    });
  });

  // ── No orders to migrate ──────────────────────────────────────────────

  it("rejects when source has no eligible orders", async () => {
    const deps = makeDeps({
      ordersListAll: vi.fn(async () => ({
        items: [],
        total: 0,
        limit: 1,
        offset: 0,
      })),
    });

    await expect(migrateEventOrders(deps, baseInput())).rejects.toMatchObject({ code: "NO_ORDERS_TO_MIGRATE" });
  });

  // ── Capacity checks ──────────────────────────────────────────────────

  it("rejects when target lacks capacity for migrated tickets", async () => {
    const deps = makeDeps({
      // Source has 50 tickets
      countIssuedForEvent: vi.fn(async (eventId: string) => {
        if (eventId === SOURCE_EVENT_ID) return 50;
        if (eventId === TARGET_EVENT_ID) return 80;
        return 0;
      }),
      // Target has capacity of 100 total, already 80 issued → 50 more won't fit
      listTicketTypes: vi.fn(async (eventId: string) => {
        if (eventId === SOURCE_EVENT_ID)
          return [makeTicketType(SOURCE_TT_ID, "General Admission", 200)];
        if (eventId === TARGET_EVENT_ID)
          return [makeTicketType(TARGET_TT_ID, "General Admission", 100)];
        return [];
      }),
    });

    await expect(migrateEventOrders(deps, baseInput())).rejects.toMatchObject({ code: "INSUFFICIENT_CAPACITY" });
  });

  it("skips capacity check when target has zero total capacity (unlimited)", async () => {
    const deps = makeDeps({
      countIssuedForEvent: vi.fn(async () => 500),
      listTicketTypes: vi.fn(async (eventId: string) => {
        if (eventId === SOURCE_EVENT_ID)
          return [makeTicketType(SOURCE_TT_ID, "General Admission", 0)];
        if (eventId === TARGET_EVENT_ID)
          return [makeTicketType(TARGET_TT_ID, "General Admission", 0)];
        return [];
      }),
    });

    const result = await migrateEventOrders(deps, baseInput());
    expect(result.migratedOrderCount).toBe(1);
  });

  // ── Ticket type mapping ───────────────────────────────────────────────

  it("builds ticket type mapping by name (case-insensitive)", async () => {
    const bulkMigrateTickets = vi.fn(async () => ({
      updatedCount: 3,
      migratedTicketIds: ["t1", "t2", "t3"],
    }));

    const deps = makeDeps({
      listTicketTypes: vi.fn(async (eventId: string) => {
        if (eventId === SOURCE_EVENT_ID) {
          return [
            makeTicketType("src-ga", "General Admission"),
            makeTicketType("src-vip", "VIP"),
          ];
        }
        if (eventId === TARGET_EVENT_ID) {
          return [
            makeTicketType("tgt-ga", "general admission"),
            makeTicketType("tgt-vip", "vip"),
          ];
        }
        return [];
      }),
      bulkMigrateTickets,
    });

    await migrateEventOrders(deps, baseInput());

    expect(bulkMigrateTickets).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketTypeMapping: {
          "src-ga": "tgt-ga",
          "src-vip": "tgt-vip",
        },
      }),
    );
  });

  // ── Idempotency fail on error ─────────────────────────────────────────

  it("calls idempotency.fail when use case throws", async () => {
    const idempotency = makeIdempotency();
    const deps = makeDeps(
      {
        eventsGetById: vi.fn(async () => null),
      },
      idempotency,
    );

    await expect(migrateEventOrders(deps, baseInput())).rejects.toBeTruthy();
    expect(idempotency.fail).toHaveBeenCalledOnce();
  });
});
