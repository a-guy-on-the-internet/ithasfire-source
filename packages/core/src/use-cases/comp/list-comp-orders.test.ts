import { describe, expect, it, vi } from "vitest";

import { listCompOrders } from "./list-comp-orders";
import type { ListCompOrdersDeps } from "./list-comp-orders";
import type { Repos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import type { EventCompOrderItem } from "@th/ports/repos/orders";

// ── Constants ────────────────────────────────────────────────────────────────

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const EVENT_ID = "00000000-0000-4000-8000-000000000002";
const ORG_ID = "00000000-0000-4000-8000-000000000003";
const TICKET_TYPE_ID = "00000000-0000-4000-8000-000000000004";
const GA_TICKET_TYPE_ID = "00000000-0000-4000-8000-000000000014";
const RECIPIENT_A = "00000000-0000-4000-8000-000000000005";
const RECIPIENT_B = "00000000-0000-4000-8000-000000000006";
const RECIPIENT_C = "00000000-0000-4000-8000-000000000007";
const ISSUER_LIVE = "00000000-0000-4000-8000-000000000008";
/** Stamped on an order but no longer resolvable — the column has no FK. */
const ISSUER_GONE = "00000000-0000-4000-8000-000000000009";

const ORDER_REWARD = "00000000-0000-4000-8000-0000000000a1";
const ORDER_UNSTAMPED = "00000000-0000-4000-8000-0000000000a2";
const ORDER_STAMPED = "00000000-0000-4000-8000-0000000000a3";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const baseEvent = {
  id: EVENT_ID,
  orgId: ORG_ID,
  humanId: null,
  title: "Summer Fest",
  status: "PUBLISHED",
  startsAt: new Date("2026-09-01T18:00:00Z"),
} as unknown as EventRecord;

/**
 * Mirrors the real dev database, which is the whole reason this phase is not
 * trivial:
 *
 *   Order source=COMP                              → 4
 *     …of those with compReason IS NOT NULL        → 0
 *   VolunteerRewardGrant with compOrderId NOT NULL → 1
 *
 * i.e. one reward-granted comp and several hand-issued-but-unstamped ones, and
 * ZERO stamped ones. Every row here therefore exercises a null-reason path.
 */
const rewardGrantedRow: EventCompOrderItem = {
  orderId: ORDER_REWARD,
  occurredAt: new Date("2026-08-01T10:00:00.000Z"),
  status: "SUCCEEDED",
  recipientHumanId: RECIPIENT_A,
  recipientName: "Liam Nguyen",
  recipientEmail: "liam.nguyen@example.com",
  ticketTypes: [
    { ticketTypeId: GA_TICKET_TYPE_ID, name: "General Admission", quantity: 1 },
  ],
  quantity: 1,
  // Correct and PERMANENT for a trigger-issued comp — not missing data.
  reason: null,
  issuedByHumanId: null,
  hasVolunteerRewardGrant: true,
};

const handIssuedUnstampedRow: EventCompOrderItem = {
  orderId: ORDER_UNSTAMPED,
  occurredAt: new Date("2026-07-31T09:00:00.000Z"),
  status: "SUCCEEDED",
  recipientHumanId: RECIPIENT_B,
  recipientName: "Olivia Thompson",
  recipientEmail: "olivia.thompson@example.com",
  ticketTypes: [
    { ticketTypeId: TICKET_TYPE_ID, name: "Orchestra", quantity: 2 },
  ],
  quantity: 2,
  // Same two nulls as above, entirely different meaning: hand-issued before
  // the provenance columns existed. The audit log is its record.
  reason: null,
  issuedByHumanId: null,
  hasVolunteerRewardGrant: false,
};

const stampedRow: EventCompOrderItem = {
  orderId: ORDER_STAMPED,
  occurredAt: new Date("2026-07-30T08:00:00.000Z"),
  status: "SUCCEEDED",
  recipientHumanId: RECIPIENT_C,
  recipientName: "Ada Byron",
  recipientEmail: "ada@example.com",
  ticketTypes: [
    { ticketTypeId: GA_TICKET_TYPE_ID, name: "General Admission", quantity: 1 },
  ],
  quantity: 1,
  reason: "VIP guest",
  issuedByHumanId: ISSUER_LIVE,
  hasVolunteerRewardGrant: false,
};

const DEFAULT_ROWS = [rewardGrantedRow, handIssuedUnstampedRow, stampedRow];

// ── Shared mock builder ──────────────────────────────────────────────────────

type Overrides = {
  event?: EventRecord | null;
  role?: string | null;
  rows?: EventCompOrderItem[];
  total?: number;
  humans?: Array<{ id: string; name: string | null }>;
};

function makeDeps(overrides: Overrides = {}): ListCompOrdersDeps {
  const rows = overrides.rows ?? DEFAULT_ROWS;
  const role = overrides.role === undefined ? "ADMIN" : overrides.role;

  return {
    repos: {
      events: {
        getById: vi.fn(async () =>
          overrides.event === undefined ? baseEvent : overrides.event,
        ),
      },
      authz: {
        getHumanDelegation: vi.fn(async () => null),
        getOrgMembership: vi.fn(async () => (role ? { role } : null)),
      },
      orders: {
        listEventCompOrders: vi.fn(async (input: any) => ({
          items: rows,
          total: overrides.total ?? rows.length,
          limit: input.limit,
          offset: input.offset,
        })),
      },
      humans: {
        getByIds: vi.fn(async (ids: string[]) =>
          (overrides.humans ?? [{ id: ISSUER_LIVE, name: "Ann Admin" }]).filter(
            (h) => ids.includes(h.id),
          ),
        ),
      },
    } as unknown as Repos,
  };
}

const validInput = { actorHumanId: ACTOR_ID, eventId: EVENT_ID };

// ═════════════════════════════════════════════════════════════════════════════
// listCompOrders
// ═════════════════════════════════════════════════════════════════════════════

describe("listCompOrders", () => {
  // ── The point of the phase ────────────────────────────────────────────────

  /**
   * `reason == null` is TRUE for both of these rows. If the ledger let the UI
   * infer origin from that, a permanent, correct state (reward-granted) and a
   * legacy gap (hand-issued pre-provenance) would render identically — and,
   * given today's dev data, EVERY row would look like missing data.
   */
  it("distinguishes a reward-granted comp from a hand-issued unstamped one", async () => {
    const deps = makeDeps();
    const result = await listCompOrders(deps, validInput);

    const reward = result.items.find((i) => i.orderId === ORDER_REWARD);
    const unstamped = result.items.find((i) => i.orderId === ORDER_UNSTAMPED);

    expect(reward?.origin).toBe("VOLUNTEER_REWARD");
    expect(unstamped?.origin).toBe("HAND_ISSUED");

    // Both are indistinguishable on the stored provenance columns alone —
    // which is exactly why `origin` cannot be derived from them.
    expect(reward?.reason).toBeNull();
    expect(unstamped?.reason).toBeNull();
    expect(reward?.issuedByHumanId).toBeNull();
    expect(unstamped?.issuedByHumanId).toBeNull();
  });

  /**
   * The legacy tell within HAND_ISSUED is `issuedByHumanId`, NOT `reason`:
   * `issueCompTickets` always stamps the issuer while `reason` is optional, so
   * a stamped issuer with a blank reason is a modern hand-issue and must stay
   * distinguishable from a pre-provenance row.
   */
  it("keeps a modern reasonless hand-issue distinct from a legacy one", async () => {
    const deps = makeDeps({
      rows: [
        { ...stampedRow, reason: null }, // modern: issuer stamped, no reason
        {
          ...handIssuedUnstampedRow, // legacy: no issuer at all
        },
      ],
    });

    const result = await listCompOrders(deps, validInput);

    expect(result.items[0]).toMatchObject({
      origin: "HAND_ISSUED",
      reason: null,
      issuedByHumanId: ISSUER_LIVE,
      issuedByName: "Ann Admin",
    });
    expect(result.items[1]).toMatchObject({
      origin: "HAND_ISSUED",
      reason: null,
      issuedByHumanId: null,
      issuedByName: null,
    });
  });

  it("labels a stamped hand-issued comp HAND_ISSUED and keeps its reason", async () => {
    const deps = makeDeps();
    const result = await listCompOrders(deps, validInput);

    const stamped = result.items.find((i) => i.orderId === ORDER_STAMPED);
    expect(stamped).toMatchObject({
      origin: "HAND_ISSUED",
      reason: "VIP guest",
      issuedByHumanId: ISSUER_LIVE,
      issuedByName: "Ann Admin",
    });
  });

  // ── Ordering / scoping ────────────────────────────────────────────────────

  /**
   * Ordering is the repo's contract (`occurredAt desc`, index-backed). What
   * this pins is that the use case does not reshuffle it on the way out — a
   * `.map` that got replaced by a `Set`/`Map` round-trip would break it
   * silently.
   */
  it("preserves occurredAt-desc ordering from the repo", async () => {
    const deps = makeDeps();
    const result = await listCompOrders(deps, validInput);

    expect(result.items.map((i) => i.orderId)).toEqual([
      ORDER_REWARD,
      ORDER_UNSTAMPED,
      ORDER_STAMPED,
    ]);

    const times = result.items.map((i) => i.occurredAt.getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("scopes the repo read to the requested event and nothing else", async () => {
    const deps = makeDeps();
    await listCompOrders(deps, validInput);

    // No orgId is forwarded: the org came from the EVENT row, so there is no
    // client-supplied scope that could disagree with it.
    expect(deps.repos.orders.listEventCompOrders).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      limit: 25,
      offset: 0,
    });
  });

  it("returns an empty page when the event has no comps", async () => {
    const deps = makeDeps({ rows: [] });
    const result = await listCompOrders(deps, validInput);

    expect(result.items).toEqual([]);
    expect(result.pageInfo.total).toBe(0);
    // No issuer ids on an empty page — don't round-trip to the humans repo.
    expect(deps.repos.humans.getByIds).not.toHaveBeenCalled();
  });

  // ── Issuer hydration degrades, never drops ────────────────────────────────

  /**
   * `compIssuedByHumanId` deliberately carries NO foreign key: it is a
   * point-in-time stamp that must outlive the issuer leaving the org or being
   * deleted. So the id can dangle, and the ledger has to keep the comp.
   */
  it("keeps a comp whose issuer no longer resolves, with a null display name", async () => {
    const deps = makeDeps({
      rows: [{ ...stampedRow, issuedByHumanId: ISSUER_GONE }],
      humans: [], // the issuer is gone
    });

    const result = await listCompOrders(deps, validInput);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      orderId: ORDER_STAMPED,
      issuedByHumanId: ISSUER_GONE,
      issuedByName: null,
      // The reason survives even though the issuer does not.
      reason: "VIP guest",
    });
    expect(result.pageInfo.total).toBe(1);
  });

  /**
   * The other way `issuedByName` goes null: the human exists but is nameless.
   * Documented as a deliberate collapse — `issuedByHumanId` stays non-null in
   * both, so a caller that needs them apart can still look the id up.
   */
  it("returns a null name for an issuer who exists but has none", async () => {
    const deps = makeDeps({
      rows: [stampedRow],
      humans: [{ id: ISSUER_LIVE, name: null }],
    });

    const result = await listCompOrders(deps, validInput);

    expect(result.items[0]).toMatchObject({
      issuedByHumanId: ISSUER_LIVE,
      issuedByName: null,
    });
  });

  it("asks for each issuer id once, skipping the null ones", async () => {
    const deps = makeDeps({
      rows: [
        stampedRow,
        { ...stampedRow, orderId: ORDER_UNSTAMPED },
        rewardGrantedRow,
      ],
    });

    await listCompOrders(deps, validInput);

    expect(deps.repos.humans.getByIds).toHaveBeenCalledWith([ISSUER_LIVE]);
  });

  it("never labels a reward comp with an issuer name", async () => {
    const deps = makeDeps({ rows: [rewardGrantedRow] });
    const result = await listCompOrders(deps, validInput);

    expect(result.items[0]?.issuedByName).toBeNull();
    expect(result.items[0]?.origin).toBe("VOLUNTEER_REWARD");
  });

  // ── Voided comps ──────────────────────────────────────────────────────────

  /**
   * A revoked volunteer reward flips its comp to CANCELLED (`cancelCompOrder`).
   * Hiding it would erase the fact that a comp was issued at all.
   */
  it("returns CANCELLED comps with their status intact", async () => {
    const deps = makeDeps({
      rows: [{ ...rewardGrantedRow, status: "CANCELLED" }],
    });

    const result = await listCompOrders(deps, validInput);
    expect(result.items[0]?.status).toBe("CANCELLED");
  });

  // ── Authorization ─────────────────────────────────────────────────────────

  it("rejects a VIEWER — below the edit-or-finance read gate", async () => {
    const deps = makeDeps({ role: "VIEWER" });

    await expect(listCompOrders(deps, validInput)).rejects.toMatchObject({
      code: "INSUFFICIENT_ROLE",
    });
    expect(deps.repos.orders.listEventCompOrders).not.toHaveBeenCalled();
  });

  it("rejects a SCANNER — scanning is not running or reconciling the event", async () => {
    const deps = makeDeps({ role: "SCANNER" });

    await expect(listCompOrders(deps, validInput)).rejects.toMatchObject({
      code: "INSUFFICIENT_ROLE",
    });
  });

  it("rejects a non-member", async () => {
    const deps = makeDeps({ role: null });

    await expect(listCompOrders(deps, validInput)).rejects.toMatchObject({
      code: "INSUFFICIENT_ROLE",
    });
  });

  /**
   * Reading is deliberately WIDER than issuing (`issueCompTickets` is
   * OWNER/ADMIN). EDITOR runs the door; FINANCE reconciles the $0s.
   */
  it.each(["OWNER", "ADMIN", "EDITOR", "FINANCE"])(
    "allows %s to read the ledger",
    async (role) => {
      const deps = makeDeps({ role });
      const result = await listCompOrders(deps, validInput);
      expect(result.items).toHaveLength(3);
    },
  );

  it("rejects when the event does not exist", async () => {
    const deps = makeDeps({ event: null });

    await expect(listCompOrders(deps, validInput)).rejects.toMatchObject({
      code: "EVENT_NOT_FOUND",
    });
  });

  it("allows the owner of a personal (org-less) event", async () => {
    const deps = makeDeps({
      event: {
        ...baseEvent,
        orgId: null,
        humanId: ACTOR_ID,
      } as unknown as EventRecord,
      role: null,
    });

    const result = await listCompOrders(deps, validInput);
    expect(result.items).toHaveLength(3);
  });

  it("rejects a non-owner on a personal event", async () => {
    const deps = makeDeps({
      event: {
        ...baseEvent,
        orgId: null,
        humanId: "00000000-0000-4000-8000-0000000000ff",
      } as unknown as EventRecord,
      role: null,
    });

    await expect(listCompOrders(deps, validInput)).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
    });
  });

  // ── COMMUNITY listings (owner ruling 2026-10-07: no comps) ────────────────

  describe("a COMMUNITY listing", () => {
    it("is refused with EVENT_NOT_TICKETED, and nothing is read", async () => {
      // Ownerless by DB constraint: orgId AND humanId null.
      const deps = makeDeps({
        event: {
          ...baseEvent,
          orgId: null,
          humanId: null,
          stewardship: "COMMUNITY",
        } as unknown as EventRecord,
        role: null,
      });

      await expect(listCompOrders(deps, validInput)).rejects.toMatchObject({
        code: "EVENT_NOT_TICKETED",
      });
      expect(deps.repos.orders.listEventCompOrders).not.toHaveBeenCalled();
    });

    it("is refused by stewardship BEFORE the role check, even for a caller the role check admits", async () => {
      // Not a shape the DB allows (COMMUNITY rows carry no orgId); it pins
      // that the refusal is the stewardship guard, not the owner arms
      // refusing an ownerless row by accident. An org OWNER would pass the
      // role check below.
      const deps = makeDeps({
        event: {
          ...baseEvent,
          stewardship: "COMMUNITY",
        } as unknown as EventRecord,
        role: "OWNER",
      });

      await expect(listCompOrders(deps, validInput)).rejects.toMatchObject({
        code: "EVENT_NOT_TICKETED",
      });
      expect(deps.repos.authz.getOrgMembership).not.toHaveBeenCalled();
      expect(deps.repos.orders.listEventCompOrders).not.toHaveBeenCalled();
    });

    it("an OWNED event is unaffected", async () => {
      const deps = makeDeps({
        event: { ...baseEvent, stewardship: "OWNED" } as unknown as EventRecord,
      });

      const result = await listCompOrders(deps, validInput);
      expect(result.items).toHaveLength(3);
    });
  });

  // ── Pagination ────────────────────────────────────────────────────────────

  it("forwards an explicit page window", async () => {
    const deps = makeDeps();
    await listCompOrders(deps, { ...validInput, limit: 200, offset: 40 });

    expect(deps.repos.orders.listEventCompOrders).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      limit: 200,
      offset: 40,
    });
  });

  /** The list is never unbounded: OFFSET_MAX_LIMIT is the ceiling. */
  it("rejects a limit above the schema cap", async () => {
    const deps = makeDeps();
    await expect(
      listCompOrders(deps, { ...validInput, limit: 5000 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("reports hasNextPage from the repo total, not the page length", async () => {
    const deps = makeDeps({ total: 12 });
    const result = await listCompOrders(deps, { ...validInput, limit: 3 });

    expect(result.pageInfo).toMatchObject({
      total: 12,
      count: 3,
      offset: 0,
      hasNextPage: true,
      nextOffset: 3,
    });
  });

  // ── Input validation ──────────────────────────────────────────────────────

  it("rejects a non-uuid eventId", async () => {
    const deps = makeDeps();
    await expect(
      listCompOrders(deps, { ...validInput, eventId: "nope" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects unknown input keys (strict)", async () => {
    const deps = makeDeps();
    await expect(
      listCompOrders(deps, { ...validInput, orgId: ORG_ID }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  // ── Dependency failures surface, they are not swallowed ───────────────────

  it("surfaces a repo failure as dependency_failed", async () => {
    const deps = makeDeps();
    (deps.repos.orders.listEventCompOrders as any).mockRejectedValueOnce(
      new Error("db down"),
    );

    await expect(listCompOrders(deps, validInput)).rejects.toMatchObject({
      code: "dependency_failed",
    });
  });

  it("surfaces an issuer-hydration failure instead of silently blanking names", async () => {
    const deps = makeDeps();
    (deps.repos.humans.getByIds as any).mockRejectedValueOnce(
      new Error("db down"),
    );

    // Deliberate: a failed lookup is NOT the same as "the issuer is gone", and
    // quietly rendering every issuer as unknown would hide an outage.
    await expect(listCompOrders(deps, validInput)).rejects.toMatchObject({
      code: "dependency_failed",
    });
  });
});
