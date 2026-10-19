import { describe, expect, it, vi } from "vitest";

import { searchEventAttendees } from "../search-event-attendees";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const EVENT_ID = "33333333-3333-4333-8333-333333333333";

function makeDeps(overrides?: {
  allowed?: boolean;
  items?: unknown[];
  total?: number;
}) {
  return {
    repos: {
      orders: {
        searchEventAttendees: vi.fn(async () => ({
          items: overrides?.items ?? [],
          total: overrides?.total ?? 0,
          limit: 25,
          offset: 0,
        })),
      },
    },
    authz: {
      hasOrgRole: vi.fn(async () => ({
        allowed: overrides?.allowed ?? true,
      })),
    },
  } as any;
}

describe("searchEventAttendees", () => {
  it("rejects when the actor holds none of the required roles", async () => {
    const deps = makeDeps({ allowed: false });

    await expect(
      searchEventAttendees(deps, {
        actorHumanId: ACTOR_ID,
        orgId: ORG_ID,
        eventId: EVENT_ID,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(deps.repos.orders.searchEventAttendees).not.toHaveBeenCalled();
  });

  // The door list is edit-OR-finance, not finance-only: an EDITOR running the
  // event must be able to read it. Bulk CSV egress keeps the narrower
  // finance-only gate in its own use case — if this set ever widens to include
  // VIEWER or SCANNER, that is a regression, not a feature.
  it("asks for edit-or-finance roles, excluding VIEWER and SCANNER", async () => {
    const deps = makeDeps();

    await searchEventAttendees(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      eventId: EVENT_ID,
    });

    expect(deps.authz.hasOrgRole).toHaveBeenCalledWith(
      expect.objectContaining({
        actorHumanId: ACTOR_ID,
        orgId: ORG_ID,
        requiredRoles: expect.arrayContaining([
          "OWNER",
          "ADMIN",
          "EDITOR",
          "FINANCE",
        ]),
      }),
    );

    const { requiredRoles } = deps.authz.hasOrgRole.mock.calls[0][0];
    expect(requiredRoles).toHaveLength(4);
    expect(requiredRoles).not.toContain("VIEWER");
    expect(requiredRoles).not.toContain("SCANNER");
  });

  it("passes eventId, orgId, and query to the repo", async () => {
    const deps = makeDeps();

    await searchEventAttendees(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      eventId: EVENT_ID,
      query: "jane@example.com",
      limit: 10,
      offset: 0,
    });

    expect(deps.repos.orders.searchEventAttendees).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_ID,
        eventId: EVENT_ID,
        searchQuery: "jane@example.com",
        limit: 10,
        offset: 0,
      }),
    );
  });

  it("returns paginated results", async () => {
    const deps = makeDeps({
      items: [
        {
          orderId: "44444444-4444-4444-8444-444444444444",
          buyerHumanId: "55555555-5555-4555-8555-555555555555",
          buyerName: "Jane Doe",
          buyerEmail: "jane@example.com",
          ticketCount: 2,
          amountGrossCents: 5000,
          currency: "usd",
          status: "SUCCEEDED",
          source: "PRIMARY",
          occurredAt: new Date("2025-06-01T12:00:00Z"),
        },
        // A comp is a $0 SUCCEEDED order — indistinguishable from a genuinely
        // free ticket unless `source` survives the output schema.
        {
          orderId: "66666666-6666-4666-8666-666666666666",
          buyerHumanId: "77777777-7777-4777-8777-777777777777",
          buyerName: "Comped Guest",
          buyerEmail: "comp@example.com",
          ticketCount: 1,
          amountGrossCents: 0,
          currency: "usd",
          status: "SUCCEEDED",
          source: "COMP",
          occurredAt: new Date("2025-06-02T12:00:00Z"),
        },
      ],
      total: 2,
    });

    const result = await searchEventAttendees(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      eventId: EVENT_ID,
    });

    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      buyerName: "Jane Doe",
      buyerEmail: "jane@example.com",
      ticketCount: 2,
      source: "PRIMARY",
    });
    // The whole point of carrying `source`: the UI can badge this row instead
    // of showing it as an anonymous $0.00.
    expect(result.items[1]).toMatchObject({
      amountGrossCents: 0,
      status: "SUCCEEDED",
      source: "COMP",
    });
    expect(result.pageInfo.total).toBe(2);
  });

  it("returns empty results with no match", async () => {
    const deps = makeDeps();

    const result = await searchEventAttendees(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      eventId: EVENT_ID,
      query: "nonexistent",
    });

    expect(result.items).toHaveLength(0);
    expect(result.pageInfo.total).toBe(0);
  });
});
