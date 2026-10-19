import { describe, expect, it, vi } from "vitest";

import { exportEventAttendees } from "../export-event-attendees";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const EVENT_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-07-30T12:00:00.000Z");

function makeRow(i: number) {
  return {
    orderId: `44444444-4444-4444-8444-${String(i).padStart(12, "0")}`,
    buyerHumanId: "55555555-5555-4555-8555-555555555555",
    buyerName: `Buyer ${i}`,
    buyerEmail: `buyer${i}@example.com`,
    ticketCount: 1,
    amountGrossCents: 1000,
    currency: "usd",
    status: "SUCCEEDED" as const,
    source: "PRIMARY" as const,
    occurredAt: NOW,
  };
}

function makeDeps(overrides?: { allowed?: boolean; total?: number }) {
  const total = overrides?.total ?? 2;
  const all = Array.from({ length: total }, (_, i) => makeRow(i));

  return {
    repos: {
      orders: {
        searchEventAttendees: vi.fn(
          async (input: { limit: number; offset: number }) => ({
            items: all.slice(input.offset, input.offset + input.limit),
            total,
            limit: input.limit,
            offset: input.offset,
          }),
        ),
      },
      audit: { log: vi.fn(async () => undefined) },
    },
    authz: {
      hasOrgRole: vi.fn(async () => ({
        allowed: overrides?.allowed ?? true,
      })),
    },
    clock: { now: () => NOW },
  } as any;
}

describe("exportEventAttendees", () => {
  // The whole reason this is a separate use case: bulk egress is finance-only,
  // one tier narrower than the edit-or-finance paged read.
  it("requires finance roles, excluding EDITOR", async () => {
    const deps = makeDeps();

    await exportEventAttendees(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      eventId: EVENT_ID,
    });

    const { requiredRoles } = deps.authz.hasOrgRole.mock.calls[0][0];
    expect(requiredRoles).toEqual(
      expect.arrayContaining(["OWNER", "ADMIN", "FINANCE"]),
    );
    expect(requiredRoles).toHaveLength(3);
    expect(requiredRoles).not.toContain("EDITOR");
    expect(requiredRoles).not.toContain("VIEWER");
    expect(requiredRoles).not.toContain("SCANNER");
  });

  it("rejects and reads nothing when the actor lacks the role", async () => {
    const deps = makeDeps({ allowed: false });

    await expect(
      exportEventAttendees(deps, {
        actorHumanId: ACTOR_ID,
        orgId: ORG_ID,
        eventId: EVENT_ID,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(deps.repos.orders.searchEventAttendees).not.toHaveBeenCalled();
    // A refused export is not a disclosure — nothing to record.
    expect(deps.repos.audit.log).not.toHaveBeenCalled();
  });

  // The audit entry is what makes the export answerable afterwards.
  it("records the disclosure, including what it was narrowed to", async () => {
    const deps = makeDeps({ total: 2 });

    await exportEventAttendees(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      eventId: EVENT_ID,
      query: "jane",
      status: "REFUNDED",
    });

    expect(deps.repos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "event",
        entityId: EVENT_ID,
        action: "attendee_export",
        data: expect.objectContaining({
          actorHumanId: ACTOR_ID,
          orgId: ORG_ID,
          rowCount: 2,
          total: 2,
          truncated: false,
          query: "jane",
          status: "REFUNDED",
        }),
      }),
    );
  });

  // An audit-log outage must not deny an authorised export.
  it("still returns rows when the audit write throws", async () => {
    const deps = makeDeps({ total: 2 });
    deps.repos.audit.log = vi.fn(async () => {
      throw new Error("audit down");
    });

    const result = await exportEventAttendees(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      eventId: EVENT_ID,
    });

    expect(result.rows).toHaveLength(2);
  });

  it("walks every page rather than returning only the first", async () => {
    const deps = makeDeps({ total: 450 });

    const result = await exportEventAttendees(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      eventId: EVENT_ID,
    });

    expect(result.rows).toHaveLength(450);
    expect(result.total).toBe(450);
    expect(result.truncated).toBe(false);
    // 200 + 200 + 50
    expect(deps.repos.orders.searchEventAttendees).toHaveBeenCalledTimes(3);
  });

  // Over the ceiling the caller is told, rather than handed a short file that
  // looks complete.
  it("caps at the row ceiling and reports truncation", async () => {
    const deps = makeDeps({ total: 10_150 });

    const result = await exportEventAttendees(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      eventId: EVENT_ID,
    });

    expect(result.rows).toHaveLength(10_000);
    expect(result.total).toBe(10_150);
    expect(result.truncated).toBe(true);
    expect(deps.repos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ truncated: true, rowCount: 10_000 }),
      }),
    );
  });

  it("passes the active filters straight through to the repo", async () => {
    const deps = makeDeps();

    await exportEventAttendees(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      eventId: EVENT_ID,
      query: "jane@example.com",
      status: "DISPUTED",
    });

    expect(deps.repos.orders.searchEventAttendees).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_ID,
        eventId: EVENT_ID,
        searchQuery: "jane@example.com",
        status: "DISPUTED",
      }),
    );
  });
});
