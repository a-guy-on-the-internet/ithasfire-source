import { describe, expect, it, vi } from "vitest";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { Repos } from "@th/ports/repos";

import { createFakePayeeLedgerRepo } from "@th/test-utils/fakes/payee-ledger";

import { recordCashSale } from "./record-cash-sale";
import { SCANNER_TERMS_VERSION } from "@th/types";

const denyingAuthz = {
  hasStaffRole: vi.fn(async () => ({ allowed: false })),
} as unknown as AuthZPort;

const ACTOR = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-0000000000a1";
const EVENT_ID = "00000000-0000-4000-8000-0000000000e1";
const TT_GA = "00000000-0000-4000-8000-0000000000a2";
const TT_VIP = "00000000-0000-4000-8000-0000000000a3";
const PHANTOM_ID = "00000000-0000-4000-8000-0000000000d1";
const ORDER_ID = "00000000-0000-4000-8000-0000000000f1";
const NOW = new Date("2026-04-26T20:00:00Z");
const TERMS_ID = "00000000-0000-4000-8000-0000000000c7";
const POLICY_ID = "00000000-0000-4000-8000-0000000000c8";
const PAYEE_ID = "00000000-0000-4000-8000-0000000000c9";

/**
 * The fee policy these behaviour tests price under: NO platform fee and no
 * tax (the event has no situs and a 0% stamp), so a cart's cash total is its
 * face and each test keeps asserting what it was written for (seats, windows,
 * capacity, idempotency). The money itself — fees, tax, the ledger debit,
 * change, short refusals — is pinned in `__tests__/door-cash-parity.test.ts`.
 */
const ZERO_FEE_POLICY = {
  id: POLICY_ID,
  scopeType: "EVENT",
  scopeId: EVENT_ID,
  status: "ACTIVE",
  version: 1,
  buyerFeePct: 0,
  maxFeeCents: null,
  minFeeCents: 0,
  maxPlatformFeeCents: null,
  platformFixedCents: 0,
  feeMode: "PASS_THROUGH",
  processsorFeePct: 0.029,
  processorFixedCents: 30,
  payoutPct: 0,
  payoutFixedCents: 0,
  monthlyPayoutCents: 0,
  effectiveFrom: new Date("2026-01-01T00:00:00Z"),
  effectiveTo: null,
};

function makeTx(opts: {
  membership?: { role: "SCANNER" } | null;
  ticketTypes?: Array<{
    id: string;
    priceCents: number;
    capacity: number;
    /** FR-005 scheduled price change; both or neither. */
    scheduledPriceCents?: number | null;
    scheduledPriceAt?: Date | null;
    /** FR-014 per-type sales window; independent bounds, null = no bound. */
    salesOpenAt?: Date | null;
    salesCloseAt?: Date | null;
    /** Defaults to FIXED — ADJUSTABLE is "pay what you can". */
    pricingMode?: "FIXED" | "ADJUSTABLE";
    /** ADJUSTABLE floor. */
    minimumCents?: number | null;
    suggestedCents?: number | null;
    /**
     * Port status (the adapter folds the DB's INACTIVE/ARCHIVED to DRAFT).
     * Defaults to ACTIVE — the only sellable status (money audit #14).
     */
    status?: "ACTIVE" | "DRAFT";
  }>;
  ticketsCreated?: Array<{ id: string; code: string; orderItemId: string }>;
  operator?: {
    scannerTermsAckAt: Date | null;
    scannerTermsAckVersion: string | null;
  } | null;
}) {
  const ticketTypes = opts.ticketTypes ?? [
    { id: TT_GA, priceCents: 3000, capacity: 100 },
    { id: TT_VIP, priceCents: 5000, capacity: 50 },
  ];

  const orderItemsByOrder = new Map<string, any[]>();
  const ledger = createFakePayeeLedgerRepo();
  const terms = {
    id: TERMS_ID,
    kind: "PRIMARY",
    status: "ACTIVE",
    feeMode: "PASS_THROUGH",
    feePolicyId: POLICY_ID,
    payoutSchedule: "WEEK_OF_EVENT",
    isDefault: false,
    settlementCurrency: "usd",
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const tx: any = {
    events: {
      lockRows: vi.fn(async () => undefined),
      getById: vi.fn(async (id: string) => ({
        id,
        orgId: ORG_ID,
        humanId: null,
        title: "Cash Night",
        currency: "usd",
        status: "PUBLISHED",
        attendanceMode: "TICKETED",
        startsAt: new Date("2026-04-26T18:00:00Z"),
        endsAt: new Date("2026-04-27T02:00:00Z"),
        // No situs and a 0% stamp: no tax (see ZERO_FEE_POLICY).
        postalCode: null,
        countryCode: null,
        region: null,
        placeId: null,
        savedLocationId: null,
        admissionTaxRateBps: 0,
        taxRateSource: "none",
        instructionalAdmission: false,
        agreementPrimaryId: TERMS_ID,
      })),
      listTicketTypes: vi.fn(async () =>
        ticketTypes.map((tt) => ({
          ...tt,
          name: tt.id,
          pricingMode: tt.pricingMode ?? ("FIXED" as const),
          minimumCents: tt.minimumCents ?? null,
          suggestedCents: tt.suggestedCents ?? null,
          status: tt.status ?? ("ACTIVE" as const),
          seatSectionId: null,
          resaleAllowed: false,
          resaleCapCents: null,
          transferAllowed: true,
          salesOpenAt: tt.salesOpenAt ?? null,
          salesCloseAt: tt.salesCloseAt ?? null,
        })),
      ),
    },
    payoutTerms: {
      listByEvent: vi.fn(async () => [terms]),
      getById: vi.fn(async (id: string) => (id === TERMS_ID ? terms : null)),
      listLines: vi.fn(async () => [
        {
          id: "line-1",
          agreementId: TERMS_ID,
          payeeId: PAYEE_ID,
          percent: 100,
          floorCents: 0,
          capPercent: null,
          priority: 0,
          rounding: "FLOOR",
        },
      ]),
    },
    feePolicies: {
      getById: vi.fn(async (id: string) =>
        id === POLICY_ID ? ZERO_FEE_POLICY : null,
      ),
    },
    feeWaivers: {
      resolveApplicable: vi.fn(async () => []),
      reserve: vi.fn(),
      settle: vi.fn(async () => ({ settledTickets: 0 })),
      release: vi.fn(async () => ({ releasedTickets: 0 })),
    },
    promos: {
      findActiveByCodes: vi.fn(async () => []),
      findActiveByIds: vi.fn(async () => []),
      getRedemptionStats: vi.fn(async () => ({
        totalRedemptions: 0,
        redemptionsForHuman: 0,
      })),
      createHolds: vi.fn(async () => []),
      confirmHoldsForOrder: vi.fn(async () => []),
    },
    payees: {
      getBySubject: vi.fn(async () => ({ id: PAYEE_ID })),
      upsertForSubject: vi.fn(),
    },
    payeeLedger: ledger.repo,
    audit: { log: vi.fn(async () => undefined) },
    authz: {
      getOrgMembership: vi.fn(async () =>
        opts.membership === undefined
          ? { orgId: ORG_ID, humanId: ACTOR, role: "SCANNER" as const }
          : opts.membership,
      ),
    },
    humans: {
      create: vi.fn(async () => ({ id: PHANTOM_ID })),
      getById: vi.fn(async () => {
        const operator =
          opts.operator === undefined
            ? {
                scannerTermsAckAt: new Date("2026-04-01T00:00:00Z"),
                scannerTermsAckVersion: SCANNER_TERMS_VERSION,
              }
            : opts.operator;
        return operator ? { id: ACTOR, ...operator } : null;
      }),
    },
    orders: {
      createPending: vi.fn(async (input: any) => {
        orderItemsByOrder.set(ORDER_ID, input.items);
        return {
          id: ORDER_ID,
          amountGrossCents: input.amountGrossCents,
          feesPlatformCents: 0,
          currency: input.currency,
        };
      }),
      createTaxLines: vi.fn(async () => {}),
      markSucceeded: vi.fn(async () => {}),
      getById: vi.fn(async (id: string) => {
        const items = orderItemsByOrder.get(id) ?? [];
        return {
          id,
          eventId: EVENT_ID,
          buyerHumanId: PHANTOM_ID,
          status: "SUCCEEDED",
          paymentChannel: "CASH",
          items: items.map((it: any, i: number) => ({
            id: `00000000-0000-4000-8000-00000000c1${i.toString(16).padStart(2, "0")}`,
            ...it,
          })),
        };
      }),
    },
    tickets: {
      countForOrderTicketType: vi.fn(async () => 0),
      countIssuedForTicketType: vi.fn(async () => 0),
      countCapacityConsumingForTicketType: vi.fn(async () => 0),
      // Capacity accounting: empty by default so existing cases are unaffected.
      lockAndCountCapacityForTicketType: vi.fn(async () => ({
        issued: 0,
        held: 0,
      })),
      getByOrderItemId: vi.fn(async () => null),
      create: vi.fn(async (input: any) => {
        const idx = String(tx.tickets.create.mock.calls.length).padStart(
          3,
          "0",
        );
        return {
          id: `00000000-0000-4000-8000-00000000a${idx}`,
          code: `CASH-${idx}`,
          orderItemId: input.orderItemId,
          ticketTypeId: input.ticketTypeId,
          ownerHumanId: input.ownerHumanId,
          eventId: input.eventId,
          orderId: input.orderId,
          status: "VALID",
          issuedAt: input.issuedAt,
        };
      }),
      markScanned: vi.fn(async () => ({ ok: true, scannedAt: NOW })),
      recordScan: vi.fn(async () => {}),
      findBySeatIds: vi.fn(async () => []),
      // Mint reads the unfiltered twin for its @unique pre-flight.
      findBySeatIdsIncludingTerminal: vi.fn(async () => []),
    },
    seats: {
      updateStatuses: vi.fn(async () => {}),
      findByIdsForUpdate: vi.fn(async () => []),
    },
    /** The in-memory ledger behind `payeeLedger` (not a repo method). */
    _ledger: ledger,
  };

  return tx;
}

function makeDeps(
  tx: ReturnType<typeof makeTx>,
  idempState: Map<string, any> = new Map(),
  now: Date = NOW,
) {
  const repos = {
    tx: vi.fn(async (fn: any) => fn(tx)),
    ...tx,
  } as unknown as Repos;

  const idempotency = {
    get: vi.fn(async (key: string) => idempState.get(key) ?? null),
    begin: vi.fn(async (key: string) => {
      if (idempState.has(key)) return false;
      idempState.set(key, "__pending__");
      return true;
    }),
    commit: vi.fn(async (key: string, value: any) => {
      idempState.set(key, value);
    }),
    fail: vi.fn(async (key: string) => {
      idempState.delete(key);
    }),
    run: vi.fn(),
    purgeExpired: async () => 0,
  } as unknown as IdempotencyPort;

  const clock: ClockPort = { now: () => now };

  return { repos, idempotency, clock, idempState };
}

describe("recordCashSale", () => {
  it("creates a SUCCEEDED CASH order, mints + auto-admits tickets, at the event-page price", async () => {
    const tx = makeTx({});
    const { repos, idempotency, clock } = makeDeps(tx);

    const result = await recordCashSale(
      { repos, authz: denyingAuthz, idempotency, clock },
      {
        actorHumanId: ACTOR,
        eventId: EVENT_ID,
        clientKey: "client-key-1",
        items: [{ ticketTypeId: TT_GA, qty: 2 }],
        amountCollectedCents: 6000,
      },
    );

    expect(result.orderId).toBe(ORDER_ID);
    expect(result.ticketCount).toBe(2);
    expect(result.amountCents).toBe(6000);
    expect(result.isComp).toBe(false);
    expect(result.autoAdmitted).toBe(true);

    // Phantom buyer created with POS_WALKUP source
    expect(tx.humans.create).toHaveBeenCalledWith(
      expect.objectContaining({ source: "POS_WALKUP", name: null }),
    );

    // Order created with paymentChannel=CASH and no Stripe PI
    const orderArgs = tx.orders.createPending.mock.calls[0]?.[0] as any;
    expect(orderArgs.paymentChannel).toBe("CASH");
    expect(orderArgs.amountGrossCents).toBe(6000);
    expect(orderArgs.stripePaymentIntentId).toBeUndefined();
    expect(orderArgs.items).toHaveLength(2);
    // The same price online checkout charges (FR-012: no separate door price).
    expect(orderArgs.items[0].unitPriceCents).toBe(3000);

    expect(tx.orders.markSucceeded).toHaveBeenCalledWith(ORDER_ID);

    // Both tickets auto-admitted
    expect(tx.tickets.markScanned).toHaveBeenCalledTimes(2);
    expect(tx.tickets.recordScan).toHaveBeenCalledTimes(2);
    const scanArgs = tx.tickets.recordScan.mock.calls[0]?.[0] as any;
    expect(scanArgs.outcome).toBe("ACCEPTED");
    expect(scanArgs.message).toBe("POS_CASH_AUTO_ADMIT");
    expect(scanArgs.actorHumanId).toBe(ACTOR);
  });

  it("treats $0 as a comp (isComp=true) and emits comp telemetry", async () => {
    const tx = makeTx({});
    const { repos, idempotency, clock } = makeDeps(tx);
    const info = vi.fn();
    const logger = {
      info,
      warn: vi.fn(),
      error: vi.fn(),
      log: vi.fn(),
      child: vi.fn(() => logger),
      withTime: vi.fn(() => logger),
    } as any;

    const result = await recordCashSale(
      { repos, authz: denyingAuthz, idempotency, clock, logger },
      {
        actorHumanId: ACTOR,
        eventId: EVENT_ID,
        clientKey: "client-key-comp",
        items: [{ ticketTypeId: TT_GA, qty: 1 }],
        amountCollectedCents: 0,
      },
    );

    expect(result.isComp).toBe(true);
    expect(result.amountCents).toBe(0);
    expect(info).toHaveBeenCalledWith(
      "pos.cash_sale.comp_recorded",
      expect.any(Object),
    );
  });

  it("does NOT auto-admit when sellWithoutAdmitting=true", async () => {
    const tx = makeTx({});
    const { repos, idempotency, clock } = makeDeps(tx);

    const result = await recordCashSale(
      { repos, authz: denyingAuthz, idempotency, clock },
      {
        actorHumanId: ACTOR,
        eventId: EVENT_ID,
        clientKey: "client-key-noscan",
        items: [{ ticketTypeId: TT_GA, qty: 1 }],
        amountCollectedCents: 3000,
        sellWithoutAdmitting: true,
      },
    );

    expect(result.autoAdmitted).toBe(false);
    expect(tx.tickets.markScanned).not.toHaveBeenCalled();
    expect(tx.tickets.recordScan).not.toHaveBeenCalled();
  });

  it("returns the cached result on idempotent replay (same clientKey)", async () => {
    const tx = makeTx({});
    const { repos, idempotency, clock } = makeDeps(tx);

    const input = {
      actorHumanId: ACTOR,
      eventId: EVENT_ID,
      clientKey: "client-key-replay",
      items: [{ ticketTypeId: TT_GA, qty: 1 }],
      amountCollectedCents: 3000,
    };

    const first = await recordCashSale(
      { repos, authz: denyingAuthz, idempotency, clock },
      input,
    );
    const second = await recordCashSale(
      { repos, authz: denyingAuthz, idempotency, clock },
      input,
    );

    expect(second).toEqual(first);
    // Order create only ran once
    expect(tx.orders.createPending).toHaveBeenCalledTimes(1);
  });

  it("throws not_found when the event does not exist", async () => {
    const tx = makeTx({});
    tx.events.getById = vi.fn(async () => null) as any;
    const { repos, idempotency, clock } = makeDeps(tx);

    await expect(
      recordCashSale(
        { repos, authz: denyingAuthz, idempotency, clock },
        {
          actorHumanId: ACTOR,
          eventId: EVENT_ID,
          clientKey: "client-key-x",
          items: [{ ticketTypeId: TT_GA, qty: 1 }],
          amountCollectedCents: 0,
        },
      ),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("throws forbidden when the actor lacks scanner role", async () => {
    const tx = makeTx({ membership: null });
    const { repos, idempotency, clock } = makeDeps(tx);

    await expect(
      recordCashSale(
        { repos, authz: denyingAuthz, idempotency, clock },
        {
          actorHumanId: ACTOR,
          eventId: EVENT_ID,
          clientKey: "client-key-y",
          items: [{ ticketTypeId: TT_GA, qty: 1 }],
          amountCollectedCents: 0,
        },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("auto-assigns contiguous seats for RESERVED-section ticket types", async () => {
    const SECTION_ID = "00000000-0000-4000-8000-0000000000b1";
    const tx = makeTx({
      ticketTypes: [
        { id: TT_GA, priceCents: 6500, capacity: 100 },
      ],
    });
    // Override the listTicketTypes fake to mark this ticket type seated.
    tx.events.listTicketTypes = vi.fn(async () => [
      {
        id: TT_GA,
        name: "Orchestra",
        priceCents: 6500,
        capacity: 100,
        pricingMode: "FIXED" as const,
        minimumCents: null,
        suggestedCents: null,
        status: "ACTIVE" as const,
        seatSectionId: SECTION_ID,
        resaleAllowed: false,
        resaleCapCents: null,
        transferAllowed: true,
      },
    ]);
    tx.seats.getSectionById = vi.fn(async () => ({
      id: SECTION_ID,
      name: "Orchestra",
      type: "RESERVED" as const,
      capacity: 50,
      layoutSectionId: null,
      placeLayoutId: null,
    }));
    tx.seats.pickContiguousAvailable = vi.fn(async ({ qty }: { qty: number }) =>
      Array.from({ length: qty }, (_, i) => ({
        id: `seat-A${i + 5}`,
        seatSectionId: SECTION_ID,
        eventId: EVENT_ID,
        status: "AVAILABLE" as const,
        label: `A${i + 5}`,
        row: "A",
        number: i + 5,
      })),
    );
    tx.seats.findByIdsForUpdate = vi.fn(
      async ({ seatIds }: { seatIds: string[] }) =>
        seatIds.map((id) => ({
          id,
          seatSectionId: SECTION_ID,
          eventId: EVENT_ID,
          status: "AVAILABLE" as const,
          label: id,
          row: "A",
          number: parseInt(id.replace("seat-A", ""), 10),
        })),
    );

    const { repos, idempotency, clock } = makeDeps(tx);

    const result = await recordCashSale(
      { repos, authz: denyingAuthz, idempotency, clock },
      {
        actorHumanId: ACTOR,
        eventId: EVENT_ID,
        clientKey: "client-key-seated",
        items: [{ ticketTypeId: TT_GA, qty: 3 }],
        amountCollectedCents: 19500,
      },
    );

    expect(result.ticketCount).toBe(3);
    expect(tx.seats.pickContiguousAvailable).toHaveBeenCalledWith({
      seatSectionId: SECTION_ID,
      eventId: EVENT_ID,
      qty: 3,
    });

    const orderArgs = tx.orders.createPending.mock.calls[0]?.[0] as any;
    expect(orderArgs.items).toHaveLength(3);
    // The priced items carry checkout's buyer-total meta now (spec
    // 2026-10-07 FR-003); the seat rides alongside it.
    expect(orderArgs.items[0].meta.seatIds).toEqual(["seat-A5"]);
    expect(orderArgs.items[1].meta.seatIds).toEqual(["seat-A6"]);
    expect(orderArgs.items[2].meta.seatIds).toEqual(["seat-A7"]);
    expect(result.seatLabels).toEqual(["A5", "A6", "A7"]);

    // Seats flipped to SOLD during mint
    expect(tx.seats.updateStatuses).toHaveBeenCalledWith(
      expect.objectContaining({
        seatIds: ["seat-A5", "seat-A6", "seat-A7"],
        status: "SOLD",
      }),
    );
  });

  it("rejects a seated sale with conflict when the section is full", async () => {
    const SECTION_ID = "00000000-0000-4000-8000-0000000000b2";
    const tx = makeTx({});
    tx.events.listTicketTypes = vi.fn(async () => [
      {
        id: TT_GA,
        name: "Orchestra",
        priceCents: 6500,
        capacity: 100,
        pricingMode: "FIXED" as const,
        minimumCents: null,
        suggestedCents: null,
        status: "ACTIVE" as const,
        seatSectionId: SECTION_ID,
        resaleAllowed: false,
        resaleCapCents: null,
        transferAllowed: true,
      },
    ]);
    tx.seats.getSectionById = vi.fn(async () => ({
      id: SECTION_ID,
      name: "Orchestra",
      type: "RESERVED" as const,
      capacity: 0,
      layoutSectionId: null,
      placeLayoutId: null,
    }));
    tx.seats.pickContiguousAvailable = vi.fn(async () => []);

    const { repos, idempotency, clock } = makeDeps(tx);

    await expect(
      recordCashSale(
        { repos, authz: denyingAuthz, idempotency, clock },
        {
          actorHumanId: ACTOR,
          eventId: EVENT_ID,
          clientKey: "client-key-full",
          items: [{ ticketTypeId: TT_GA, qty: 2 }],
          amountCollectedCents: 13000,
        },
      ),
    ).rejects.toMatchObject({ code: "conflict", message: "seat_unavailable" });
  });

  it("rejects unknown ticketTypeId with the typed not-found code", async () => {
    const tx = makeTx({});
    const { repos, idempotency, clock } = makeDeps(tx);

    await expect(
      recordCashSale(
        { repos, authz: denyingAuthz, idempotency, clock },
        {
          actorHumanId: ACTOR,
          eventId: EVENT_ID,
          clientKey: "client-key-z",
          items: [
            { ticketTypeId: "00000000-0000-4000-8000-000000000999", qty: 1 },
          ],
          amountCollectedCents: 0,
        },
      ),
      // Contract change: the capacity guard resolves ticket types before the
      // pricing loop does, so this now surfaces as the typed
      // TICKET_TYPE_NOT_FOUND (NOT_FOUND at the transport boundary) rather than
      // the previous untyped invalid_input (BAD_REQUEST).
    ).rejects.toMatchObject({ code: "TICKET_TYPE_NOT_FOUND" });
  });

  it("rejects before creating an order when the operator has not acknowledged scanner terms", async () => {
    const tx = makeTx({
      operator: { scannerTermsAckAt: null, scannerTermsAckVersion: null },
    });
    const { repos, idempotency, clock } = makeDeps(tx);

    await expect(
      recordCashSale(
        { repos, authz: denyingAuthz, idempotency, clock },
        {
          actorHumanId: ACTOR,
          eventId: EVENT_ID,
          clientKey: "client-key-noack",
          items: [{ ticketTypeId: TT_GA, qty: 1 }],
          amountCollectedCents: 3000,
        },
      ),
    ).rejects.toMatchObject({ code: "SCANNER_TERMS_REQUIRED" });

    expect(tx.orders.createPending).not.toHaveBeenCalled();
  });

  it("rejects when the operator's scanner-terms ack is a stale version", async () => {
    const tx = makeTx({
      operator: {
        scannerTermsAckAt: new Date("2026-01-01T00:00:00Z"),
        scannerTermsAckVersion: "0",
      },
    });
    const { repos, idempotency, clock } = makeDeps(tx);

    await expect(
      recordCashSale(
        { repos, authz: denyingAuthz, idempotency, clock },
        {
          actorHumanId: ACTOR,
          eventId: EVENT_ID,
          clientKey: "client-key-staleack",
          items: [{ ticketTypeId: TT_GA, qty: 1 }],
          amountCollectedCents: 3000,
        },
      ),
    ).rejects.toMatchObject({ code: "SCANNER_TERMS_REQUIRED" });

    expect(tx.orders.createPending).not.toHaveBeenCalled();
  });

  it("refuses to consume a seat a card sale is holding mid-tap", async () => {
    // Cash mints inline, so mintTickets' issued-only check would let this
    // through — the last ticket is held, not issued. Taking it would strand
    // the card buyer's charge.
    const tx = makeTx({
      ticketTypes: [
        { id: TT_GA, priceCents: 3000, capacity: 10 },
      ],
    });
    // 9 issued + 1 held against capacity 10 — nothing is technically sold out,
    // but the last one is spoken for.
    tx.tickets.lockAndCountCapacityForTicketType.mockResolvedValue({
      issued: 9,
      held: 1,
    });
    const { repos, idempotency, clock } = makeDeps(tx);

    await expect(
      recordCashSale(
        { repos, authz: denyingAuthz, idempotency, clock },
        {
          actorHumanId: ACTOR,
          eventId: EVENT_ID,
          clientKey: "client-key-cash-vs-hold",
          items: [{ ticketTypeId: TT_GA, qty: 1 }],
          amountCollectedCents: 3000,
        },
      ),
    ).rejects.toMatchObject({ code: "TICKET_TYPE_TEMPORARILY_HELD" });

    expect(tx.orders.createPending).not.toHaveBeenCalled();
  });

  it("does not stamp a hold — cash mints inside the same transaction", async () => {
    const tx = makeTx({});
    const { repos, idempotency, clock } = makeDeps(tx);

    await recordCashSale(
      { repos, authz: denyingAuthz, idempotency, clock },
      {
        actorHumanId: ACTOR,
        eventId: EVENT_ID,
        clientKey: "client-key-cash-nohold",
        items: [{ ticketTypeId: TT_GA, qty: 1 }],
        amountCollectedCents: 3000,
      },
    );

    const created = tx.orders.createPending.mock.calls[0]![0] as {
      items: Array<{ meta?: Record<string, unknown> }>;
    };
    // A hold on an already-minted order would reserve capacity that the
    // tickets themselves already account for — double-counting the sale.
    for (const item of created.items) {
      expect(item.meta?.holdExpiresAt).toBeUndefined();
    }
  });
});

/**
 * FR-005 at the cash till. The door resolves the SAME price online checkout
 * does, so a scheduled flip moves the till price at the same instant
 * (door-sales-same-price-and-tax spec FR-012: there is no door price).
 */
describe("recordCashSale — scheduled price change (FR-005)", () => {
  const FLIP_AT = new Date("2026-04-26T19:00:00Z");
  const BEFORE = new Date(FLIP_AT.getTime() - 1);
  const AT = new Date(FLIP_AT.getTime());

  async function sell(opts: { now: Date; qty?: number }) {
    const tx = makeTx({
      ticketTypes: [
        {
          id: TT_GA,
          priceCents: 1200,
          capacity: 100,
          scheduledPriceCents: 2000,
          scheduledPriceAt: FLIP_AT,
        },
      ],
    });
    const { repos, idempotency, clock } = makeDeps(tx, new Map(), opts.now);

    const qty = opts.qty ?? 1;
    const result = await recordCashSale(
      { repos, authz: denyingAuthz, idempotency, clock },
      {
        actorHumanId: ACTOR,
        eventId: EVENT_ID,
        clientKey: `sched-${opts.now.toISOString()}`,
        items: [{ ticketTypeId: TT_GA, qty }],
        // Enough for either price: the server prices the sale, the typed
        // amount only works out change (and 0 would be a comp).
        amountCollectedCents: 2000,
      },
    );

    const orderArgs = tx.orders.createPending.mock.calls[0]?.[0] as any;
    return { result, unitPriceCents: orderArgs.items[0].unitPriceCents };
  }

  it("before T → the pre-flip price", async () => {
    const { unitPriceCents } = await sell({ now: BEFORE });
    expect(unitPriceCents).toBe(1200);
  });

  it("at T → the post-flip price, same as online checkout", async () => {
    const { unitPriceCents } = await sell({ now: AT });
    expect(unitPriceCents).toBe(2000);
  });
});

/**
 * FR-014 at the CASH till — the fifth money site, and the one where the
 * per-type window carries the most weight.
 *
 * The POS deliberately has NO event-level sales close: door sales happen after
 * the event starts, so `ensureEventOnSale`'s `now >= endsAt ?? startsAt` rule
 * would refuse every legitimate walk-up. That means a per-type window is the
 * ONLY window gate here, which is exactly what makes "Advance closes 14 days
 * out, Door opens at doors" expressible at the till.
 *
 * Cash mints inline inside the transaction, so a refusal has to happen before
 * any ticket exists — asserted, not assumed.
 */
describe("recordCashSale — sales window (FR-014)", () => {
  const OPENS_AT = new Date("2026-04-26T19:00:00Z");
  const CLOSES_AT = new Date("2026-04-26T23:00:00Z");

  async function sellAt(
    now: Date,
    window: { salesOpenAt?: Date | null; salesCloseAt?: Date | null },
  ) {
    const tx = makeTx({
      ticketTypes: [
        {
          id: TT_GA,
          priceCents: 1500,
          capacity: 100,
          ...window,
        },
      ],
    });
    const { repos, idempotency, clock } = makeDeps(tx, new Map(), now);

    const run = () =>
      recordCashSale(
        { repos, authz: denyingAuthz, idempotency, clock },
        {
          actorHumanId: ACTOR,
          eventId: EVENT_ID,
          // Unique per case (idempotency) and short enough for the 128-char
          // input bound.
          clientKey: `win-${now.getTime()}-${window.salesOpenAt?.getTime() ?? "x"}-${window.salesCloseAt?.getTime() ?? "x"}`,
          items: [{ ticketTypeId: TT_GA, qty: 1 }],
          amountCollectedCents: 1500,
        },
      );

    return { tx, run };
  }

  it("refuses a cash sale BEFORE the tier opens, creating no order and minting nothing", async () => {
    const { tx, run } = await sellAt(new Date(OPENS_AT.getTime() - 1), {
      salesOpenAt: OPENS_AT,
      salesCloseAt: CLOSES_AT,
    });

    await expect(run()).rejects.toMatchObject({
      code: "TICKET_TYPE_NOT_YET_ON_SALE",
    });
    expect(tx.orders.createPending).not.toHaveBeenCalled();
    expect(tx.tickets.create).not.toHaveBeenCalled();
  });

  it("sells at exactly the open instant (INCLUSIVE) — at the resolved price", async () => {
    const { tx, run } = await sellAt(new Date(OPENS_AT.getTime()), {
      salesOpenAt: OPENS_AT,
      salesCloseAt: CLOSES_AT,
    });

    await run();

    const orderArgs = tx.orders.createPending.mock.calls[0]?.[0] as any;
    expect(orderArgs.items[0].unitPriceCents).toBe(1500);
  });

  it("refuses AT the close instant (EXCLUSIVE), creating no order and minting nothing", async () => {
    const { tx, run } = await sellAt(new Date(CLOSES_AT.getTime()), {
      salesOpenAt: OPENS_AT,
      salesCloseAt: CLOSES_AT,
    });

    await expect(run()).rejects.toMatchObject({
      code: "TICKET_TYPE_SALES_ENDED",
    });
    expect(tx.orders.createPending).not.toHaveBeenCalled();
    expect(tx.tickets.create).not.toHaveBeenCalled();
  });

  it("an OPEN bound alone gates the door tier and then never closes it", async () => {
    const early = await sellAt(new Date(OPENS_AT.getTime() - 1), {
      salesOpenAt: OPENS_AT,
    });
    await expect(early.run()).rejects.toMatchObject({
      code: "TICKET_TYPE_NOT_YET_ON_SALE",
    });

    const late = await sellAt(new Date(CLOSES_AT.getTime() + 3_600_000), {
      salesOpenAt: OPENS_AT,
    });
    await expect(late.run()).resolves.toBeTruthy();
  });

  it("NFR-001: an unwindowed tier sells at every one of those instants", async () => {
    for (const now of [
      new Date(OPENS_AT.getTime() - 1),
      new Date(CLOSES_AT.getTime()),
    ]) {
      const { run } = await sellAt(now, {});
      await expect(run()).resolves.toBeTruthy();
    }
  });

  it("REPORTS an unparseable bound through deps.reportError, and still sells", async () => {
    // The window guard fails OPEN on an unevaluatable bound — correct, but the
    // till has no event-level close behind it, so the fail-open must be
    // visible. Three layers make this unreachable in practice (Zod coercion,
    // normalizeSalesWindow's NaN check, TIMESTAMP(3)); "unreachable" and
    // "unobservable if reached" are different properties.
    const reportError = vi.fn();
    const tx = makeTx({
      ticketTypes: [
        {
          id: TT_GA,
          priceCents: 1500,
          capacity: 100,
          salesCloseAt: new Date("nope"),
        },
      ],
    });
    const { repos, idempotency, clock } = makeDeps(tx, new Map(), NOW);

    await recordCashSale(
      { repos, authz: denyingAuthz, idempotency, clock, reportError },
      {
        actorHumanId: ACTOR,
        eventId: EVENT_ID,
        clientKey: "win-unparseable",
        items: [{ ticketTypeId: TT_GA, qty: 1 }],
        amountCollectedCents: 1500,
      },
    );

    expect(reportError).toHaveBeenCalledTimes(1);
    const [error, context] = reportError.mock.calls[0]!;
    expect((error as Error).message).toBe(
      "ticket_type_sales_window_unparseable:salesCloseAt",
    );
    expect(context).toMatchObject({
      tags: { area: "pos", field: "salesCloseAt" },
      extra: { surface: "recordCashSale", ticketTypeId: TT_GA },
    });
    // ...and the sale still went through: reporting is a signal, not a gate.
    expect(tx.orders.createPending).toHaveBeenCalled();
  });

  it("a missing reporter changes nothing (it is optional everywhere)", async () => {
    const tx = makeTx({
      ticketTypes: [
        {
          id: TT_GA,
          priceCents: 1500,
          capacity: 100,
          salesCloseAt: new Date("nope"),
        },
      ],
    });
    const { repos, idempotency, clock } = makeDeps(tx, new Map(), NOW);

    await expect(
      recordCashSale(
        { repos, authz: denyingAuthz, idempotency, clock },
        {
          actorHumanId: ACTOR,
          eventId: EVENT_ID,
          clientKey: "win-unparseable-noreporter",
          items: [{ ticketTypeId: TT_GA, qty: 1 }],
          amountCollectedCents: 1500,
        },
      ),
    ).resolves.toBeTruthy();
  });
});

/**
 * Pay-what-you-can on the CASH path.
 *
 * Cash has two different numbers and they must not be confused:
 *   - `donationAmountCents` is what the tier is PRICED at. It sets
 *     `expectedDueCents` (what the screen tells the operator to collect) and
 *     `OrderItem.unitPriceCents` (the permanent snapshot every later read
 *     uses).
 *   - `amountCollectedCents` is what actually changed hands. It is
 *     operator-asserted and free to differ, exactly as it already may for a
 *     FIXED tier.
 *
 * Before this, an ADJUSTABLE tier priced through `resolveUnitPriceCents` and
 * so resolved to its stored `priceCents` — which is 0 by construction for
 * ADJUSTABLE. Cash did not refuse the sale (unlike the card path, it has no
 * non-zero guard), so it silently minted tickets at $0 and told the operator
 * to collect nothing.
 */
describe("recordCashSale — pay what you can (ADJUSTABLE)", () => {
  const TT_PWYC = "00000000-0000-4000-8000-0000000000b8";

  const pwycTx = () =>
    makeTx({
      ticketTypes: [
        {
          id: TT_PWYC,
          priceCents: 0,
          capacity: 100,
          pricingMode: "ADJUSTABLE",
          minimumCents: 500,
          suggestedCents: 2000,
        },
      ],
    });

  it("prices the line and expectedDue from the named amount", async () => {
    const tx = pwycTx();
    const { repos, idempotency, clock } = makeDeps(tx);

    const result = await recordCashSale(
      { repos, authz: denyingAuthz, idempotency, clock },
      {
        actorHumanId: ACTOR,
        eventId: EVENT_ID,
        clientKey: "cash-pwyc-1",
        items: [{ ticketTypeId: TT_PWYC, qty: 2, donationAmountCents: 1500 }],
        amountCollectedCents: 3000,
      },
    );

    expect(result.expectedDueCents).toBe(3000);
    expect(result.amountCents).toBe(3000);
    expect(result.isComp).toBe(false);

    const order = tx.orders.createPending.mock.calls[0]![0];
    expect(order.items.filter((i: any) => i.kind === "ticket")).toHaveLength(2);
    for (const item of order.items.filter((i: any) => i.kind === "ticket")) {
      expect(item.unitPriceCents).toBe(1500);
    }
  });

  // Behaviour change (spec 2026-10-07 FR-003, owner ruling R4): the typed
  // amount used to be recorded as the sale's gross even when it was short of
  // the named price. The server prices the sale now; short cash is refused,
  // and the buyer names the amount they can actually pay instead.
  it("refuses cash short of the named price, with the required total in meta", async () => {
    const tx = pwycTx();
    const { repos, idempotency, clock } = makeDeps(tx);

    await expect(
      recordCashSale(
        { repos, authz: denyingAuthz, idempotency, clock },
        {
          actorHumanId: ACTOR,
          eventId: EVENT_ID,
          clientKey: "cash-pwyc-short",
          items: [{ ticketTypeId: TT_PWYC, qty: 1, donationAmountCents: 2000 }],
          amountCollectedCents: 1800,
        },
      ),
    ).rejects.toMatchObject({
      code: "CASH_AMOUNT_SHORT",
      meta: { requiredTotalCents: 2000, amountCollectedCents: 1800, shortByCents: 200 },
    });
    expect(tx.orders.createPending).not.toHaveBeenCalled();
  });

  it("comps a pay-what-you-can ticket at $0 collected", async () => {
    const tx = pwycTx();
    const { repos, idempotency, clock } = makeDeps(tx);

    const result = await recordCashSale(
      { repos, authz: denyingAuthz, idempotency, clock },
      {
        actorHumanId: ACTOR,
        eventId: EVENT_ID,
        clientKey: "cash-pwyc-comp",
        items: [{ ticketTypeId: TT_PWYC, qty: 1, donationAmountCents: 2000 }],
        amountCollectedCents: 0,
      },
    );

    // A comp records $0 (FR-005): nothing is due, and the line is not priced
    // at the named amount (behaviour change: it used to report 2000 due).
    expect(result.isComp).toBe(true);
    expect(result.expectedDueCents).toBe(0);
    expect(result.amountCents).toBe(0);
    const order = tx.orders.createPending.mock.calls[0]![0];
    expect(order.amountGrossCents).toBe(0);
    expect(order.items[0].unitPriceCents).toBe(0);
  });

  it("refuses an amount below the floor", async () => {
    const tx = pwycTx();
    const { repos, idempotency, clock } = makeDeps(tx);

    await expect(
      recordCashSale(
        { repos, authz: denyingAuthz, idempotency, clock },
        {
          actorHumanId: ACTOR,
          eventId: EVENT_ID,
          clientKey: "cash-pwyc-under",
          items: [{ ticketTypeId: TT_PWYC, qty: 1, donationAmountCents: 100 }],
          amountCollectedCents: 100,
        },
      ),
    ).rejects.toMatchObject({ message: "donation_below_minimum" });

    expect(tx.orders.createPending).not.toHaveBeenCalled();
  });

  it("refuses an ADJUSTABLE line with no amount", async () => {
    const tx = pwycTx();
    const { repos, idempotency, clock } = makeDeps(tx);

    await expect(
      recordCashSale(
        { repos, authz: denyingAuthz, idempotency, clock },
        {
          actorHumanId: ACTOR,
          eventId: EVENT_ID,
          clientKey: "cash-pwyc-missing",
          items: [{ ticketTypeId: TT_PWYC, qty: 1 }],
          amountCollectedCents: 2000,
        },
      ),
    ).rejects.toMatchObject({ message: "donation_amount_required" });
  });

  it("a replay with a different named amount conflicts", async () => {
    const idempState = new Map<string, any>();
    const base = {
      actorHumanId: ACTOR,
      eventId: EVENT_ID,
      clientKey: "cash-pwyc-replay",
      amountCollectedCents: 2000,
    };

    const first = makeDeps(pwycTx(), idempState);
    await recordCashSale(
      {
        repos: first.repos,
        authz: denyingAuthz,
        idempotency: first.idempotency,
        clock: first.clock,
      },
      {
        ...base,
        items: [{ ticketTypeId: TT_PWYC, qty: 1, donationAmountCents: 2000 }],
      },
    );

    const second = makeDeps(pwycTx(), idempState);
    await expect(
      recordCashSale(
        {
          repos: second.repos,
          authz: denyingAuthz,
          idempotency: second.idempotency,
          clock: second.clock,
        },
        {
          ...base,
          items: [{ ticketTypeId: TT_PWYC, qty: 1, donationAmountCents: 4000 }],
        },
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
  });
});

describe("recordCashSale — only ACTIVE ticket types are sellable (money audit 2026-09-08 #14)", () => {
  // Cash mints inline, so this is the last gate before a ticket exists for an
  // archived or unpublished tier. Same `status === "ACTIVE"` rule as the till
  // screen (`listSellableItems`) and the public page. At the port those are
  // ONE value — the adapter folds the DB's INACTIVE and ARCHIVED to "DRAFT" —
  // so that is the value fed here.
  const TT_HIDDEN = "00000000-0000-4000-8000-0000000000a7";

  function twoTiers() {
    return makeTx({
      ticketTypes: [
        { id: TT_GA, priceCents: 3000, capacity: 100 },
        {
          id: TT_HIDDEN,
          priceCents: 3000,
          capacity: 100,
          status: "DRAFT",
        },
      ],
    });
  }

  {
    it("refuses an archived or unpublished (DRAFT) tier named by id — no order, nothing minted", async () => {
      const tx = twoTiers();
      const { repos, idempotency, clock } = makeDeps(tx);

      await expect(
        recordCashSale(
          { repos, authz: denyingAuthz, idempotency, clock },
          {
            actorHumanId: ACTOR,
            eventId: EVENT_ID,
            clientKey: "client-key-draft-tier",
            items: [{ ticketTypeId: TT_HIDDEN, qty: 1 }],
            amountCollectedCents: 3000,
          },
        ),
      ).rejects.toMatchObject({ code: "TICKET_TYPE_NOT_FOUND" });

      expect(tx.orders.createPending).not.toHaveBeenCalled();
      expect(tx.orders.markSucceeded).not.toHaveBeenCalled();
      expect(tx.tickets.markScanned).not.toHaveBeenCalled();
    });
  }

  it("still sells the ACTIVE tier listed alongside a DRAFT one", async () => {
    const tx = twoTiers();
    const { repos, idempotency, clock } = makeDeps(tx);

    const result = await recordCashSale(
      { repos, authz: denyingAuthz, idempotency, clock },
      {
        actorHumanId: ACTOR,
        eventId: EVENT_ID,
        clientKey: "client-key-active-beside-hidden",
        items: [{ ticketTypeId: TT_GA, qty: 1 }],
        amountCollectedCents: 3000,
      },
    );

    expect(result.orderId).toBe(ORDER_ID);
    expect(result.ticketCount).toBe(1);
  });
});

describe("recordCashSale — the door sells published events only (owner ruling 2026-10-07)", () => {
  /** The event fake with its status overridden; the default is PUBLISHED. */
  function txWithStatus(status: "DRAFT" | "CANCELLED") {
    const tx = makeTx({});
    const base = tx.events.getById.getMockImplementation()!;
    tx.events.getById = vi.fn(async (id: string) => ({
      ...(await base(id)),
      status,
    })) as any;
    return tx;
  }

  it.each(["DRAFT", "CANCELLED"] as const)(
    "a %s event is refused before the tax lookup and before the transaction",
    async (status) => {
      const tx = txWithStatus(status);
      const { repos, idempotency, clock, idempState } = makeDeps(tx);
      const lookupByPostalCode = vi.fn(async () => ({
        rateBps: 975,
        source: "ziptax",
      }));

      await expect(
        recordCashSale(
          {
            repos,
            authz: denyingAuthz,
            idempotency,
            clock,
            taxRateLookup: { lookupByPostalCode } as never,
          },
          {
            actorHumanId: ACTOR,
            eventId: EVENT_ID,
            clientKey: `client-key-${status}`,
            items: [{ ticketTypeId: TT_GA, qty: 1 }],
            amountCollectedCents: 3000,
          },
        ),
      ).rejects.toMatchObject({
        code: "EVENT_NOT_PUBLISHED",
        message: "door_sells_published_events_only",
        meta: { status },
      });

      expect(lookupByPostalCode).not.toHaveBeenCalled();
      expect(repos.tx).not.toHaveBeenCalled();
      expect(tx.orders.createPending).not.toHaveBeenCalled();
      // The claim is released, so a retry after publishing is not refused
      // as a duplicate.
      expect(idempState.size).toBe(0);
    },
  );

  it.each(["DRAFT", "CANCELLED"] as const)(
    "a comp on a %s event is refused too (the comp opens the same transaction)",
    async (status) => {
      const tx = txWithStatus(status);
      const { repos, idempotency, clock } = makeDeps(tx);

      await expect(
        recordCashSale(
          { repos, authz: denyingAuthz, idempotency, clock },
          {
            actorHumanId: ACTOR,
            eventId: EVENT_ID,
            clientKey: `client-key-comp-${status}`,
            items: [{ ticketTypeId: TT_GA, qty: 1 }],
            amountCollectedCents: 0,
            comp: true,
          },
        ),
      ).rejects.toMatchObject({ code: "EVENT_NOT_PUBLISHED" });

      expect(tx.events.lockRows).toHaveBeenCalledWith({
        ids: [EVENT_ID],
        mode: "share",
      });
      expect(tx.orders.createPending).not.toHaveBeenCalled();
      expect(tx.tickets.markScanned).not.toHaveBeenCalled();
    },
  );

  it("an event cancelled while the sale waited on the lock is refused inside the transaction: no order, no debit", async () => {
    const tx = makeTx({});
    const base = tx.events.getById.getMockImplementation()!;
    let cancelled = false;
    tx.events.getById = vi.fn(async (id: string) => ({
      ...(await base(id)),
      status: cancelled ? "CANCELLED" : "PUBLISHED",
    })) as any;
    // The cancellation commits while this sale waits for the share lock.
    tx.events.lockRows = vi.fn(async () => {
      cancelled = true;
    }) as any;
    const { repos, idempotency, clock } = makeDeps(tx);

    await expect(
      recordCashSale(
        { repos, authz: denyingAuthz, idempotency, clock },
        {
          actorHumanId: ACTOR,
          eventId: EVENT_ID,
          clientKey: "client-key-race",
          items: [{ ticketTypeId: TT_GA, qty: 1 }],
          amountCollectedCents: 3000,
        },
      ),
    ).rejects.toMatchObject({ code: "EVENT_NOT_PUBLISHED" });

    // The lock came first in the transaction, before its read of the event.
    const lockAt = tx.events.lockRows.mock.invocationCallOrder[0]!;
    const readsAfterLock = tx.events.getById.mock.invocationCallOrder.filter(
      (n: number) => n > lockAt,
    );
    expect(readsAfterLock.length).toBeGreaterThan(0);
    expect(tx.orders.createPending).not.toHaveBeenCalled();
    expect(tx._ledger.entries).toHaveLength(0);
  });
});
