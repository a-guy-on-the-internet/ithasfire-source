import { describe, it, expect, vi, type Mock } from "vitest";

import type { AuthZPort } from "@th/ports/authz";
import type { Repos } from "@th/ports/repos";
import type { ClaimRecord } from "@th/types/repos/claims";

import {
  listClaims,
  listClaimsOutputSchema,
  listMyClaims,
  listMyClaimsOutputSchema,
} from "../list-claims";
import { CLAIM_DESK_ROLES } from "../claim-desk-staff";
import { claimRecordSchema } from "../get-claim";

// ── Constants ──────────────────────────────────────────────────────────────

const EVENT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ORG_ID = "00000000-0000-4000-8000-00000000c0de";
const CLAIMANT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RESPONDENT_ID = "aa111111-aa11-4a11-8a11-aa1111111111";
const STAFF_ID = "5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a";
const STRANGER_ID = "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1";
const NOW = new Date("2026-03-10T12:00:00Z");

// ── Helpers ────────────────────────────────────────────────────────────────

function makeClaim(overrides: Partial<ClaimRecord> = {}): ClaimRecord {
  return {
    id: crypto.randomUUID(),
    orderId: "order-uuid",
    orderItemId: "item-uuid",
    eventId: EVENT_ID,
    claimantId: CLAIMANT_ID,
    respondentId: RESPONDENT_ID,
    kind: "ticket_invalid",
    status: "open",
    evidence: {},
    deadline: new Date("2026-03-15T12:00:00Z"),
    resolvedAt: null,
    resolvedById: null,
    resolutionNote: null,
    resolution: null,
    sellerEvidence: null,
    sellerRespondedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makePageResult(items: ClaimRecord[], total?: number) {
  return {
    items,
    pageInfo: {
      total: total ?? items.length,
      limit: 25,
      offset: 0,
      hasMore: false,
    },
  };
}

type Fn = Mock<any[], any>;

function makeDeps(opts?: {
  listByEvent?: Fn;
  listByClaimant?: Fn;
  listByRespondent?: Fn;
  listAll?: Fn;
  /** Staff probe answer. Defaults to STAFF (so the routing tests stay focused). */
  staff?: boolean;
  /** Event row for the `eventId` branch owner check. Defaults to an org-owned event. */
  event?: { orgId: string | null; humanId: string | null } | null;
  /** Org membership row returned for the actor. Defaults to an ADMIN membership. */
  membership?: { role: string } | null;
  /** Order ids the refund lookup reports as REFUNDED. */
  refunded?: string[];
}) {
  const claims: ClaimRecord[] = [makeClaim()];
  const defaultResult = makePageResult(claims);

  const hasStaffRole = vi.fn(async () => ({ allowed: opts?.staff ?? true }));
  const getOrgMembership = vi.fn(async () =>
    opts?.membership === undefined
      ? { role: "ADMIN", orgId: ORG_ID, humanId: STRANGER_ID }
      : opts.membership,
  );
  const getEventById = vi.fn(async () =>
    opts?.event === undefined ? { id: EVENT_ID, orgId: ORG_ID, humanId: null } : opts.event,
  );

  const repos = {
    claims: {
      listByEvent: opts?.listByEvent ?? vi.fn(async () => defaultResult),
      listByClaimant: opts?.listByClaimant ?? vi.fn(async () => defaultResult),
      listByRespondent:
        opts?.listByRespondent ?? vi.fn(async () => defaultResult),
      listAll: opts?.listAll ?? vi.fn(async () => defaultResult),
      refundedOrderIds: vi.fn(
        async (ids: string[]) =>
          new Set(ids.filter((id) => (opts?.refunded ?? []).includes(id))),
      ),
    },
    events: { getById: getEventById },
    authz: { getOrgMembership },
  };

  return {
    deps: {
      repos: repos as unknown as Repos,
      authz: { hasStaffRole } as unknown as Pick<AuthZPort, "hasStaffRole">,
    },
    mocks: { hasStaffRole, getOrgMembership, getEventById, repos },
  };
}

function allListMethods(mocks: ReturnType<typeof makeDeps>["mocks"]): Fn[] {
  return Object.values(mocks.repos.claims) as Fn[];
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("listClaims — routing (staff actor)", () => {
  it("routes to listByEvent when eventId is provided", async () => {
    const listByEvent = vi.fn(async () => makePageResult([makeClaim()]));
    const { deps } = makeDeps({ listByEvent });

    const result = await listClaims(deps, {
      actorHumanId: STAFF_ID,
      eventId: EVENT_ID,
    });

    expect(listByEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: EVENT_ID }),
    );
    expect(result.items).toHaveLength(1);
  });

  it("routes to listByRespondent when respondentId is provided (no eventId)", async () => {
    const listByRespondent = vi.fn(async () => makePageResult([makeClaim()]));
    const { deps } = makeDeps({ listByRespondent });

    const result = await listClaims(deps, {
      actorHumanId: STAFF_ID,
      respondentId: RESPONDENT_ID,
    });

    expect(listByRespondent).toHaveBeenCalledWith(
      RESPONDENT_ID,
      expect.objectContaining({ limit: 25, offset: 0 }),
    );
    expect(result.items).toHaveLength(1);
  });

  it("routes to listByClaimant when claimantId is provided (no eventId or respondentId)", async () => {
    const listByClaimant = vi.fn(async () => makePageResult([makeClaim()]));
    const { deps } = makeDeps({ listByClaimant });

    const result = await listClaims(deps, {
      actorHumanId: STAFF_ID,
      claimantId: CLAIMANT_ID,
    });

    expect(listByClaimant).toHaveBeenCalledWith(
      CLAIMANT_ID,
      expect.objectContaining({}),
    );
    expect(result.items).toHaveLength(1);
  });

  it("routes to listAll when no filter IDs are provided", async () => {
    const listAll = vi.fn(async () => makePageResult([makeClaim()]));
    const { deps } = makeDeps({ listAll });

    const result = await listClaims(deps, { actorHumanId: STAFF_ID });

    expect(listAll).toHaveBeenCalled();
    expect(result.items).toHaveLength(1);
  });

  it("serializes claim dates to ISO strings", async () => {
    const claim = makeClaim({
      deadline: new Date("2026-03-15T12:00:00Z"),
      resolvedAt: new Date("2026-03-14T10:00:00Z"),
      sellerRespondedAt: new Date("2026-03-12T08:00:00Z"),
    });
    const listAll = vi.fn(async () => makePageResult([claim]));
    const { deps } = makeDeps({ listAll });

    const result = await listClaims(deps, { actorHumanId: STAFF_ID });

    const item = result.items[0]!;
    expect(item.deadline).toBe("2026-03-15T12:00:00.000Z");
    expect(item.resolvedAt).toBe("2026-03-14T10:00:00.000Z");
    expect(item.sellerRespondedAt).toBe("2026-03-12T08:00:00.000Z");
    expect(item.createdAt).toBe("2026-03-10T12:00:00.000Z");
  });

  it("carries the buyer's description, the seller's reply and when they replied", async () => {
    const listAll = vi.fn(async () =>
      makePageResult([
        makeClaim({
          evidence: { description: "Denied at the door" },
          sellerEvidence: { reply: "Sold it in good faith" },
          sellerRespondedAt: new Date("2026-03-12T08:00:00Z"),
        }),
        // A row written before v1 typed evidence: no throw, null text.
        makeClaim({ evidence: { photos: ["u"] }, sellerEvidence: {} }),
      ]),
    );
    const { deps } = makeDeps({ listAll });

    const result = await listClaims(deps, { actorHumanId: STAFF_ID });

    expect(result.items[0]).toMatchObject({
      evidenceText: "Denied at the door",
      sellerReplyText: "Sold it in good faith",
      sellerRespondedAt: "2026-03-12T08:00:00.000Z",
    });
    expect(result.items[1]).toMatchObject({
      evidenceText: null,
      sellerReplyText: null,
      sellerRespondedAt: null,
    });
    // The output schema (what tRPC validates against) accepts both shapes.
    expect(
      claimRecordSchema
        .pick({ evidenceText: true, sellerReplyText: true, sellerRespondedAt: true })
        .array()
        .safeParse(result.items).success,
    ).toBe(true);
  });

  it("passes status filter through to the repo", async () => {
    const listAll = vi.fn(async () => makePageResult([]));
    const { deps } = makeDeps({ listAll });

    await listClaims(deps, {
      actorHumanId: STAFF_ID,
      status: ["open", "under_review"],
    });

    expect(listAll).toHaveBeenCalledWith(
      expect.objectContaining({ status: ["open", "under_review"] }),
    );
  });

  it("passes limit and offset to the repo", async () => {
    const listAll = vi.fn(async () => makePageResult([]));
    const { deps } = makeDeps({ listAll });

    await listClaims(deps, { actorHumanId: STAFF_ID, limit: 10, offset: 20 });

    expect(listAll).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 10, offset: 20 }),
    );
  });

  it("returns total from pageInfo", async () => {
    const listAll = vi.fn(async () => makePageResult([makeClaim()], 100));
    const { deps } = makeDeps({ listAll });

    const result = await listClaims(deps, { actorHumanId: STAFF_ID });

    expect(result.total).toBe(100);
  });

  it("eventId takes priority over respondentId and claimantId", async () => {
    const listByEvent = vi.fn(async () => makePageResult([]));
    const listByRespondent = vi.fn(async () => makePageResult([]));
    const { deps } = makeDeps({ listByEvent, listByRespondent });

    await listClaims(deps, {
      actorHumanId: STAFF_ID,
      eventId: EVENT_ID,
      respondentId: RESPONDENT_ID,
      claimantId: CLAIMANT_ID,
    });

    expect(listByEvent).toHaveBeenCalled();
    expect(listByRespondent).not.toHaveBeenCalled();
  });
});

describe("listClaims — authorization", () => {
  it("rejects input without an actorHumanId (the gate cannot be bypassed by omission)", async () => {
    const { deps, mocks } = makeDeps();

    await expect(listClaims(deps, {})).rejects.toMatchObject({
      code: "invalid_input",
    });
    for (const fn of allListMethods(mocks)) expect(fn).not.toHaveBeenCalled();
  });

  it("platform-wide list (no filter): a non-staff actor gets STAFF_ONLY and no list method is ever called", async () => {
    const { deps, mocks } = makeDeps({ staff: false });

    await expect(
      listClaims(deps, { actorHumanId: STRANGER_ID }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });

    expect(mocks.hasStaffRole).toHaveBeenCalledWith({
      actorHumanId: STRANGER_ID,
      requiredRoles: [...CLAIM_DESK_ROLES],
    });
    for (const fn of allListMethods(mocks)) expect(fn).not.toHaveBeenCalled();
  });

  it("platform-wide list (no filter): a staff actor gets the list", async () => {
    const listAll = vi.fn(async () => makePageResult([makeClaim()], 7));
    const { deps, mocks } = makeDeps({ listAll, staff: true });

    const result = await listClaims(deps, { actorHumanId: STAFF_ID });

    expect(mocks.hasStaffRole).toHaveBeenCalledWith({
      actorHumanId: STAFF_ID,
      requiredRoles: [...CLAIM_DESK_ROLES],
    });
    expect(result.total).toBe(7);
    expect(result.items).toHaveLength(1);
  });

  it("respondentId filter: staff only, even for the seller's own id (sellers use listMyClaims)", async () => {
    // This path returns the FULL record (buyer identity, raw evidence); the
    // seller's own list is listMyClaims' respondent view.
    const listByRespondent = vi.fn(async () => makePageResult([makeClaim()]));
    const { deps } = makeDeps({ listByRespondent, staff: false });

    await expect(
      listClaims(deps, {
        actorHumanId: RESPONDENT_ID,
        respondentId: RESPONDENT_ID,
      }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
    expect(listByRespondent).not.toHaveBeenCalled();
  });

  it("respondentId filter: a non-staff actor cannot list SOMEONE ELSE's claims", async () => {
    const { deps, mocks } = makeDeps({ staff: false });

    await expect(
      listClaims(deps, {
        actorHumanId: STRANGER_ID,
        respondentId: RESPONDENT_ID,
      }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
    for (const fn of allListMethods(mocks)) expect(fn).not.toHaveBeenCalled();
  });

  it("claimantId filter: the claimant may list their own claims without being staff — in the claimant view", async () => {
    const listByClaimant = vi.fn(async () =>
      makePageResult([
        makeClaim({
          orderItemId: "item-uuid",
          resolvedById: STAFF_ID,
          evidence: { description: "Denied at the door" },
          sellerEvidence: { reply: "Sold in good faith" },
        }),
      ]),
    );
    const { deps } = makeDeps({ listByClaimant, staff: false });

    const result = await listClaims(deps, {
      actorHumanId: CLAIMANT_ID,
      claimantId: CLAIMANT_ID,
    });

    expect(result.items).toHaveLength(1);
    const item = result.items[0]!;
    expect(Object.keys(item).sort()).toEqual(
      [
        "view",
        "id",
        "eventId",
        "kind",
        "status",
        "deadline",
        "resolvedAt",
        "resolutionNote",
        "resolution",
        "sellerRespondedAt",
        "createdAt",
        "updatedAt",
        "evidenceText",
        "sellerReplyText",
        "refundConfirmed",
        "orderId",
        "orderItemId",
      ].sort(),
    );
    expect(item).toMatchObject({
      view: "claimant",
      orderId: "order-uuid",
      orderItemId: "item-uuid",
      evidenceText: "Denied at the door",
      sellerReplyText: "Sold in good faith",
    });
    // The seller's and staff member's identity and raw JSON never ride.
    for (const key of [
      "respondentId",
      "claimantId",
      "resolvedById",
      "evidence",
      "sellerEvidence",
    ]) {
      expect(item).not.toHaveProperty(key);
    }
  });

  it("claimantId filter: a claimant who is claim-desk staff gets the full view", async () => {
    const listByClaimant = vi.fn(async () => makePageResult([makeClaim()]));
    const { deps } = makeDeps({ listByClaimant, staff: true });

    const result = await listClaims(deps, {
      actorHumanId: CLAIMANT_ID,
      claimantId: CLAIMANT_ID,
    });

    expect(result.items[0]).toMatchObject({
      view: "full",
      respondentId: RESPONDENT_ID,
    });
  });

  it("claimantId filter: staff listing a buyer's claims get the full view", async () => {
    const listByClaimant = vi.fn(async () => makePageResult([makeClaim()]));
    const { deps } = makeDeps({ listByClaimant, staff: true });

    const result = await listClaims(deps, {
      actorHumanId: STAFF_ID,
      claimantId: CLAIMANT_ID,
    });

    expect(result.items[0]!.view).toBe("full");
  });

  it("orderId narrows the claimant's own list to that order", async () => {
    const ORDER = "a0000000-0000-4000-8000-00000000000a";
    const listByClaimant = vi.fn(async () => makePageResult([]));
    const { deps } = makeDeps({ listByClaimant, staff: false });

    await listClaims(deps, {
      actorHumanId: CLAIMANT_ID,
      claimantId: CLAIMANT_ID,
      orderId: ORDER,
    });

    expect(listByClaimant).toHaveBeenCalledWith(CLAIMANT_ID, {
      orderId: ORDER,
      limit: 25,
      offset: 0,
    });
  });

  it("orderId with a non-staff actor and SOMEONE ELSE's claimantId is still refused", async () => {
    const { deps, mocks } = makeDeps({ staff: false });

    await expect(
      listClaims(deps, {
        actorHumanId: STRANGER_ID,
        claimantId: CLAIMANT_ID,
        orderId: "a0000000-0000-4000-8000-00000000000a",
      }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
    for (const fn of allListMethods(mocks)) expect(fn).not.toHaveBeenCalled();
  });

  it.each([
    ["alone", {}],
    ["with eventId", { claimantId: CLAIMANT_ID, eventId: EVENT_ID }],
    ["with respondentId", { claimantId: CLAIMANT_ID, respondentId: RESPONDENT_ID }],
  ])("orderId %s is invalid_input before any read", async (_label, extra) => {
    const { deps, mocks } = makeDeps({ staff: true });

    await expect(
      listClaims(deps, {
        actorHumanId: STAFF_ID,
        orderId: "a0000000-0000-4000-8000-00000000000a",
        ...extra,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(mocks.hasStaffRole).not.toHaveBeenCalled();
    for (const fn of allListMethods(mocks)) expect(fn).not.toHaveBeenCalled();
  });

  it("claimantId filter: a non-staff actor cannot list SOMEONE ELSE's claims", async () => {
    const { deps, mocks } = makeDeps({ staff: false });

    await expect(
      listClaims(deps, {
        actorHumanId: STRANGER_ID,
        claimantId: CLAIMANT_ID,
      }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
    for (const fn of allListMethods(mocks)) expect(fn).not.toHaveBeenCalled();
  });

  it("eventId filter: staff may list without an org membership", async () => {
    const listByEvent = vi.fn(async () => makePageResult([makeClaim()]));
    const { deps, mocks } = makeDeps({ listByEvent, staff: true });

    await listClaims(deps, { actorHumanId: STAFF_ID, eventId: EVENT_ID });

    expect(listByEvent).toHaveBeenCalled();
    expect(mocks.getOrgMembership).not.toHaveBeenCalled();
  });

  it("eventId filter: a non-staff org member with a finance role may list the org's event claims", async () => {
    const listByEvent = vi.fn(async () => makePageResult([makeClaim()]));
    const { deps, mocks } = makeDeps({
      listByEvent,
      staff: false,
      membership: { role: "FINANCE" },
    });

    const result = await listClaims(deps, {
      actorHumanId: STRANGER_ID,
      eventId: EVENT_ID,
    });

    expect(mocks.getEventById).toHaveBeenCalledWith(EVENT_ID);
    expect(mocks.getOrgMembership).toHaveBeenCalledWith({
      orgId: ORG_ID,
      humanId: STRANGER_ID,
    });
    expect(result.items).toHaveLength(1);
  });

  it("eventId filter: a non-staff non-member is refused before the list method is called", async () => {
    const { deps, mocks } = makeDeps({ staff: false, membership: null });

    await expect(
      listClaims(deps, { actorHumanId: STRANGER_ID, eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    for (const fn of allListMethods(mocks)) expect(fn).not.toHaveBeenCalled();
  });

  it("eventId filter: an org EDITOR is refused — claims are money-dispute data, not the door list", async () => {
    const { deps, mocks } = makeDeps({
      staff: false,
      membership: { role: "EDITOR" },
    });
    await expect(
      listClaims(deps, { actorHumanId: STRANGER_ID, eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    for (const fn of allListMethods(mocks)) expect(fn).not.toHaveBeenCalled();
  });

  it("eventId filter: an org member with a non-finance role is refused", async () => {
    const { deps, mocks } = makeDeps({
      staff: false,
      membership: { role: "SCANNER" },
    });

    await expect(
      listClaims(deps, { actorHumanId: STRANGER_ID, eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    for (const fn of allListMethods(mocks)) expect(fn).not.toHaveBeenCalled();
  });

  it("eventId filter: a human-owned event is readable by that human", async () => {
    const listByEvent = vi.fn(async () => makePageResult([makeClaim()]));
    const { deps, mocks } = makeDeps({
      listByEvent,
      staff: false,
      event: { orgId: null, humanId: STRANGER_ID },
    });

    const result = await listClaims(deps, {
      actorHumanId: STRANGER_ID,
      eventId: EVENT_ID,
    });

    expect(result.items).toHaveLength(1);
    expect(mocks.getOrgMembership).not.toHaveBeenCalled();
  });

  it("eventId filter: a human-owned event is NOT readable by another non-staff human", async () => {
    const { deps, mocks } = makeDeps({
      staff: false,
      event: { orgId: null, humanId: CLAIMANT_ID },
    });

    await expect(
      listClaims(deps, { actorHumanId: STRANGER_ID, eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    for (const fn of allListMethods(mocks)) expect(fn).not.toHaveBeenCalled();
  });

  it("eventId filter: an unknown event is EVENT_NOT_FOUND for a non-staff actor", async () => {
    const { deps, mocks } = makeDeps({ staff: false, event: null });

    await expect(
      listClaims(deps, { actorHumanId: STRANGER_ID, eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
    for (const fn of allListMethods(mocks)) expect(fn).not.toHaveBeenCalled();
  });
});

// ── refundConfirmed ────────────────────────────────────────────────────────

describe("listClaims — refundConfirmed", () => {
  const A = "a0000000-0000-4000-8000-00000000000a";
  const B = "b0000000-0000-4000-8000-00000000000b";
  const C = "c0000000-0000-4000-8000-00000000000c";

  it("is true only for an APPROVED claim whose order is REFUNDED, from ONE batched lookup", async () => {
    const listAll = vi.fn(async () =>
      makePageResult([
        makeClaim({ orderId: A, status: "approved", resolution: "full_refund" }),
        // Approved, refund not landed (failed / pending).
        makeClaim({ orderId: B, status: "approved", resolution: "full_refund" }),
        // Not approved: false even though its order is refunded.
        makeClaim({ orderId: C, status: "denied", resolution: "denied" }),
      ]),
    );
    const { deps, mocks } = makeDeps({ listAll, refunded: [A, C] });

    const result = await listClaims(deps, { actorHumanId: STAFF_ID });

    expect(result.items.map((i) => i.refundConfirmed)).toEqual([
      true,
      false,
      false,
    ]);
    const lookup = mocks.repos.claims.refundedOrderIds;
    expect(lookup).toHaveBeenCalledTimes(1);
    // Only approved claims' orders are looked up.
    expect(lookup).toHaveBeenCalledWith([A, B]);
  });

  it("makes no lookup when nothing on the page is approved", async () => {
    const { deps, mocks } = makeDeps({ staff: true });

    const result = await listClaims(deps, { actorHumanId: STAFF_ID });

    expect(result.items[0]!.refundConfirmed).toBe(false);
    expect(mocks.repos.claims.refundedOrderIds).not.toHaveBeenCalled();
  });
});

// ── listMyClaims (claims.listMy): the seller's respondent view ───────────

describe("listMyClaims", () => {
  const ORDER = "a0000000-0000-4000-8000-00000000000a";

  it("lists the actor's claims as respondent in the respondent view, no staff probe", async () => {
    const listByRespondent = vi.fn(async () =>
      makePageResult([
        makeClaim({
          orderId: ORDER,
          status: "approved",
          resolution: "full_refund",
          resolvedById: STAFF_ID,
          evidence: { description: "Denied at the door" },
          sellerEvidence: { reply: "Sold in good faith" },
        }),
      ]),
    );
    const { deps, mocks } = makeDeps({
      listByRespondent,
      staff: false,
      refunded: [ORDER],
    });

    const result = await listMyClaims(deps, {
      actorHumanId: RESPONDENT_ID,
      status: ["approved"],
    });

    expect(listByRespondent).toHaveBeenCalledWith(RESPONDENT_ID, {
      status: ["approved"],
      limit: 25,
      offset: 0,
    });
    expect(mocks.hasStaffRole).not.toHaveBeenCalled();
    const item = result.items[0]!;
    expect(Object.keys(item).sort()).toEqual(
      [
        "view",
        "id",
        "eventId",
        "kind",
        "status",
        "deadline",
        "resolvedAt",
        "resolutionNote",
        "resolution",
        "sellerRespondedAt",
        "createdAt",
        "updatedAt",
        "evidenceText",
        "sellerReplyText",
        "refundConfirmed",
      ].sort(),
    );
    expect(item).toMatchObject({
      view: "respondent",
      evidenceText: "Denied at the door",
      sellerReplyText: "Sold in good faith",
      refundConfirmed: true,
    });
    // The buyer's identity, order ids, the staff id and raw JSON never ride.
    for (const key of [
      "claimantId",
      "orderId",
      "orderItemId",
      "respondentId",
      "resolvedById",
      "evidence",
      "sellerEvidence",
    ]) {
      expect(item).not.toHaveProperty(key);
    }
    expect(() => listMyClaimsOutputSchema.parse(result)).not.toThrow();
  });

  it("rejects input without an actorHumanId", async () => {
    const { deps } = makeDeps();
    await expect(listMyClaims(deps, {})).rejects.toMatchObject({
      code: "invalid_input",
    });
  });
});
