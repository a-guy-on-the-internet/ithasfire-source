import { describe, expect, it, vi } from "vitest";

import type { AuthZPort } from "@th/ports/authz";
import type { Repos } from "@th/ports/repos";
import { makeStubTicketTypeSummary } from "@th/test-utils";

import { listSellableItems } from "./list-sellable-items";

// Stub AuthZPort that always denies platform-staff access. Tests for the
// platform-admin override live alongside the use-case file; everything else
// uses this default so we don't accidentally bypass org-membership checks.
const denyingAuthz = {
  hasStaffRole: vi.fn(async () => ({ allowed: false })),
} as unknown as AuthZPort;

/**
 * `listSellableItems` now requires a clock: the door QUOTE it produces must
 * resolve a scheduled price change (FR-005) at the same instant the cash/card
 * sale will CHARGE at. No fixture here is scheduled, so every expectation
 * below is unchanged (NFR-001).
 */
const STUB_CLOCK = { now: () => new Date("2026-01-01T00:00:00.000Z") };

const ACTOR = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-0000000000a1";
const EVENT_ID = "00000000-0000-4000-8000-0000000000e1";
const TT_GA = "00000000-0000-4000-8000-0000000000a2";
const TT_VIP = "00000000-0000-4000-8000-0000000000a3";
const TT_INACTIVE = "00000000-0000-4000-8000-0000000000a4";

function makeDeps(opts: {
  event?: {
    orgId?: string | null;
    currency?: string | null;
    status?: string;
  } | null;
  membership?: { role: "SCANNER" } | null;
  ticketTypes?: Array<{
    id: string;
    name: string;
    priceCents: number;
    capacity: number;
    status: "ACTIVE" | "INACTIVE" | "ARCHIVED";
  }>;
  issuedByType?: Record<string, number>;
}) {
  const types = opts.ticketTypes ?? [
    {
      id: TT_GA,
      name: "GA",
      priceCents: 2500,
      capacity: 100,
      status: "ACTIVE" as const,
    },
    {
      id: TT_VIP,
      name: "VIP",
      priceCents: 5000,
      capacity: 10,
      status: "ACTIVE" as const,
    },
    {
      id: TT_INACTIVE,
      name: "Hidden",
      priceCents: 1000,
      capacity: 50,
      status: "INACTIVE" as const,
    },
  ];
  const issued = opts.issuedByType ?? {};
  const repos = {
    events: {
      getById: vi.fn(async () =>
        opts.event === null
          ? null
          : {
              id: EVENT_ID,
              orgId:
                opts.event?.orgId === undefined ? ORG_ID : opts.event.orgId,
              status: opts.event?.status ?? "PUBLISHED",
              currency: opts.event?.currency ?? "usd",
            },
      ),
      listTicketTypes: vi.fn(async () =>
        types.map((tt) => makeStubTicketTypeSummary(tt)),
      ),
    },
    authz: {
      getOrgMembership: vi.fn(async () =>
        opts.membership === undefined
          ? { orgId: ORG_ID, humanId: ACTOR, role: "SCANNER" as const }
          : opts.membership,
      ),
    },
    tickets: {
      countIssuedForTicketType: vi.fn(async (id: string) => issued[id] ?? 0),
      // The listing now shares the pre-charge gate's basis
      // (capacity - issued - held) so the screen and the gate cannot disagree
      // about the same tier. `held` stays 0 here; the held cases live in the
      // capacity suites.
      countCapacityUsageForTicketTypes: vi.fn(
        async ({ ticketTypeIds }: { ticketTypeIds: string[] }) =>
          ticketTypeIds.map((ticketTypeId) => ({
            ticketTypeId,
            issued: issued[ticketTypeId] ?? 0,
            held: 0,
          })),
      ),
    },
  } as unknown as Repos;
  return { repos };
}

describe("listSellableItems", () => {
  it("returns active ticket types at the same price online checkout charges (FR-012)", async () => {
    const { repos } = makeDeps({});
    const result = await listSellableItems(
      { repos, authz: denyingAuthz, clock: STUB_CLOCK },
      { actorHumanId: ACTOR, eventId: EVENT_ID },
    );

    expect(result.eventId).toBe(EVENT_ID);
    expect(result.currency).toBe("usd");
    expect(result.ticketTypes).toHaveLength(2); // INACTIVE filtered out

    const ga = result.ticketTypes.find((t) => t.ticketTypeId === TT_GA)!;
    expect(ga.unitPriceCents).toBe(2500); // the event-page price
    expect(ga.capacityRemaining).toBe(100);

    const vip = result.ticketTypes.find((t) => t.ticketTypeId === TT_VIP)!;
    expect(vip.unitPriceCents).toBe(5000);
  });

  it("subtracts issued tickets from capacity", async () => {
    const { repos } = makeDeps({ issuedByType: { [TT_GA]: 25, [TT_VIP]: 10 } });
    const result = await listSellableItems(
      { repos, authz: denyingAuthz, clock: STUB_CLOCK },
      { actorHumanId: ACTOR, eventId: EVENT_ID },
    );

    const ga = result.ticketTypes.find((t) => t.ticketTypeId === TT_GA)!;
    expect(ga.capacityRemaining).toBe(75);

    // VIP sold out → filtered out entirely
    expect(
      result.ticketTypes.find((t) => t.ticketTypeId === TT_VIP),
    ).toBeUndefined();
  });

  it("hides INACTIVE and ARCHIVED ticket types", async () => {
    const { repos } = makeDeps({
      ticketTypes: [
        {
          id: TT_INACTIVE,
          name: "Off",
          priceCents: 1000,
          capacity: 50,
          status: "INACTIVE",
        },
      ],
    });
    const result = await listSellableItems(
      { repos, authz: denyingAuthz, clock: STUB_CLOCK },
      { actorHumanId: ACTOR, eventId: EVENT_ID },
    );
    expect(result.ticketTypes).toHaveLength(0);
  });

  it("throws not_found for missing event", async () => {
    const { repos } = makeDeps({ event: null });
    await expect(
      listSellableItems(
        { repos, authz: denyingAuthz, clock: STUB_CLOCK },
        { actorHumanId: ACTOR, eventId: EVENT_ID },
      ),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("throws forbidden for personal events (no orgId)", async () => {
    const { repos } = makeDeps({ event: { orgId: null } });
    await expect(
      listSellableItems(
        { repos, authz: denyingAuthz, clock: STUB_CLOCK },
        { actorHumanId: ACTOR, eventId: EVENT_ID },
      ),
    ).rejects.toMatchObject({ code: "EVENT_NOT_ORG_OWNED" });
  });

  it("throws forbidden when actor lacks scanner role on the org", async () => {
    const { repos } = makeDeps({ membership: null });
    await expect(
      listSellableItems(
        { repos, authz: denyingAuthz, clock: STUB_CLOCK },
        { actorHumanId: ACTOR, eventId: EVENT_ID },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it.each(["DRAFT", "CANCELLED"])(
    "lists nothing for a %s event: the door sells published events only (owner ruling 2026-10-07)",
    async (status) => {
      const { repos } = makeDeps({ event: { status } });
      const result = await listSellableItems(
        { repos, authz: denyingAuthz, clock: STUB_CLOCK },
        { actorHumanId: ACTOR, eventId: EVENT_ID },
      );

      expect(result).toMatchObject({ eventId: EVENT_ID, ticketTypes: [] });
      // Nothing about the tiers is read for an event the door won't sell.
      expect(repos.events.listTicketTypes).not.toHaveBeenCalled();
    },
  );

  it("still checks the role first: an outsider gets INSUFFICIENT_ROLE, not an empty list", async () => {
    const { repos } = makeDeps({ event: { status: "DRAFT" }, membership: null });
    await expect(
      listSellableItems(
        { repos, authz: denyingAuthz, clock: STUB_CLOCK },
        { actorHumanId: ACTOR, eventId: EVENT_ID },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });
});
