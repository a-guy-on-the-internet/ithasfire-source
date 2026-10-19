/**
 * Owner ruling 2026-09-28: a DELEGATE may not give themselves tickets. An
 * edit-role delegate of the event's human owner cannot claim the principal's
 * $0 tier for themselves; VIEWER / FINANCE / SCANNER delegates, strangers and
 * the owner claim exactly as before. `orders.createPending` is a sentinel:
 * reaching it proves the claim was let through, and a refusal proves no
 * write was attempted.
 */
import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import { makeStubEventRecord } from "@th/test-utils/fakes/stub-records";

import { claimFreeTickets } from "../claim-free-tickets";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const PRINCIPAL_ID = "77777777-7777-4777-8777-777777777777";
const ACTIVE_TICKET_TYPE_ID = "33333333-3333-4333-8333-333333333333";
const HIDDEN_TICKET_TYPE_ID = "aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa";
const TERMS_ID = "44444444-4444-4444-8444-444444444444";
const FEE_POLICY_ID = "55555555-5555-4555-8555-555555555555";

function makeEvent(): EventRecord {
  return makeStubEventRecord({
    id: EVENT_ID,
    orgId: null,
    humanId: PRINCIPAL_ID,
    status: "PUBLISHED",
    attendanceMode: "TICKETED",
    startsAt: new Date("2026-08-01T19:00:00.000Z"),
    endsAt: new Date("2026-08-01T22:00:00.000Z"),
    gateType: "NONE",
    currency: "usd",
  });
}

/**
 * (Harness copied from claim-free-tickets-sellable-status.test.ts; the event
 * here belongs to PRINCIPAL_ID and the buyer may be their delegate.)
 *
 * Two FREE tiers — one ACTIVE, one DRAFT — and just enough
 * repo surface to reach `orders.createPending`, which is a SENTINEL that
 * throws REACHED_CREATE_PENDING rather than a stub that succeeds. Same shape
 * as the sales-window harness: "the gate let this through" is proved
 * POSITIVELY by arriving at the first write, and a refusal proves the write
 * was never attempted.
 */
function makeHarness(delegateRole: string | null) {
  const createPending = vi.fn(async () => {
    throw Object.assign(new Error("reached create pending"), {
      code: "REACHED_CREATE_PENDING",
    });
  });
  const mintCalled = vi.fn();

  const tier = (id: string, status: "ACTIVE" | "DRAFT") => ({
    id,
    name: id,
    description: null,
    priceCents: 0,
    pricingMode: "FIXED" as const,
    minimumCents: null,
    suggestedCents: null,
    capacity: 100,
    status,
    seatSectionId: null,
    resaleAllowed: false,
    resaleCapCents: null,
    transferAllowed: true,
    scheduledPriceCents: null,
    scheduledPriceAt: null,
    salesOpenAt: null,
    salesCloseAt: null,
  });

  const txRepos = {
    events: {
      getById: vi.fn(async (id: string) =>
        id === EVENT_ID ? makeEvent() : null,
      ),
      listTicketTypes: vi.fn(async () => [
        tier(ACTIVE_TICKET_TYPE_ID, "ACTIVE"),
        tier(HIDDEN_TICKET_TYPE_ID, "DRAFT"),
      ]),
    },
    payoutTerms: {
      listByEvent: vi.fn(async () => [
        {
          id: TERMS_ID,
          kind: "PRIMARY",
          status: "ACTIVE",
          feeMode: "ABSORB",
          feePolicyId: FEE_POLICY_ID,
          payoutSchedule: "WEEK_OF_EVENT",
          isDefault: false,
          settlementCurrency: "usd",
          version: 1,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ]),
      listLines: vi.fn(async () => [
        {
          id: "line-1",
          payoutTermsId: TERMS_ID,
          payeeId: "66666666-6666-4666-8666-666666666666",
          percent: 100,
          floorCents: 0,
          capPercent: null,
          priority: 0,
          rounding: "FLOOR" as const,
        },
      ]),
    },
    feePolicies: {
      getById: vi.fn(async () => ({
        id: FEE_POLICY_ID,
        scopeType: "EVENT",
        scopeId: EVENT_ID,
        status: "ACTIVE",
        version: 1,
        buyerFeePct: 0,
        maxFeeCents: null,
        minFeeCents: 0,
        platformFixedCents: 0,
        feeMode: "ABSORB",
        processsorFeePct: 0.029,
        processorFixedCents: 30,
        payoutPct: 0.9,
        payoutFixedCents: 0,
        monthlyPayoutCents: 0,
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
        effectiveTo: null,
      })),
    },
    eventUnlocks: { isUnlocked: vi.fn(async () => true) },
    memberships: {
      listForMember: vi.fn(async () => []),
      listActiveForHuman: vi.fn(async () => []),
      listActiveBenefitsForHuman: vi.fn(async () => []),
    },
    promos: {
      findActiveByCodes: vi.fn(async () => []),
      findByCodeNormalized: vi.fn(async () => null),
      createHolds: vi.fn(async () => []),
    },
    seats: {
      releaseExpiredHolds: vi.fn(async () => 0),
      releaseSeats: vi.fn(async () => 0),
      findByIdsForUpdate: vi.fn(async () => []),
    },
    orders: { createPending, getById: vi.fn(async () => null) },
    authz: {
      getOrgMembership: vi.fn(async () => null),
      getHumanDelegation: vi.fn(async () =>
        delegateRole
          ? { orgId: PRINCIPAL_ID, humanId: ACTOR_ID, role: delegateRole }
          : null,
      ),
    },
    tickets: {
      createMany: mintCalled,
      lockAndCountCapacityForTicketType: vi.fn(async () => ({
        issued: 0,
        held: 0,
      })),
    },
  } as unknown as TxRepos;

  const repos = {
    tx: async <T>(fn: (tx: TxRepos) => Promise<T>) => fn(txRepos),
  } as unknown as Repos;

  return { repos, createPending, mintCalled, txRepos };
}

const input = (buyerHumanId: string) => ({
  actorHumanId: buyerHumanId,
  buyerHumanId,
  eventId: EVENT_ID,
  clientKey: "client-key-12345",
  termsAccepted: true,
  refundPolicyAccepted: true,
  allowRedirectPaymentMethods: true,
  allowBankDebit: true,
  applyPlatformCredit: true,
  items: [{ ticketTypeId: ACTIVE_TICKET_TYPE_ID, qty: 1 }],
});

const run = (delegateRole: string | null, buyerHumanId = ACTOR_ID) => {
  const harness = makeHarness(delegateRole);
  return {
    harness,
    result: claimFreeTickets(
      {
        repos: harness.repos,
        clock: { now: () => new Date("2026-07-10T17:00:00.000Z") },
      },
      input(buyerHumanId),
      [],
      undefined,
    ),
  };
};

describe("claimFreeTickets — a delegate claiming the principal's $0 tier", () => {
  it.each(["OWNER", "ADMIN", "EDITOR"])(
    "refuses a %s delegate with DELEGATE_SELF_BENEFIT_FORBIDDEN before any write",
    async (role) => {
      const { harness, result } = run(role);
      await expect(result).rejects.toMatchObject({
        code: "DELEGATE_SELF_BENEFIT_FORBIDDEN",
      });
      expect(harness.createPending).not.toHaveBeenCalled();
    },
  );

  it.each([["VIEWER"], ["FINANCE"], ["SCANNER"], [null]])(
    "lets a %s delegate (or a stranger) claim as any attendee would",
    async (role) => {
      const { result } = run(role);
      await expect(result).rejects.toMatchObject({
        code: "REACHED_CREATE_PENDING",
      });
    },
  );

  it("lets the owner claim their own $0 tier, with no delegation lookup", async () => {
    const { harness, result } = run("EDITOR", PRINCIPAL_ID);
    await expect(result).rejects.toMatchObject({
      code: "REACHED_CREATE_PENDING",
    });
    expect(
      (harness.txRepos as unknown as { authz: { getHumanDelegation: unknown } })
        .authz.getHumanDelegation,
    ).not.toHaveBeenCalled();
  });
});

// Owner ruling 2026-10-08: the free-claim order records the buyer's request
// IP as `checkoutIp` (the dispute evidence's customer_purchase_ip), the same
// trusted value it already stamps as `refundPolicyAckIp`.
describe("claimFreeTickets — checkoutIp", () => {
  it("passes the request IP to orders.createPending as checkoutIp", async () => {
    const harness = makeHarness(null);
    await expect(
      claimFreeTickets(
        {
          repos: harness.repos,
          clock: { now: () => new Date("2026-07-10T17:00:00.000Z") },
        },
        { ...input(ACTOR_ID), requestIp: "203.0.113.9" },
        [],
        undefined,
      ),
    ).rejects.toMatchObject({ code: "REACHED_CREATE_PENDING" });
    expect(harness.createPending).toHaveBeenCalledWith(
      expect.objectContaining({
        checkoutIp: "203.0.113.9",
        refundPolicyAckIp: "203.0.113.9",
      }),
    );
  });
});
