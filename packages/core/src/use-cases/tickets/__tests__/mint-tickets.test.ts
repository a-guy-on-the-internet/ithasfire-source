import { beforeEach, describe, expect, it, vi } from "vitest";

import { mintTicketsForOrder } from "../mint-tickets";
import { buildOffsetPaginatedResult } from "@th/ports";
import type { TxRepos } from "@th/ports/repos";
import type { OrderItemRecord, OrderRecord } from "@th/ports/repos/orders";
import type { TicketRecord } from "@th/ports/repos/tickets";
import type { SeatRecord } from "@th/ports/repos/seats";
import type { EventRecord } from "@th/ports/repos/events";
import * as ticketCodes from "../../../lib/tickets/generate-ticket-code";

const defaultIssuedAt = new Date("2025-01-01T10:00:00Z");

function makeOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  const base: OrderRecord = {
    id: "order-1",
    eventId: "event-1",
    buyerHumanId: "human-1",
    amountGrossCents: 0,
    feesPlatformCents: 0,
    currency: "usd",
    feePolicySnapshot: {},
    status: "PENDING",
    stripePaymentIntentId: null,
    source: "PRIMARY",
    nonRefundable: false,
    occurredAt: new Date("2025-01-01T09:00:00Z"),
    parentOrderId: null,
    taxAmountCents: 0,
    billingAddressLine1: null,
    billingAddressLine2: null,
    billingCity: null,
    billingState: null,
    billingPostalCode: null,
    billingCountry: null,
    stripeTaxCalculationId: null,
    items: [
      {
        id: "item-1",
        orderId: "order-1",
        kind: "ticket",
        ticketTypeId: "tt-1",
        qty: 2,
        unitPriceCents: 5000,
        amountCents: 10000,
        meta: {},
        paidOutAt: null,
        refundedAt: null,
        transferredAt: null,
        status: "active",
      },
    ],
  } satisfies OrderRecord;

  const items = (overrides.items ?? base.items).map((item) => ({ ...item }));

  return {
    ...base,
    ...overrides,
    items,
  };
}

function makeTx(overrides?: {
  ticketsCreate?: any;
  ticketsCountForOrderTicketType?: any;
  ticketsCountIssuedForTicketType?: any;
  ticketsCountCapacityConsumingForTicketType?: any;
  ticketsFindBySeatIds?: any;
  ticketsFindBySeatIdsIncludingTerminal?: any;
  ticketsGetByOrderItemId?: any;
  eventsListTicketTypes?: any;
  seatsFindByIdsForUpdate?: any;
  seatsUpdateStatuses?: any;
  seatRecords?: SeatRecord[];
  seatTickets?: TicketRecord[];
  ticketTypeCapacity?: number;
  ticketTypeSeatSectionId?: string | null;
}) {
  const defaultEvent: EventRecord = {
    id: "event-1",
    orgId: "org-1",
    humanId: "host-1",
    title: "Mint Tickets Showcase",
    status: "PUBLISHED",
    visibility: "PUBLIC",
    gateType: "NONE",
    locationMode: "EXACT",
    locationRadiusMeters: null,
    locationLabel: null,
    addressRevealAt: null,
    addressRevealPreset: null,
    startsAt: new Date("2025-02-01T20:00:00Z"),
    endsAt: null,
    placeId: null,
    savedLocationId: null,
    categoryId: null,
    addressText: null,
    lat: null,
    lng: null,
    slug: "mint-tickets",
    shortId: "MINT",
    regionCode: null,
    publishedAt: null,
    agreementPrimaryId: "agreement-primary",
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
    currency: null,
  } satisfies EventRecord;

  const capacity = overrides?.ticketTypeCapacity ?? 10;
  const seatSectionId = overrides?.ticketTypeSeatSectionId ?? null;
  const seatRecords = overrides?.seatRecords ?? [];
  const seatTickets = overrides?.seatTickets ?? [];

  const ticketsCreate =
    overrides?.ticketsCreate ??
    vi.fn(
      async (input) =>
        ({
          id: `ticket-${Math.random().toString(36).slice(2)}`,
          eventId: input.eventId,
          ticketTypeId: input.ticketTypeId ?? null,
          ownerHumanId: input.ownerHumanId,
          orderId: input.orderId ?? null,
          orderItemId: input.orderItemId ?? null,
          seatId: input.seatId ?? null,
          code: input.code,
          status: input.status,
          issuedAt: input.issuedAt,
          scannedAt: null,
        }) satisfies TicketRecord,
    );

  const ticketsCountForOrderTicketType =
    overrides?.ticketsCountForOrderTicketType ?? vi.fn(async () => 0);

  const ticketsCountIssuedForTicketType =
    overrides?.ticketsCountIssuedForTicketType ?? vi.fn(async () => 0);

  // The backstop's count: tickets that still hold a place (VALID | SCANNED |
  // LISTED). Separate from the all-rows count above so a test can give the
  // two different answers, as a refund does.
  const ticketsCountCapacityConsumingForTicketType =
    overrides?.ticketsCountCapacityConsumingForTicketType ??
    vi.fn(async () => 0);

  const ticketsFindBySeatIds =
    overrides?.ticketsFindBySeatIds ?? vi.fn(async () => seatTickets);

  // Mint reads the UNFILTERED twin: it needs to see terminal rows that still
  // hold a `seatId`, because `Ticket.seatId` is @unique and one of those makes
  // `tickets.create` throw P2002 after the buyer is charged.
  const ticketsFindBySeatIdsIncludingTerminal =
    overrides?.ticketsFindBySeatIdsIncludingTerminal ??
    vi.fn(async () => seatTickets);

  const ticketsGetByOrderItemId =
    overrides?.ticketsGetByOrderItemId ?? vi.fn(async () => null);

  const eventsListTicketTypes =
    overrides?.eventsListTicketTypes ??
    vi.fn(async () => [
      {
        id: "tt-1",
        name: "General Admission",
        priceCents: 5000,
        capacity,
        status: "ACTIVE",
        seatSectionId,
      },
    ]);

  const seatsFindByIdsForUpdate =
    overrides?.seatsFindByIdsForUpdate ?? vi.fn(async () => seatRecords);

  const seatsUpdateStatuses =
    overrides?.seatsUpdateStatuses ?? vi.fn(async () => undefined);

  const eventsRepo: TxRepos["events"] = {
    getById: vi.fn(async () => ({ ...defaultEvent })),
    findManyByIds: vi.fn(async () => [{ ...defaultEvent }]),
    getContent: vi.fn(async () => null),
    updateContent: vi.fn(async () => ({ ...defaultEvent })),
    listPublishedByCountry: vi.fn(async () =>
      buildOffsetPaginatedResult({ items: [], total: 0, limit: 1, offset: 0 }),
    ),
    listTicketTypes: eventsListTicketTypes,
    ensureHostPermission: vi.fn(async () => true),
    upsertDraft: vi.fn(async () => ({ ...defaultEvent })),
    publish: vi.fn(async () => ({ ...defaultEvent })),
    listPublishedForSitemap: vi.fn(async () => []),
    setCategory: vi.fn(async () => ({ ...defaultEvent })),
    setListingPriority: vi.fn(async () => ({ ...defaultEvent })),
    filterByCategory: vi.fn(async () =>
      buildOffsetPaginatedResult({ items: [], total: 0, limit: 1, offset: 0 }),
    ),
    listPublishedByRegion: vi.fn(async () =>
      buildOffsetPaginatedResult({ items: [], total: 0, limit: 1, offset: 0 }),
    ),
    searchPublished: vi.fn(async () => []),
    updateVisibility: vi.fn(async () => ({ ...defaultEvent })),
    updateGateType: vi.fn(async () => ({ ...defaultEvent })),
    updatePassword: vi.fn(async () => ({ ...defaultEvent })),
    updateWaitlistSettings: vi.fn(async () => ({ ...defaultEvent })),
    getGateSettings: vi.fn(async () => ({
      eventId: defaultEvent.id,
      visibility: defaultEvent.visibility,
      gateType: defaultEvent.gateType,
      passwordHash: defaultEvent.passwordHash ?? null,
      passwordUpdatedAt: defaultEvent.passwordUpdatedAt ?? null,
      waitlistStatus: defaultEvent.waitlistStatus,
      waitlistPublishAt: defaultEvent.waitlistPublishAt ?? null,
      waitlistDescription: defaultEvent.waitlistDescription ?? null,
      waitlistCap: defaultEvent.waitlistCap ?? null,
      payoutTermsId: null,
      resalePayoutTermsId: null,
      placeLayoutId: null,
    })),
    assignSlug: vi.fn(async () => ({ ...defaultEvent })),
    updateSlug: vi.fn(async () => ({ ...defaultEvent })),
    recordSlugHistory: vi.fn(async () => undefined),
    resolveBySlug: vi.fn(async () => null),
    getSlugContext: vi.fn(async () => null),
  };

  const txPartial = {
    tickets: {
      create: ticketsCreate,
      findBySeatIds: ticketsFindBySeatIds,
      findBySeatIdsIncludingTerminal: ticketsFindBySeatIdsIncludingTerminal,
      countForOrderTicketType: ticketsCountForOrderTicketType,
      countIssuedForTicketType: ticketsCountIssuedForTicketType,
      countCapacityConsumingForTicketType:
        ticketsCountCapacityConsumingForTicketType,
      countIssuedForEvent: vi.fn(async () => 0),
      markScanned: vi.fn(),
      getById: vi.fn(async () => null),
      getByOrderItemId: ticketsGetByOrderItemId,
      getByCode: vi.fn(),
      setStatus: vi.fn(),
      recordScan: vi.fn(),
      transfer: vi.fn(),
      findTicketTypeByName: vi.fn(
        async (_eventId: string, _name: string) => null,
      ),
      createTicketType: vi.fn(),
    },
    events: eventsRepo,
    seats: {
      findByIdsForUpdate: seatsFindByIdsForUpdate,
      updateStatuses: seatsUpdateStatuses,
    },
    categories: {
      listActive: vi.fn(),
      getBySlug: vi.fn(),
      getById: vi.fn(),
      upsertSeed: vi.fn(),
    },
  } as Partial<TxRepos>;

  const tx = txPartial as TxRepos;

  return {
    tx,
    mocks: {
      ticketsCreate,
      ticketsCountForOrderTicketType,
      ticketsCountIssuedForTicketType,
      ticketsCountCapacityConsumingForTicketType,
      ticketsFindBySeatIds,
      ticketsFindBySeatIdsIncludingTerminal,
      ticketsGetByOrderItemId,
      eventsListTicketTypes,
      seatsFindByIdsForUpdate,
      seatsUpdateStatuses,
    },
  };
}

describe("mintTicketsForOrder", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(ticketCodes, "generateTicketCode").mockImplementation(
      () => "tk_test_code",
    );
  });

  it("creates tickets for each order ticket item when none exist yet", async () => {
    const order = makeOrder();
    const { tx, mocks } = makeTx();

    const result = await mintTicketsForOrder(tx, {
      order,
      issuedAt: defaultIssuedAt,
      actor: { kind: "system", reason: "unit_test" },
    });

    expect(result.count).toBe(2);
    expect(result.tickets).toHaveLength(2);
    expect(mocks.ticketsCreate).toHaveBeenCalledTimes(2);
    expect(mocks.ticketsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: order.id,
        ticketTypeId: "tt-1",
        seatId: null,
        status: "VALID",
      }),
    );
  });

  it("skips issuance when tickets for the order already exist", async () => {
    const order = makeOrder();
    const alreadyCount = 2;
    const { tx, mocks } = makeTx({
      ticketsCountForOrderTicketType: vi.fn(async () => alreadyCount),
    });

    const result = await mintTicketsForOrder(tx, {
      order,
      issuedAt: defaultIssuedAt,
      actor: { kind: "system", reason: "idempotent" },
    });

    expect(result.count).toBe(0);
    expect(result.tickets).toHaveLength(0);
    expect(mocks.ticketsCreate).not.toHaveBeenCalled();
  });

  it("enforces ticket type capacity", async () => {
    const order = makeOrder();
    const { tx } = makeTx({
      ticketTypeCapacity: 10,
      ticketsCountCapacityConsumingForTicketType: vi.fn(async () => 9),
    });

    await expect(
      mintTicketsForOrder(tx, {
        order,
        issuedAt: defaultIssuedAt,
        actor: { kind: "system", reason: "capacity" },
      }),
    ).rejects.toMatchObject({ code: "TICKET_TYPE_SOLD_OUT" });
  });

  // Refunds restock (spec 2026-10-09, FR-003): the backstop counts places
  // still held, the same `issued` as the pre-charge gate. Ten rows exist, two
  // of them refunded, so two places are free and this order of two fits.
  it("mints into places a refund freed", async () => {
    const order = makeOrder();
    const { tx, mocks } = makeTx({
      ticketTypeCapacity: 10,
      ticketsCountIssuedForTicketType: vi.fn(async () => 10),
      ticketsCountCapacityConsumingForTicketType: vi.fn(async () => 8),
    });

    const result = await mintTicketsForOrder(tx, {
      order,
      issuedAt: defaultIssuedAt,
      actor: { kind: "system", reason: "restock" },
    });

    expect(result.count).toBe(2);
    expect(mocks.ticketsCreate).toHaveBeenCalledTimes(2);
    expect(
      mocks.ticketsCountCapacityConsumingForTicketType,
    ).toHaveBeenCalledWith("tt-1");
    expect(mocks.ticketsCountIssuedForTicketType).not.toHaveBeenCalled();
  });

  // FR-004: idempotency reads the order's ALL-ROWS count. This order's two
  // tickets were refunded, so they hold no place, but a replayed mint must
  // still find them and make nothing new.
  it("does not re-mint an order whose tickets were refunded", async () => {
    const order = makeOrder();
    const { tx, mocks } = makeTx({
      ticketTypeCapacity: 10,
      ticketsCountForOrderTicketType: vi.fn(async () => 2),
      ticketsCountCapacityConsumingForTicketType: vi.fn(async () => 0),
    });

    const result = await mintTicketsForOrder(tx, {
      order,
      issuedAt: defaultIssuedAt,
      actor: { kind: "system", reason: "replay_after_refund" },
    });

    expect(result.count).toBe(0);
    expect(mocks.ticketsCreate).not.toHaveBeenCalled();
  });

  it("assigns seats and marks them sold when provided", async () => {
    const seatIds = ["seat-1", "seat-2"];
    const order = makeOrder({
      items: [
        {
          id: "item-1",
          orderId: "order-1",
          kind: "ticket",
          ticketTypeId: "tt-1",
          qty: seatIds.length,
          unitPriceCents: 5000,
          amountCents: seatIds.length * 5000,
          meta: { seatIds },
          paidOutAt: null,
          refundedAt: null,
          transferredAt: null,
          status: "active",
        } satisfies OrderItemRecord,
      ],
    });

    const seats: SeatRecord[] = seatIds.map((id, index) => ({
      id,
      seatSectionId: "section-1",
      eventId: order.eventId,
      status: index === 0 ? "AVAILABLE" : "HELD",
      label: `A${index + 1}`,
      row: "A",
      number: index + 1,
    }));

    const { tx, mocks } = makeTx({
      seatRecords: seats,
      seatTickets: [],
      ticketTypeSeatSectionId: "section-1",
    });

    const result = await mintTicketsForOrder(tx, {
      order,
      issuedAt: defaultIssuedAt,
      actor: { kind: "system", reason: "seat_assignment" },
    });

    expect(result.count).toBe(seatIds.length);
    expect(mocks.ticketsCreate).toHaveBeenCalledTimes(seatIds.length);
    expect(mocks.seatsFindByIdsForUpdate).toHaveBeenCalledWith({
      seatIds,
      eventId: order.eventId,
    });
    expect(mocks.seatsUpdateStatuses).toHaveBeenCalledWith({
      seatIds,
      status: "SOLD",
      updatedAt: defaultIssuedAt,
    });

    const createdSeatIds = mocks.ticketsCreate.mock.calls.map(
      (call: any[]) => call[0]?.seatId ?? null,
    );
    expect(createdSeatIds).toEqual(seatIds);
  });

  it("mints all tickets when multiple items share the same ticketTypeId with qty=1 each", async () => {
    // This is the real-world scenario: computeOrderAmounts creates one
    // OrderItem per ticket (qty=1 each) so 5 GA tickets produce 5 items
    // all sharing the same ticketTypeId.
    const items: OrderItemRecord[] = Array.from({ length: 5 }, (_, i) => ({
      id: `item-${i + 1}`,
      orderId: "order-1",
      kind: "ticket" as const,
      ticketTypeId: "tt-1",
      qty: 1,
      unitPriceCents: 5000,
      amountCents: 5000,
      meta: {},
      paidOutAt: null,
      refundedAt: null,
      transferredAt: null,
      status: "active" as const,
    }));

    const order = makeOrder({ items });
    const { tx, mocks } = makeTx({ ticketTypeCapacity: 100 });

    const result = await mintTicketsForOrder(tx, {
      order,
      issuedAt: defaultIssuedAt,
      actor: { kind: "system", reason: "multi_item_same_type" },
    });

    expect(result.count).toBe(5);
    expect(result.tickets).toHaveLength(5);
    expect(mocks.ticketsCreate).toHaveBeenCalledTimes(5);

    // Each item should get exactly one ticket
    const orderItemIds = mocks.ticketsCreate.mock.calls.map(
      (call: any[]) => call[0]?.orderItemId,
    );
    expect(orderItemIds.sort()).toEqual(items.map((i) => i.id).sort());
  });

  it("resumes minting on idempotent retry when some items already have tickets", async () => {
    // Simulate a partial mint: 5 items, 1 already minted. The function
    // should mint the remaining 4.
    const items: OrderItemRecord[] = Array.from({ length: 5 }, (_, i) => ({
      id: `item-${i + 1}`,
      orderId: "order-1",
      kind: "ticket" as const,
      ticketTypeId: "tt-1",
      qty: 1,
      unitPriceCents: 5000,
      amountCents: 5000,
      meta: {},
      paidOutAt: null,
      refundedAt: null,
      transferredAt: null,
      status: "active" as const,
    }));

    const existingTicket: TicketRecord = {
      id: "existing-ticket-1",
      eventId: "event-1",
      ticketTypeId: "tt-1",
      ownerHumanId: "human-1",
      orderId: "order-1",
      orderItemId: "item-1",
      seatId: null,
      code: "tk_existing",
      status: "VALID",
      issuedAt: defaultIssuedAt,
      scannedAt: null,
    };

    const order = makeOrder({ items });
    const { tx, mocks } = makeTx({
      ticketTypeCapacity: 100,
      // 1 ticket already exists for this order+ticketType
      ticketsCountForOrderTicketType: vi.fn(async () => 1),
      // item-1 already has a ticket, all others return null
      ticketsGetByOrderItemId: vi.fn(async (orderItemId: string) =>
        orderItemId === "item-1" ? existingTicket : null,
      ),
    });

    const result = await mintTicketsForOrder(tx, {
      order,
      issuedAt: defaultIssuedAt,
      actor: { kind: "system", reason: "idempotent_retry" },
    });

    expect(result.count).toBe(4);
    expect(result.tickets).toHaveLength(4);
    expect(mocks.ticketsCreate).toHaveBeenCalledTimes(4);

    // item-1 should NOT appear in created tickets
    const orderItemIds = mocks.ticketsCreate.mock.calls.map(
      (call: any[]) => call[0]?.orderItemId,
    );
    expect(orderItemIds).not.toContain("item-1");
    expect(orderItemIds.sort()).toEqual([
      "item-2",
      "item-3",
      "item-4",
      "item-5",
    ]);
  });

  it("resumes seated minting on idempotent retry when one seat is already SOLD", async () => {
    // 3 seated items, 1 already minted (seat-1 SOLD), 2 remaining (HELD).
    const seatIds = ["seat-1", "seat-2", "seat-3"];
    const items: OrderItemRecord[] = seatIds.map((seatId, i) => ({
      id: `item-${i + 1}`,
      orderId: "order-1",
      kind: "ticket" as const,
      ticketTypeId: "tt-1",
      qty: 1,
      unitPriceCents: 5000,
      amountCents: 5000,
      meta: { seatIds: [seatId] },
      paidOutAt: null,
      refundedAt: null,
      transferredAt: null,
      status: "active" as const,
    }));

    const existingTicket: TicketRecord = {
      id: "existing-ticket-1",
      eventId: "event-1",
      ticketTypeId: "tt-1",
      ownerHumanId: "human-1",
      orderId: "order-1",
      orderItemId: "item-1",
      seatId: "seat-1",
      code: "tk_existing",
      status: "VALID",
      issuedAt: defaultIssuedAt,
      scannedAt: null,
    };

    const seats: SeatRecord[] = seatIds.map((id, index) => ({
      id,
      seatSectionId: "section-1",
      eventId: "event-1",
      status: index === 0 ? "SOLD" : "HELD", // seat-1 already SOLD
      label: `A${index + 1}`,
      row: "A",
      number: index + 1,
    }));

    const order = makeOrder({ items });
    const { tx, mocks } = makeTx({
      ticketTypeCapacity: 100,
      ticketTypeSeatSectionId: "section-1",
      seatRecords: seats,
      seatTickets: [existingTicket], // findBySeatIds returns the existing ticket
      ticketsCountForOrderTicketType: vi.fn(async () => 1),
      ticketsGetByOrderItemId: vi.fn(async (orderItemId: string) =>
        orderItemId === "item-1" ? existingTicket : null,
      ),
    });

    const result = await mintTicketsForOrder(tx, {
      order,
      issuedAt: defaultIssuedAt,
      actor: { kind: "system", reason: "seated_idempotent_retry" },
    });

    expect(result.count).toBe(2);
    expect(result.tickets).toHaveLength(2);
    expect(mocks.ticketsCreate).toHaveBeenCalledTimes(2);

    // Only the 2 un-minted seats should be assigned
    const createdSeatIds = mocks.ticketsCreate.mock.calls.map(
      (call: any[]) => call[0]?.seatId ?? null,
    );
    expect(createdSeatIds.sort()).toEqual(["seat-2", "seat-3"]);

    // Seats should be marked SOLD (only the new ones)
    expect(mocks.seatsUpdateStatuses).toHaveBeenCalledWith({
      seatIds: ["seat-2", "seat-3"],
      status: "SOLD",
      updatedAt: defaultIssuedAt,
    });
  });
  it("refuses BEFORE the create when a voided ticket still holds the seat", async () => {
    // The @unique pre-flight. `Ticket.seatId` is @unique, so a REFUNDED row
    // still pointing at an AVAILABLE seat does not stop checkout (occupancy
    // reads filter it out) — it stops `tickets.create` with a raw P2002,
    // INSIDE finalize, after the buyer's card has been charged.
    //
    // Nothing in today's code produces that state: a release clears the link
    // and frees the seat together, and a forward-only refund leaves the seat
    // SOLD so checkout refuses pre-charge. A backfill run seats-first would,
    // and this is the guard that keeps that a deliberate refusal.
    const seatIds = ["seat-1"];
    const order = makeOrder({
      items: [
        {
          id: "item-1",
          orderId: "order-1",
          kind: "ticket",
          ticketTypeId: "tt-1",
          qty: 1,
          unitPriceCents: 5000,
          amountCents: 5000,
          meta: { seatIds },
          paidOutAt: null,
          refundedAt: null,
          transferredAt: null,
          status: "active",
        } satisfies OrderItemRecord,
      ],
    });

    const deadTicket: TicketRecord = {
      id: "dead-ticket-1",
      eventId: "event-1",
      ticketTypeId: "tt-1",
      ownerHumanId: "human-9",
      orderId: "order-old",
      orderItemId: "item-old",
      seatId: "seat-1",
      code: "tk_dead",
      status: "REFUNDED",
      issuedAt: defaultIssuedAt,
      scannedAt: null,
    };

    const { tx, mocks } = makeTx({
      // The seat row itself says free — this is the half-fixed state.
      seatRecords: [
        {
          id: "seat-1",
          seatSectionId: "section-1",
          eventId: "event-1",
          status: "AVAILABLE",
          label: "A1",
          row: "A",
          number: 1,
        },
      ],
      seatTickets: [deadTicket],
      ticketTypeSeatSectionId: "section-1",
    });

    await expect(
      mintTicketsForOrder(tx, {
        order,
        issuedAt: defaultIssuedAt,
        actor: { kind: "system", reason: "dead_seat_link" },
      }),
    ).rejects.toMatchObject({
      code: "SEAT_TAKEN",
      meta: { seatId: "seat-1", ticketId: "dead-ticket-1" },
    });

    // The whole point: we never reached the create, so no P2002 and no
    // half-minted order behind a successful charge.
    expect(mocks.ticketsCreate).not.toHaveBeenCalled();
    expect(mocks.seatsUpdateStatuses).not.toHaveBeenCalled();
  });
});
