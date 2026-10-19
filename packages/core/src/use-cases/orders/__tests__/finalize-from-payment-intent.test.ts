import { describe, expect, it, vi } from "vitest";

import { buildOffsetPaginatedResult } from "@th/ports";
import type { FinalizePaymentIntentDeps } from "../finalize-from-payment-intent";
import { finalizePaymentIntent } from "../finalize-from-payment-intent";
import type {
  PayoutTermsRecord,
  PayoutTermsRepo,
} from "@th/ports/repos/payout-terms";
import type { AuditRepo } from "@th/ports/repos/audit";
import type { EventRecord, EventsRepo } from "@th/ports/repos/events";
import type { OrdersRepo, OrderRecord } from "@th/ports/repos/orders";
import type { SeatsRepo } from "@th/ports/repos/seats";
import type { SplitsRepo } from "@th/ports/repos/splits";
import type {
  MarkScannedResult,
  TicketRecord,
  TicketsRepo,
} from "@th/ports/repos/tickets";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { IdempotencyPort } from "@th/ports/idempotency";
import { createTestLogger } from "@th/test-utils/fakes/logger";

const DEFAULT_EVENT_ID = "11111111-1111-4111-8111-111111111111";
const DEFAULT_ORDER_ID = "22222222-2222-4222-8222-222222222222";
const DEFAULT_PAYMENT_INTENT_ID = "pi_123456789";
const DEFAULT_STRIPE_EVENT_ID = "evt_123456789";

function makeStripeEvent(amountReceived: number, currency = "usd") {
  return {
    id: DEFAULT_STRIPE_EVENT_ID,
    type: "payment_intent.succeeded" as const,
    data: {
      object: {
        id: DEFAULT_PAYMENT_INTENT_ID,
        status: "succeeded" as const,
        amount_received: amountReceived,
        currency,
        metadata: {
          orderId: DEFAULT_ORDER_ID,
          eventId: DEFAULT_EVENT_ID,
          source: "primary" as const,
        },
      },
    },
  };
}

function makeContext() {
  const now = new Date("2025-03-01T12:00:00.000Z");

  const order: OrderRecord = {
    id: DEFAULT_ORDER_ID,
    eventId: DEFAULT_EVENT_ID,
    buyerHumanId: "buyer-1",
    amountGrossCents: 5000,
    feesPlatformCents: 500,
    currency: "usd",
    feePolicySnapshot: {},
    status: "PENDING",
    stripePaymentIntentId: null,
    source: "PRIMARY",
    occurredAt: now,
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
        orderId: DEFAULT_ORDER_ID,
        kind: "ticket",
        ticketTypeId: "ticket-type-1",
        qty: 2,
        unitPriceCents: 2500,
        amountCents: 5000,
        meta: {
          buyerTotalCents: 5500,
        },
        paidOutAt: null,
        refundedAt: null,
        transferredAt: null,
        status: "active",
      },
    ],
  };

  const agreementsRepo: PayoutTermsRepo = {
    getById: vi.fn(),
    createDraft: vi.fn(),
    updateDraft: vi.fn(),
    replaceLines: vi.fn(),
    listByEvent: vi.fn(async () => [
      {
        id: "agreement-1",
        kind: "PRIMARY_SPLIT",
        status: "ACTIVE",
        feeMode: null,
        feePolicyId: null,
        payoutSchedule: "WEEK_OF_EVENT",
        isDefault: false,
        settlementCurrency: "usd",
        version: 1,
        createdAt: now,
        updatedAt: now,
      } satisfies PayoutTermsRecord,
    ]) as PayoutTermsRepo["listByEvent"],
    listLines: vi.fn(async () => [
      {
        id: "line-1",
        agreementId: "agreement-1",
        payeeId: "payee-1",
        percent: 70,
        floorCents: 0,
        capPercent: null,
        priority: 0,
        rounding: "FLOOR" as const,
      },
      {
        id: "line-2",
        agreementId: "agreement-1",
        payeeId: "payee-2",
        percent: 30,
        floorCents: 0,
        capPercent: null,
        priority: 1,
        rounding: "NEAREST" as const,
      },
    ]) as PayoutTermsRepo["listLines"],
    pinFeePolicy: vi.fn(async () => {
      throw new Error("not implemented");
    }) as PayoutTermsRepo["pinFeePolicy"],
  };

  const ordersGetById = vi.fn(async (id: string) =>
    id === order.id ? { ...order } : null,
  );
  const ordersLinkPaymentIntent = vi.fn(async (_id: string, piId: string) => {
    order.stripePaymentIntentId = piId;
  });
  const ordersMarkSucceeded = vi.fn(async (_id: string) => {
    order.status = "SUCCEEDED";
  });
  // CAS forms, like the adapter: a stale read never resurrects an order.
  const ordersLinkPaymentIntentIfPending = vi.fn(
    async (
      _id: string,
      piId: string,
      linkOpts?: { allowProcessing?: boolean },
    ) => {
      const open =
        order.status === "PENDING" ||
        (linkOpts?.allowProcessing === true && order.status === "PROCESSING");
      if (
        !open ||
        (order.stripePaymentIntentId && order.stripePaymentIntentId !== piId)
      ) {
        return false;
      }
      order.stripePaymentIntentId = piId;
      return true;
    },
  );
  const ordersMarkSucceededIfOpen = vi.fn(async (_id: string) => {
    if (order.status !== "PENDING" && order.status !== "PROCESSING") {
      return false;
    }
    order.status = "SUCCEEDED";
    return true;
  });
  const ordersListOtherPending = vi.fn(async () => []);
  const ordersCancelPendingOrder = vi.fn(async () => true);
  const resaleTicketId = "resale-ticket-1";
  const resaleOriginalOrderItemId = "resale-original-item-1";
  const resaleListingId = "resale-listing-1";

  const ordersRepoImpl = {
    getById: ordersGetById as OrdersRepo["getById"],
    linkPaymentIntent:
      ordersLinkPaymentIntent as OrdersRepo["linkPaymentIntent"],
    markSucceeded: ordersMarkSucceeded as OrdersRepo["markSucceeded"],
    linkPaymentIntentIfPending:
      ordersLinkPaymentIntentIfPending as OrdersRepo["linkPaymentIntentIfPending"],
    markSucceededIfOpen:
      ordersMarkSucceededIfOpen as OrdersRepo["markSucceededIfOpen"],
    markProcessing: vi.fn(),
    createPending: vi.fn(),
    findByPaymentIntent: vi.fn(),
    markRefunded: vi.fn(),
    cancelProcessingOrder: vi.fn(async () => true),
    setPaymentMethodType: vi.fn(),
    listOtherPending: ordersListOtherPending,
    cancelPendingOrder: ordersCancelPendingOrder,
  } as Partial<OrdersRepo> as OrdersRepo;

  let ticketCounter = 0;
  const ticketsCreate = vi.fn(
    async (
      input: Parameters<TicketsRepo["create"]>[0],
    ): Promise<TicketRecord> => {
      ticketCounter += 1;
      return {
        id: `ticket-${ticketCounter}`,
        eventId: input.eventId,
        ticketTypeId: input.ticketTypeId,
        ownerHumanId: input.ownerHumanId,
        orderId: input.orderId ?? null,
        orderItemId: null,
        seatId: input.seatId ?? null,
        code: input.code,
        status: input.status,
        issuedAt: input.issuedAt,
        scannedAt: null,
      } satisfies TicketRecord;
    },
  );

  const ticketsRepo: TicketsRepo = {
    create: ticketsCreate,
    listByOrderId: vi.fn(async () => []),
    findBySeatIds: vi.fn(async () => []),
    // Mint reads the unfiltered twin for its @unique pre-flight.
    findBySeatIdsIncludingTerminal: vi.fn(async () => []),
    markScanned: vi.fn<[string, Date], Promise<MarkScannedResult>>(
      async () =>
        ({
          ok: true,
          scannedAt: new Date("2024-01-01T00:00:00.000Z"),
        }) satisfies MarkScannedResult,
    ),
    getById: vi.fn(async (ticketId: string) => {
      if (ticketId !== resaleTicketId) {
        return null;
      }

      return {
        id: resaleTicketId,
        eventId: DEFAULT_EVENT_ID,
        ticketTypeId: "ticket-type-1",
        ownerHumanId: order.buyerHumanId,
        orderId: order.id,
        orderItemId: resaleOriginalOrderItemId,
        seatId: null,
        code: "resale-code",
        status: "VALID",
        issuedAt: now,
        scannedAt: null,
      } satisfies TicketRecord;
    }),
    getByCode: vi.fn(async () => null),
    getByOrderItemId: vi.fn(async () => null),
    reassignForResale: vi.fn(async () => undefined),
    setStatus: vi.fn(async () => undefined),
    recordScan: vi.fn(async () => undefined),
    transfer: vi.fn(async () => undefined),
    findTicketTypeByName: vi.fn(async () => null),
    createTicketType: vi.fn(async () => {
      throw new Error("not implemented");
    }),
    countIssuedForTicketType: vi.fn(async () => 0),
    countCapacityConsumingForTicketType: vi.fn(async () => 0),
    countIssuedForEvent: vi.fn(async () => 0),
    countForOrderTicketType: vi.fn(async () => 0),
  };

  const splitsUpsertForOrder = vi.fn(
    async (
      _orderId: string,
      _rows: Array<{ payeeId: string; amountCents: number }>,
    ) => undefined,
  );

  const splitsRepo: SplitsRepo = {
    upsertForOrder: splitsUpsertForOrder as SplitsRepo["upsertForOrder"],
    getForOrder: vi.fn(),
  };

  const orderItemsRepo = {
    updateStatus: vi.fn(async () => undefined),
    setResaleListingId: vi.fn(async () => undefined),
    // Read by createCreditsFromOrder for the credit's item attribution.
    listByOrderId: vi.fn(async () => order.items),
    // Read by finalizeResalePurchase's refunded-original guard; the default
    // fixture has no refunded original, so a missing row ("null") is fine.
    getById: vi.fn(async () => null),
  };

  // Payee ledger (SETTLEMENT_CREDIT writes from createCreditsFromOrder).
  let ledgerEntrySeq = 0;
  const payeeLedgerSettlementCredit = vi.fn(
    async (input: Record<string, unknown>) => {
      ledgerEntrySeq += 1;
      return {
        id: `ledger-entry-${ledgerEntrySeq}`,
        type: "SETTLEMENT_CREDIT",
        ...input,
        createdAt: now,
      };
    },
  );
  const payeeLedgerRepo = {
    settlementCredit: payeeLedgerSettlementCredit,
  };

  const resaleListingsRepo = {
    getById: vi.fn(async (listingId: string) => {
      if (listingId !== resaleListingId) {
        return null;
      }

      return {
        id: resaleListingId,
        ticketId: resaleTicketId,
        sellerHumanId: "seller-1",
        status: "HELD",
        buyerOrderId: null,
      };
    }),
    commit: vi.fn(async () => ({ ok: true, ticketId: resaleTicketId })),
  };

  const auditRepo: AuditRepo = {
    log: vi.fn(async () => undefined),
  };

  const eventRecord: EventRecord = {
    id: DEFAULT_EVENT_ID,
    orgId: "org-1",
    humanId: "human-1",
    title: "Downtown Night",
    status: "PUBLISHED",
    visibility: "PUBLIC",
    gateType: "NONE",
    locationMode: "EXACT",
    locationRadiusMeters: null,
    locationLabel: null,
    addressRevealAt: null,
    addressRevealPreset: null,
    startsAt: now,
    endsAt: null,
    placeId: null,
    savedLocationId: null,
    categoryId: null,
    addressText: "123 Market St",
    lat: 37.7749,
    lng: -122.4194,
    slug: "downtown-night",
    shortId: "DNIGHT",
    regionCode: "US-CA",
    publishedAt: now,
    agreementPrimaryId: "agreement-1",
    agreementResaleId: null,
    defaultLocale: "en-US",
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

  const eventsListTicketTypes = vi.fn(async () => [
    {
      id: "ticket-type-1",
      name: "General Admission",
      priceCents: 2500,
      capacity: 100,
      status: "ACTIVE",
      seatSectionId: null,
    },
  ]);

  const eventsRepo: EventsRepo = {
    getById: vi.fn(async (id: string) =>
      id === eventRecord.id ? { ...eventRecord } : null,
    ),
    findManyByIds: vi.fn(async () => [{ ...eventRecord }]),
    getContent: vi.fn(async () => null),
    updateContent: vi.fn(async () => ({ ...eventRecord })),
    listPublishedByCountry: vi.fn(async () =>
      buildOffsetPaginatedResult({ items: [], total: 0, limit: 1, offset: 0 }),
    ),
    listTicketTypes: eventsListTicketTypes as EventsRepo["listTicketTypes"],
    ensureHostPermission: vi.fn(async () => true),
    upsertDraft: vi.fn(async () => {
      throw new Error("not implemented");
    }) as EventsRepo["upsertDraft"],
    publish: vi.fn(async () => {
      throw new Error("not implemented");
    }) as EventsRepo["publish"],
    setCategory: vi.fn(async () => {
      throw new Error("not implemented");
    }) as EventsRepo["setCategory"],
    setListingPriority: vi.fn(async () => ({ ...eventRecord })),
    filterByCategory: vi.fn(async () =>
      buildOffsetPaginatedResult({ items: [], total: 0, limit: 1, offset: 0 }),
    ),
    listPublishedByRegion: vi.fn(async () =>
      buildOffsetPaginatedResult({ items: [], total: 0, limit: 1, offset: 0 }),
    ),
    searchPublished: vi.fn(async () => []),
    listPublishedForSitemap: vi.fn(async () =>
      eventRecord.slug
        ? [{ slug: eventRecord.slug, updatedAt: eventRecord.updatedAt ?? null }]
        : [],
    ),
    updateVisibility: vi.fn(async () => ({ ...eventRecord })),
    updateGateType: vi.fn(async () => ({ ...eventRecord })),
    updatePassword: vi.fn(async () => ({ ...eventRecord })),
    updateWaitlistSettings: vi.fn(async () => ({ ...eventRecord })),
    getGateSettings: vi.fn(async () => ({
      eventId: eventRecord.id,
      visibility: eventRecord.visibility,
      gateType: eventRecord.gateType,
      passwordHash: eventRecord.passwordHash ?? null,
      passwordUpdatedAt: eventRecord.passwordUpdatedAt ?? null,
      waitlistStatus: eventRecord.waitlistStatus,
      waitlistPublishAt: eventRecord.waitlistPublishAt ?? null,
      waitlistDescription: eventRecord.waitlistDescription ?? null,
      waitlistCap: eventRecord.waitlistCap ?? null,
      payoutTermsId: null,
      resalePayoutTermsId: null,
      placeLayoutId: null,
    })),
    assignSlug: vi.fn(async () => {
      throw new Error("not implemented");
    }) as EventsRepo["assignSlug"],
    updateSlug: vi.fn(async () => {
      throw new Error("not implemented");
    }) as EventsRepo["updateSlug"],
    recordSlugHistory: vi.fn(async () => undefined),
    resolveBySlug: vi.fn(async () => null),
    getSlugContext: vi.fn(async () => null),
  };

  const seatsFindByIdsForUpdate = vi.fn(async () => []);
  const seatsUpdateStatuses = vi.fn(async () => undefined);

  const seatsRepo: SeatsRepo = {
    findByIdsForUpdate:
      seatsFindByIdsForUpdate as SeatsRepo["findByIdsForUpdate"],
    updateStatuses: seatsUpdateStatuses as SeatsRepo["updateStatuses"],
    reserveForHold: vi.fn(async () => []) as SeatsRepo["reserveForHold"],
    releaseSeats: vi.fn(async () => undefined) as SeatsRepo["releaseSeats"],
    releaseExpiredHolds: vi.fn(
      async () => 0,
    ) as SeatsRepo["releaseExpiredHolds"],
    listByEvent: vi.fn(async () => []) as SeatsRepo["listByEvent"],
    listAvailableBySection: vi.fn(
      async () => [],
    ) as SeatsRepo["listAvailableBySection"],
    getSectionById: vi.fn(async () => null) as SeatsRepo["getSectionById"],
    listSectionsByEvent: vi.fn(
      async () => [],
    ) as SeatsRepo["listSectionsByEvent"],
    materializeSections: vi.fn(async () => ({
      sectionsCreated: 0,
      seatsCreated: 0,
      sectionIdMap: {},
    })) as SeatsRepo["materializeSections"],
  };

  const promosRepo = {
    confirmHoldsForOrder: vi.fn(async () => []),
    releaseHoldsForOrder: vi.fn(async () => undefined),
    findActiveByCodes: vi.fn(async () => []),
    getRedemptionStats: vi.fn(async () => ({
      totalRedemptions: 0,
      redemptionsForHuman: 0,
    })),
    createHolds: vi.fn(async () => []),
    listHoldsForOrder: vi.fn(async () => []),
  };

  // Distinct objects for the tx and root surfaces, so an assertion can tell
  // which one the code actually reached: `settle` runs inside the tx,
  // stale-cart `release` runs post-commit on the ROOT repos.
  const txFeeWaiversRepo = {
    settle: vi.fn(async () => ({ settledTickets: 0 })),
    release: vi.fn(async () => ({ releasedTickets: 0 })),
  };
  const rootCreditsRepo = {
    releaseForOrder: vi.fn(async () => ({ releasedCents: 0, creditIds: [] })),
  };
  const rootFeeWaiversRepo = {
    settle: vi.fn(async () => ({ settledTickets: 0 })),
    release: vi.fn(async () => ({ releasedTickets: 0 })),
  };

  // A RESALE finalize credits the seller's HUMAN payee (resolved off the
  // listing's sellerHumanId); primary orders never read payees.
  const payeesRepo = {
    getBySubject: vi.fn(async () => ({ id: "payee-seller-1" })),
    upsertForSubject: vi.fn(),
  };

  const txRepos = {
    featuredEvents: {} as TxRepos["featuredEvents"],
    eventApplications: {} as TxRepos["eventApplications"],
    eventWaitlists: {} as TxRepos["eventWaitlists"],
    inviteLists: {} as TxRepos["inviteLists"],
    orders: ordersRepoImpl,
    orderItems: orderItemsRepo as any,
    agreements: agreementsRepo,
    payoutTerms: agreementsRepo,
    tickets: ticketsRepo,
    seats: seatsRepo,
    feePolicies: {} as any,
    promos: promosRepo,
    feeWaivers: txFeeWaiversRepo as any,
    splits: splitsRepo,
    audit: auditRepo,
    events: eventsRepo,
    payees: payeesRepo as any,
    settlements: {} as any,
    payeeLedger: payeeLedgerRepo as any,
    resaleListings: resaleListingsRepo as any,
    idempotency: {} as any,
    authz: {} as any,
    apiKeys: {} as any,
    organizations: {} as any,
    places: {} as any,
    savedLocations: {} as any,
    humans: {} as any,
    profiles: {} as any,
    categories: {
      listActive: vi.fn(),
      getBySlug: vi.fn(),
      getById: vi.fn(),
      upsertSeed: vi.fn(),
    } as any,
    eventTemplates: {
      listActive: vi.fn(),
      getBySlug: vi.fn(),
      getById: vi.fn(),
      upsertSeed: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    } as any,
    eventHumans: {} as any,
    ticketAttributions: {
      findByIdempotencyKey: vi.fn(async () => null),
      create: vi.fn(async () => ({}) as any),
      findByEventAndOrder: vi.fn(async () => null),
      listByEvent: vi.fn(async () => []),
      listByAttributedHuman: vi.fn(async () => []),
    },
    pushDevices: {} as any,
    notificationPrefs: {} as any,
    notificationDigests: {} as any,
    notifications: {} as TxRepos["notifications"],
    placeLayouts: {} as any,
    placeLayoutBlobs: {} as any,
    placeLayoutStatuses: {} as any,
  } as unknown as TxRepos;

  // The FIRST transaction is finalize's own; any later one is the post-commit
  // stale-cart retire, which opens a transaction per sibling. It gets the
  // "root" fee-waiver and credit mocks so a test can tell a release on the
  // (committed) finalize transaction from one in the sibling's own.
  //
  // The view also carries its OWN order and resale-listing spies (delegating
  // to the shared ones, so every existing assertion still sees the calls):
  // a call recorded on them can only have come through a post-commit
  // transaction, never finalize's. The finalize view has no `releaseHold`
  // at all, so a release there would throw.
  const cleanupOrders = {
    ...ordersRepoImpl,
    getById: vi.fn((id: string) => ordersRepoImpl.getById(id)),
    cancelPendingOrder: vi.fn(
      (...args: Parameters<OrdersRepo["cancelPendingOrder"]>) =>
        ordersRepoImpl.cancelPendingOrder(...args),
    ),
  };
  const cleanupResaleListings = {
    ...resaleListingsRepo,
    releaseHold: vi.fn(async () => ({
      released: true as const,
      listingStatus: "ACTIVE" as const,
    })),
  };
  const cleanupTxRepos = {
    ...txRepos,
    orders: cleanupOrders,
    resaleListings: cleanupResaleListings,
    feeWaivers: rootFeeWaiversRepo,
    credits: rootCreditsRepo,
  } as unknown as TxRepos;
  let finalizeTxOpened = false;
  const txMock = vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) => {
    if (finalizeTxOpened) return fn(cleanupTxRepos);
    finalizeTxOpened = true;
    return fn(txRepos);
  });

  const repos: Repos = {
    orders: ordersRepoImpl,
    orderItems: orderItemsRepo as any,
    agreements: agreementsRepo,
    payoutTerms: agreementsRepo,
    tickets: ticketsRepo,
    seats: seatsRepo,
    feePolicies: {} as any,
    promos: promosRepo,
    feeWaivers: rootFeeWaiversRepo as any,
    // Stale-cart retirement gives a sibling cart's platform credit back.
    credits: rootCreditsRepo as any,
    splits: splitsRepo,
    audit: auditRepo,
    events: eventsRepo,
    payees: payeesRepo as any,
    settlements: {} as any,
    payeeLedger: payeeLedgerRepo as any,
    resaleListings: resaleListingsRepo as any,
    idempotency: {} as any,
    authz: {} as any,
    apiKeys: {} as any,
    organizations: {} as any,
    places: {} as any,
    savedLocations: {} as any,
    humans: {} as any,
    profiles: {} as any,
    categories: txRepos.categories,
    eventTemplates: txRepos.eventTemplates,
    eventHumans: txRepos.eventHumans,
    pushDevices: txRepos.pushDevices,
    notificationPrefs: txRepos.notificationPrefs,
    notificationDigests: txRepos.notificationDigests,
    notifications: txRepos.notifications,
    featuredEvents: txRepos.featuredEvents,
    eventApplications: txRepos.eventApplications,
    eventWaitlists: txRepos.eventWaitlists,
    inviteLists: txRepos.inviteLists,
    placeLayouts: txRepos.placeLayouts,
    placeLayoutBlobs: txRepos.placeLayoutBlobs,
    placeLayoutStatuses: txRepos.placeLayoutStatuses,
    tx: txMock as Repos["tx"],
  } as unknown as Repos;

  const idempotencyStore = new Map<string, unknown>();

  const idempotencyBegin = vi.fn(async () => true);
  const idempotencyCommit = vi.fn(async (key: string, value: unknown) => {
    idempotencyStore.set(key, value);
  });
  const idempotencyFail = vi.fn(async () => undefined);
  const idempotencyRelease = vi.fn(async () => true);
  const idempotencyGet = vi.fn(
    async (key: string) => idempotencyStore.get(key) ?? null,
  );
  const idempotencyRun = vi.fn();

  const idempotency: IdempotencyPort = {
    begin: idempotencyBegin as IdempotencyPort["begin"],
    commit: idempotencyCommit as IdempotencyPort["commit"],
    fail: idempotencyFail as IdempotencyPort["fail"],
    release: idempotencyRelease as IdempotencyPort["release"],
    get: idempotencyGet as IdempotencyPort["get"],
    run: idempotencyRun as IdempotencyPort["run"],
    purgeExpired: async () => 0,
  };

  // Stale-cart retirement settles the sibling's PaymentIntent FIRST (same
  // helper as checkout's carried-over cart). Default: cancel succeeds.
  const paymentsCancelPaymentIntent = vi.fn(async () => ({ canceled: true }));
  const paymentsRetrievePaymentIntent = vi.fn(async () => ({
    status: "canceled" as const,
  }));
  const payments = {
    cancelPaymentIntent: paymentsCancelPaymentIntent,
    retrievePaymentIntent: paymentsRetrievePaymentIntent,
  } as unknown as NonNullable<FinalizePaymentIntentDeps["payments"]>;

  const deps: FinalizePaymentIntentDeps = {
    repos,
    idempotency,
    clock: { now: () => now },
    logger: createTestLogger(),
    payments,
  };

  return {
    deps,
    order,
    repos,
    txMock,
    mocks: {
      tx: txMock,
      cleanupTx: {
        orders: cleanupOrders,
        resaleListings: cleanupResaleListings,
      },
      agreements: agreementsRepo,
      orders: {
        getById: ordersGetById,
        linkPaymentIntent: ordersLinkPaymentIntent,
        markSucceeded: ordersMarkSucceeded,
        linkPaymentIntentIfPending: ordersLinkPaymentIntentIfPending,
        markSucceededIfOpen: ordersMarkSucceededIfOpen,
      },
      tickets: {
        create: ticketsCreate,
        getById: ticketsRepo.getById,
        reassignForResale: ticketsRepo.reassignForResale,
        transfer: ticketsRepo.transfer,
        countForOrderTicketType: ticketsRepo.countForOrderTicketType,
      },
      orderItems: orderItemsRepo,
      resaleListings: resaleListingsRepo,
      splits: {
        upsertForOrder: splitsUpsertForOrder,
        getForOrder: splitsRepo.getForOrder,
      },
      payeeLedger: {
        settlementCredit: payeeLedgerSettlementCredit,
      },
      audit: auditRepo,
      events: {
        listTicketTypes: eventsRepo.listTicketTypes,
        getById: eventsRepo.getById,
      },
      seats: {
        findByIdsForUpdate: seatsRepo.findByIdsForUpdate,
        updateStatuses: seatsRepo.updateStatuses,
      },
      idempotency: {
        begin: idempotencyBegin,
        commit: idempotencyCommit,
        fail: idempotencyFail,
        release: idempotencyRelease,
        get: idempotencyGet,
        run: idempotencyRun,
        store: idempotencyStore,
        purgeExpired: async () => 0,
      },
      promos: promosRepo,
      feeWaivers: rootFeeWaiversRepo as any,
      txFeeWaivers: txFeeWaiversRepo as any,
      staleCarts: {
        listOtherPending: ordersListOtherPending,
        cancelPendingOrder: ordersCancelPendingOrder,
      },
      credits: rootCreditsRepo,
      payments: {
        cancelPaymentIntent: paymentsCancelPaymentIntent,
        retrievePaymentIntent: paymentsRetrievePaymentIntent,
      },
    },
    stripeEvent: makeStripeEvent(5500),
  } as const;
}

describe("finalizePaymentIntent", () => {
  it("marks the order succeeded, issues tickets, and writes splits", async () => {
    const ctx = makeContext();

    const result = await finalizePaymentIntent(ctx.deps, {
      stripeEvent: ctx.stripeEvent,
    });

    expect(result).toEqual({ ok: true, orderId: DEFAULT_ORDER_ID });
    expect(ctx.mocks.orders.markSucceededIfOpen).toHaveBeenCalledWith(
      DEFAULT_ORDER_ID,
    );
    // Linked through the CAS (PENDING/PROCESSING, no other PI).
    expect(ctx.mocks.orders.linkPaymentIntentIfPending).toHaveBeenCalledWith(
      DEFAULT_ORDER_ID,
      DEFAULT_PAYMENT_INTENT_ID,
      { allowProcessing: true },
    );
    expect(ctx.mocks.orders.linkPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.mocks.tickets.create).toHaveBeenCalledTimes(2);
    expect(ctx.mocks.tickets.create).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: DEFAULT_ORDER_ID,
        ticketTypeId: "ticket-type-1",
      }),
    );
    // This order's snapshot has no `organiserCredit` marker (sold before the
    // 2026-10-11 ruling), so `computeAgreementBasis` is gross 5000 − platform
    // fee 500 = 4500. 70/30 of 4500 = 3150/1350.
    expect(ctx.mocks.splits.upsertForOrder).toHaveBeenCalledWith(
      DEFAULT_ORDER_ID,
      expect.arrayContaining([
        { payeeId: "payee-1", amountCents: 3150 },
        { payeeId: "payee-2", amountCents: 1350 },
      ]),
    );
    const recordedSplits = ctx.mocks.splits.upsertForOrder.mock
      .calls[0]?.[1] as
      | Array<{ payeeId: string; amountCents: number }>
      | undefined;
    expect(recordedSplits).toBeDefined();
    expect(recordedSplits!).toHaveLength(2);
    expect(ctx.mocks.audit.log).toHaveBeenCalledTimes(4); // order.succeeded + waivers + splits + ticket.attribution.recorded
    expect(ctx.mocks.idempotency.begin).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.idempotency.commit).toHaveBeenCalledTimes(1);
  });

  // Owner ruling 2026-10-11 (docs/specs/2026-10-11/platform-fee-charged-once.spec.yaml):
  // the platform fee is taken once. An order whose snapshot is marked
  // `organiserCredit: "FULL_PRICE"` credits the full ticket money; an order
  // without the marker was sold before the ruling and keeps gross − fee.
  const splitsWritten = (ctx: ReturnType<typeof makeContext>) =>
    ctx.mocks.splits.upsertForOrder.mock.calls[0]?.[1] as Array<{
      payeeId: string;
      amountCents: number;
    }>;
  const sumOf = (rows: Array<{ amountCents: number }>) =>
    rows.reduce((sum, row) => sum + row.amountCents, 0);

  it("a FULL_PRICE order writes splits that sum to the gross: the fee is not taken from the organiser", async () => {
    const ctx = makeContext();
    ctx.order.feePolicySnapshot = {
      payoutTermsId: "agreement-1",
      feeMode: "PASS_THROUGH",
      organiserCredit: "FULL_PRICE",
    };

    const result = await finalizePaymentIntent(ctx.deps, {
      stripeEvent: ctx.stripeEvent,
    });

    expect(result).toEqual({ ok: true, orderId: DEFAULT_ORDER_ID });
    const splits = splitsWritten(ctx);
    // 70/30 of the full 5000 gross, not of 5000 − 500.
    expect(splits).toEqual(
      expect.arrayContaining([
        { payeeId: "payee-1", amountCents: 3500 },
        { payeeId: "payee-2", amountCents: 1500 },
      ]),
    );
    expect(splits).toHaveLength(2);
    expect(sumOf(splits)).toBe(ctx.order.amountGrossCents);
    expect(sumOf(splits)).toBe(5000);
  });

  it.each([
    ["no marker (the pre-ruling snapshot shape)", { feeMode: "PASS_THROUGH" }],
    ["an empty snapshot", {}],
    ["a null snapshot", null],
    ["an unknown marker value", { organiserCredit: "SOMETHING_ELSE" }],
  ])(
    "an order with %s writes splits that sum to gross − fee, as it was sold",
    async (_name, snapshot) => {
      const ctx = makeContext();
      ctx.order.feePolicySnapshot = snapshot;

      await finalizePaymentIntent(ctx.deps, { stripeEvent: ctx.stripeEvent });

      const splits = splitsWritten(ctx);
      expect(splits).toEqual(
        expect.arrayContaining([
          { payeeId: "payee-1", amountCents: 3150 },
          { payeeId: "payee-2", amountCents: 1350 },
        ]),
      );
      expect(sumOf(splits)).toBe(
        ctx.order.amountGrossCents - ctx.order.feesPlatformCents,
      );
      expect(sumOf(splits)).toBe(4500);
    },
  );

  it("a transient failure after the tx RELEASES the claim (owner token) and a replay lands on alreadyFinalized without re-minting", async () => {
    // lib/idempotency-claim.ts: the webhook acknowledges every verified event
    // with 200, so the DLQ replay is the only retry — a `failed:` marker
    // would refuse it for 15 minutes. Here the tx commits, then `commit`
    // (the idempotency store) rejects once.
    const ctx = makeContext();
    ctx.mocks.idempotency.commit.mockRejectedValueOnce(new Error("redis blip"));

    await expect(
      finalizePaymentIntent(ctx.deps, { stripeEvent: ctx.stripeEvent }),
    ).rejects.toMatchObject({ code: "dependency_failed" });

    expect(ctx.mocks.idempotency.fail).not.toHaveBeenCalled();
    expect(ctx.mocks.idempotency.release).toHaveBeenCalledTimes(1);
    const [beginKey, , beginToken] = ctx.mocks.idempotency.begin.mock.calls[0] as [
      string,
      number,
      string,
    ];
    expect(beginToken).toEqual(expect.any(String));
    expect(ctx.mocks.idempotency.release).toHaveBeenCalledWith(beginKey, beginToken);
    expect(ctx.mocks.orders.markSucceededIfOpen).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.tickets.create).toHaveBeenCalledTimes(2);

    // The replay: the order is already SUCCEEDED, so the internal path
    // short-circuits on `alreadyFinalized` (internal to the tx; the public
    // output is the same `{ ok, orderId }`) — no second mint, no second
    // markSucceeded.
    const replay = await finalizePaymentIntent(ctx.deps, {
      stripeEvent: ctx.stripeEvent,
    });
    expect(replay).toEqual({ ok: true, orderId: DEFAULT_ORDER_ID });
    expect(ctx.mocks.orders.markSucceededIfOpen).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.tickets.create).toHaveBeenCalledTimes(2);
    expect(ctx.mocks.idempotency.begin).toHaveBeenCalledTimes(2);
    expect(ctx.mocks.idempotency.commit).toHaveBeenCalledTimes(2);
  });

  it("writes SETTLEMENT_CREDIT ledger entries per payee after finalization", async () => {
    const ctx = makeContext();
    // Make the credit path resolvable: terms row + committed splits readable.
    ctx.mocks.agreements.getById.mockResolvedValue({
      id: "agreement-1",
      payoutSchedule: "WEEK_OF_EVENT",
    });
    ctx.mocks.splits.getForOrder.mockResolvedValue([
      { orderSplitId: "split-1", payeeId: "payee-1", amountCents: 3150 },
      { orderSplitId: "split-2", payeeId: "payee-2", amountCents: 1350 },
    ]);
    // The order in this harness carries no disputeStatus; SUCCEEDED is set by
    // the finalize tx before the credit write runs post-commit.

    const result = await finalizePaymentIntent(ctx.deps, {
      stripeEvent: ctx.stripeEvent,
    });

    expect(result).toEqual({ ok: true, orderId: DEFAULT_ORDER_ID });
    expect(ctx.mocks.payeeLedger.settlementCredit).toHaveBeenCalledTimes(2);
    expect(ctx.mocks.payeeLedger.settlementCredit).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `settlement-credit:${DEFAULT_ORDER_ID}:payee-1`,
        payeeId: "payee-1",
        amountCents: 3150,
        currency: "usd",
        orderId: DEFAULT_ORDER_ID,
        sourceKind: "order_split",
        sourceId: DEFAULT_ORDER_ID,
        metadata: { items: { "item-1": 3150 } },
      }),
    );
    expect(ctx.mocks.payeeLedger.settlementCredit).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `settlement-credit:${DEFAULT_ORDER_ID}:payee-2`,
        payeeId: "payee-2",
        amountCents: 1350,
      }),
    );
  });

  // Split rows that do not add up to the basis are invisible by construction:
  // they are written, credited from, and then checked against THEMSELVES by
  // `verifyLedgerInvariants`. Only an explicit report can surface it.
  it("reports split rows that fall short of the basis, without failing the order", async () => {
    const ctx = makeContext();
    const reportError = vi.fn();
    ctx.deps.reportError = reportError;
    // Pre-gate terms: EVERY line capped, ceilings summing to 40% of the basis.
    // (`SPLITS_CAPS_UNSATISFIABLE` refuses this shape at publish and at every
    // terms editor now, but terms stored before those gates can still be in
    // force on a live event.)
    ctx.mocks.agreements.listLines.mockResolvedValue([
      {
        id: "line-1",
        agreementId: "agreement-1",
        payeeId: "payee-1",
        percent: 70,
        floorCents: 0,
        capPercent: 10,
        priority: 0,
        rounding: "FLOOR" as const,
      },
      {
        id: "line-2",
        agreementId: "agreement-1",
        payeeId: "payee-2",
        percent: 30,
        floorCents: 0,
        capPercent: 30,
        priority: 1,
        rounding: "FLOOR" as const,
      },
    ]);

    const result = await finalizePaymentIntent(ctx.deps, {
      stripeEvent: ctx.stripeEvent,
    });

    // The buyer has already been charged: finalization must NOT fail.
    expect(result).toEqual({ ok: true, orderId: DEFAULT_ORDER_ID });

    // Basis 4500. Ceilings: 10% → 450, 30% → 1350. 2700c unallocated.
    expect(ctx.mocks.splits.upsertForOrder).toHaveBeenCalledWith(
      DEFAULT_ORDER_ID,
      expect.arrayContaining([
        { payeeId: "payee-1", amountCents: 450 },
        { payeeId: "payee-2", amountCents: 1350 },
      ]),
    );

    const shortReports = reportError.mock.calls.filter(
      ([, context]) =>
        (context as { tags?: Record<string, string> } | undefined)?.tags
          ?.reason === "splits_short_of_basis",
    );
    expect(shortReports).toHaveLength(1);
    expect(shortReports[0]?.[1]).toMatchObject({
      tags: {
        useCase: "finalizePaymentIntent",
        reason: "splits_short_of_basis",
      },
      extra: expect.objectContaining({
        orderId: DEFAULT_ORDER_ID,
        basisCents: 4500,
        splitsTotalCents: 1800,
        unallocatedCents: 2700,
      }),
    });
  });

  it.each([
    ["an unknown organiserCredit value", { organiserCredit: "HALF" }, 1],
    ["no organiserCredit key (sold before the ruling)", {}, 0],
    ["the FULL_PRICE marker", { organiserCredit: "FULL_PRICE" }, 0],
  ] as const)(
    "with %s, reports organiser_credit_unknown %s time(s) after the commit",
    async (_label, snapshot, expected) => {
      const ctx = makeContext();
      const reportError = vi.fn();
      ctx.deps.reportError = reportError;
      ctx.order.feePolicySnapshot = { ...snapshot };

      const result = await finalizePaymentIntent(ctx.deps, {
        stripeEvent: ctx.stripeEvent,
      });

      // Never fails the order: the buyer has already been charged.
      expect(result).toEqual({ ok: true, orderId: DEFAULT_ORDER_ID });
      const reports = reportError.mock.calls.filter(
        ([, context]) =>
          (context as { tags?: Record<string, string> } | undefined)?.tags
            ?.reason === "organiser_credit_unknown",
      );
      expect(reports).toHaveLength(expected);
      if (expected > 0) {
        expect(reports[0]?.[1]).toMatchObject({
          tags: {
            useCase: "finalizePaymentIntent",
            reason: "organiser_credit_unknown",
          },
          extra: expect.objectContaining({
            orderId: DEFAULT_ORDER_ID,
            organiserCredit: "HALF",
          }),
        });
      }
    },
  );

  it("says nothing when the splits DO sum to the basis", async () => {
    const ctx = makeContext();
    const reportError = vi.fn();
    ctx.deps.reportError = reportError;

    await finalizePaymentIntent(ctx.deps, { stripeEvent: ctx.stripeEvent });

    expect(
      reportError.mock.calls.filter(
        ([, context]) =>
          (context as { tags?: Record<string, string> } | undefined)?.tags
            ?.reason === "splits_short_of_basis",
      ),
    ).toHaveLength(0);
  });

  it("swallows a ledger-credit failure but reports it via reportError", async () => {
    const ctx = makeContext();
    const reportError = vi.fn();
    ctx.deps.reportError = reportError;
    // Default harness: payoutTerms.getById resolves undefined, so the credit
    // write fails with AGREEMENT_NOT_FOUND inside the deliberate swallow.

    const result = await finalizePaymentIntent(ctx.deps, {
      stripeEvent: ctx.stripeEvent,
    });

    // The finalization itself is unharmed…
    expect(result).toEqual({ ok: true, orderId: DEFAULT_ORDER_ID });
    expect(ctx.mocks.payeeLedger.settlementCredit).not.toHaveBeenCalled();
    // …and the swallow reached Sentry with the tagged context.
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "AGREEMENT_NOT_FOUND" }),
      expect.objectContaining({
        tags: {
          useCase: "finalizePaymentIntent",
          step: "createLedgerCredits",
        },
        extra: expect.objectContaining({ orderId: DEFAULT_ORDER_ID }),
      }),
    );
  });

  it("never lets a throwing reporter break the finalization", async () => {
    const ctx = makeContext();
    ctx.deps.reportError = vi.fn(() => {
      throw new Error("sentry down");
    });

    const result = await finalizePaymentIntent(ctx.deps, {
      stripeEvent: ctx.stripeEvent,
    });

    expect(result).toEqual({ ok: true, orderId: DEFAULT_ORDER_ID });
  });

  it("finalizes a resale order without recording a duplicate transfer", async () => {
    const ctx = makeContext();
    ctx.order.source = "RESALE";
    ctx.order.parentOrderId = "parent-order-1";
    ctx.stripeEvent.data.object.metadata.source = "resale";
    ctx.order.items = [
      {
        ...ctx.order.items[0],
        qty: 1,
        resaleListingId: "resale-listing-1",
        meta: {
          buyerTotalCents: 5500,
          resaleListingId: "resale-listing-1",
        },
        // Checkout's pricing snapshot, consistent with the 4500 basis
        // (gross 5000 − fee 500): a share of 0 → all to the seller.
        resaleFaceValueCents: 4500,
        eventShareCents: 0,
        sharePayer: "SELLER",
      },
    ];
    ctx.mocks.agreements.listByEvent.mockResolvedValue([
      {
        id: "agreement-resale-1",
        kind: "RESALE",
        status: "ACTIVE",
        feeMode: null,
        feePolicyId: null,
        payoutSchedule: "WEEK_OF_EVENT",
        isDefault: false,
        settlementCurrency: "usd",
        version: 1,
        createdAt: new Date("2025-03-01T12:00:00.000Z"),
        updatedAt: new Date("2025-03-01T12:00:00.000Z"),
      },
    ]);
    // Finalize resolves RESALE terms the way checkout priced them — off the
    // listing (`listing.resalePayoutTermsId ?? event.resalePayoutTermsId`).
    ctx.mocks.resaleListings.getById.mockImplementation(async () => ({
      id: "resale-listing-1",
      ticketId: "resale-ticket-1",
      sellerHumanId: "seller-1",
      status: "HELD",
      buyerOrderId: null,
      resalePayoutTermsId: "agreement-resale-1",
    }));
    ctx.mocks.agreements.getById.mockImplementation(async (id: string) =>
      id === "agreement-resale-1"
        ? ((await ctx.mocks.agreements.listByEvent("")) as any)[0]
        : null,
    );

    const result = await finalizePaymentIntent(ctx.deps, {
      stripeEvent: ctx.stripeEvent,
    });

    expect(result).toEqual({ ok: true, orderId: DEFAULT_ORDER_ID });
    expect(ctx.mocks.orders.markSucceededIfOpen).toHaveBeenCalledWith(
      DEFAULT_ORDER_ID,
    );
    expect(ctx.mocks.tickets.create).not.toHaveBeenCalled();
    expect(ctx.mocks.resaleListings.getById).toHaveBeenCalledWith(
      "resale-listing-1",
    );
    expect(ctx.mocks.resaleListings.commit).toHaveBeenCalledWith(
      "resale-listing-1",
      "buyer-1",
      DEFAULT_ORDER_ID,
    );
    expect(ctx.mocks.tickets.transfer).not.toHaveBeenCalled();
    expect(ctx.mocks.tickets.reassignForResale).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketId: "resale-ticket-1",
        newOrderId: DEFAULT_ORDER_ID,
        newOrderItemId: "item-1",
      }),
    );
    expect(ctx.mocks.orderItems.updateStatus).toHaveBeenCalledWith(
      "resale-original-item-1",
      "transferred",
      expect.any(Date),
    );
    expect(ctx.mocks.orderItems.setResaleListingId).toHaveBeenCalledWith(
      "resale-original-item-1",
      null,
    );
    // The seller's share is written as their own split row (full coverage in
    // finalize-resale-seller-credit.test.ts).
    expect(ctx.mocks.splits.upsertForOrder).toHaveBeenCalledWith(
      DEFAULT_ORDER_ID,
      expect.arrayContaining([
        { payeeId: "payee-seller-1", amountCents: 4500 },
      ]),
    );
  });

  it("returns cached response without re-running when idempotency hit", async () => {
    const ctx = makeContext();

    const first = await finalizePaymentIntent(ctx.deps, {
      stripeEvent: ctx.stripeEvent,
    });

    ctx.mocks.orders.markSucceeded.mockClear();
    ctx.mocks.tickets.create.mockClear();
    ctx.mocks.splits.upsertForOrder.mockClear();
    ctx.txMock.mockClear();
    ctx.mocks.idempotency.begin.mockClear();
    ctx.mocks.idempotency.commit.mockClear();

    const second = await finalizePaymentIntent(ctx.deps, {
      stripeEvent: ctx.stripeEvent,
    });

    expect(second).toEqual(first);
    expect(ctx.txMock).not.toHaveBeenCalled();
    expect(ctx.mocks.idempotency.begin).not.toHaveBeenCalled();
    expect(ctx.mocks.idempotency.commit).not.toHaveBeenCalled();
  });

  it("rejects when the payment currency does not match", async () => {
    const ctx = makeContext();
    const stripeEvent = makeStripeEvent(5500, "eur");

    await expect(
      finalizePaymentIntent(ctx.deps, { stripeEvent }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: "currency_mismatch",
      expectedCurrency: "usd",
      paymentCurrency: "eur",
    });

    expect(ctx.mocks.orders.markSucceededIfOpen).not.toHaveBeenCalled();
    expect(ctx.mocks.tickets.create).not.toHaveBeenCalled();
  });

  it("rejects when the payment amount does not match", async () => {
    const ctx = makeContext();
    const stripeEvent = makeStripeEvent(9999);

    await expect(
      finalizePaymentIntent(ctx.deps, { stripeEvent }),
    ).rejects.toMatchObject({ code: "AMOUNT_MISMATCH" });

    expect(ctx.mocks.orders.markSucceededIfOpen).not.toHaveBeenCalled();
    expect(ctx.mocks.tickets.create).not.toHaveBeenCalled();
    expect(ctx.mocks.idempotency.commit).not.toHaveBeenCalled();
  });

  it("includes taxAmountCents in expected amount (non-zero tax)", async () => {
    const ctx = makeContext();
    // Order has buyerTotalCents=5500 in item meta + 400 tax = 5900 expected
    ctx.order.taxAmountCents = 400;

    // Amount matches items + tax → succeeds
    const stripeEvent = makeStripeEvent(5900);
    const result = await finalizePaymentIntent(ctx.deps, { stripeEvent });
    expect(result).toEqual({ ok: true, orderId: DEFAULT_ORDER_ID });
    expect(ctx.mocks.orders.markSucceededIfOpen).toHaveBeenCalled();
  });

  it("rejects when payment covers items but not tax", async () => {
    const ctx = makeContext();
    ctx.order.taxAmountCents = 400;

    // 5500 matches items only, missing the 400 tax
    const stripeEvent = makeStripeEvent(5500);
    await expect(
      finalizePaymentIntent(ctx.deps, { stripeEvent }),
    ).rejects.toMatchObject({ code: "AMOUNT_MISMATCH" });

    expect(ctx.mocks.orders.markSucceededIfOpen).not.toHaveBeenCalled();
  });

  it("throws conflict when order status is not processable", async () => {
    const ctx = makeContext();
    ctx.order.status = "CANCELLED";

    await expect(
      finalizePaymentIntent(ctx.deps, { stripeEvent: ctx.stripeEvent }),
    ).rejects.toMatchObject({ code: "ORDER_NOT_PROCESSABLE" });

    expect(ctx.mocks.orders.markSucceededIfOpen).not.toHaveBeenCalled();
    expect(ctx.mocks.tickets.create).not.toHaveBeenCalled();
  });

  // ── Stale read: a canceller commits after finalize read the order ───────
  // Belt-and-braces (createCheckout only issues a client secret after its own
  // link CAS wins), but a stale PENDING read must never resurrect a CANCELLED
  // order whose credit and seats were already handed back.
  const cancelRightAfterTheRead = (ctx: ReturnType<typeof makeContext>) => {
    // Finalize logs through a scoped child; hand back the same spy.
    vi.mocked(ctx.deps.logger!.child).mockReturnValue(ctx.deps.logger!);
    const original = ctx.mocks.orders.getById.getMockImplementation()!;
    let reads = 0;
    ctx.mocks.orders.getById.mockImplementation(async (id: string) => {
      const snapshot = await original(id);
      reads++;
      // The first read (finalize's) sees PENDING; the retire / reaper commits
      // CANCELLED immediately after it.
      if (reads === 1) ctx.order.status = "CANCELLED";
      return snapshot;
    });
  };

  it("a stale PENDING read cannot link + succeed a CANCELLED order: refused loudly, nothing minted", async () => {
    const ctx = makeContext();
    cancelRightAfterTheRead(ctx);

    await expect(
      finalizePaymentIntent(ctx.deps, { stripeEvent: ctx.stripeEvent }),
    ).rejects.toMatchObject({ code: "ORDER_NOT_PROCESSABLE" });

    expect(ctx.mocks.orders.linkPaymentIntentIfPending).toHaveBeenCalledTimes(
      1,
    );
    expect(ctx.order.status).toBe("CANCELLED");
    expect(ctx.order.stripePaymentIntentId).toBeNull();
    expect(ctx.mocks.orders.markSucceededIfOpen).not.toHaveBeenCalled();
    expect(ctx.mocks.tickets.create).not.toHaveBeenCalled();
    expect(ctx.deps.logger!.error).toHaveBeenCalledWith(
      "finalizePaymentIntent.order_cas_lost",
      expect.objectContaining({ step: "link", status: "CANCELLED" }),
    );
  });

  it("an already-linked order cancelled after the read cannot be marked SUCCEEDED: refused loudly, nothing minted", async () => {
    const ctx = makeContext();
    ctx.order.stripePaymentIntentId = DEFAULT_PAYMENT_INTENT_ID;
    cancelRightAfterTheRead(ctx);

    await expect(
      finalizePaymentIntent(ctx.deps, { stripeEvent: ctx.stripeEvent }),
    ).rejects.toMatchObject({ code: "ORDER_NOT_PROCESSABLE" });

    expect(ctx.mocks.orders.markSucceededIfOpen).toHaveBeenCalledTimes(1);
    expect(ctx.order.status).toBe("CANCELLED");
    expect(ctx.mocks.tickets.create).not.toHaveBeenCalled();
    expect(ctx.deps.logger!.error).toHaveBeenCalledWith(
      "finalizePaymentIntent.order_cas_lost",
      expect.objectContaining({ step: "succeed", status: "CANCELLED" }),
    );
  });

  // ── Two legitimate finalizers for the same payment ───────────────────────
  // The client confirm (`client_confirm_<pi>`) and the
  // `payment_intent.succeeded` webhook (`<evt>`) hold DIFFERENT idempotency
  // keys, so both can be inside finalize at once. Both read the open order;
  // the first wins the CAS, mints and commits; the second must land on the
  // idempotent replay — no throw, no second mint, no DLQ.
  const otherFinalizerWinsDuringTheRead = (
    ctx: ReturnType<typeof makeContext>,
  ) => {
    vi.mocked(ctx.deps.logger!.child).mockReturnValue(ctx.deps.logger!);
    const original = ctx.mocks.orders.getById.getMockImplementation()!;
    let reads = 0;
    ctx.mocks.orders.getById.mockImplementation(async (id: string) => {
      reads++;
      const snapshot = await original(id);
      if (reads === 1) {
        // B has its (open) snapshot; A now runs to completion.
        await finalizePaymentIntent(ctx.deps, {
          stripeEvent: {
            ...ctx.stripeEvent,
            id: `client_confirm_${DEFAULT_PAYMENT_INTENT_ID}`,
          },
        });
      }
      return snapshot;
    });
  };

  it.each([
    ["the link CAS (order read before any PI was linked)", null, "link"],
    [
      "the SUCCEEDED CAS (order already linked when read)",
      DEFAULT_PAYMENT_INTENT_ID,
      "succeed",
    ],
  ] as const)(
    "a second finalizer that loses %s replays: no throw, one mint",
    async (_label, linkedAtRead, step) => {
      const ctx = makeContext();
      ctx.order.stripePaymentIntentId = linkedAtRead;
      otherFinalizerWinsDuringTheRead(ctx);

      await expect(
        finalizePaymentIntent(ctx.deps, { stripeEvent: ctx.stripeEvent }),
      ).resolves.toEqual({ ok: true, orderId: DEFAULT_ORDER_ID });

      expect(ctx.order.status).toBe("SUCCEEDED");
      expect(ctx.order.stripePaymentIntentId).toBe(DEFAULT_PAYMENT_INTENT_ID);
      // A minted its 2 tickets; B minted none.
      expect(ctx.mocks.tickets.create).toHaveBeenCalledTimes(2);
      expect(ctx.mocks.splits.upsertForOrder).toHaveBeenCalledTimes(1);
      expect(ctx.deps.logger!.error).not.toHaveBeenCalledWith(
        "finalizePaymentIntent.order_cas_lost",
        expect.anything(),
      );
      expect(ctx.deps.logger!.info).toHaveBeenCalledWith(
        "finalizePaymentIntent.concurrent_finalize_replay",
        expect.objectContaining({ step }),
      );
      // Both claims complete; neither is marked failed.
      expect(ctx.mocks.idempotency.commit).toHaveBeenCalledTimes(2);
      expect(ctx.mocks.idempotency.fail).not.toHaveBeenCalled();
    },
  );

  it("a lost CAS to an order SUCCEEDED under a DIFFERENT PaymentIntent is still refused loudly", async () => {
    const ctx = makeContext();
    vi.mocked(ctx.deps.logger!.child).mockReturnValue(ctx.deps.logger!);
    const original = ctx.mocks.orders.getById.getMockImplementation()!;
    let reads = 0;
    ctx.mocks.orders.getById.mockImplementation(async (id: string) => {
      const snapshot = await original(id);
      reads++;
      if (reads === 1) {
        ctx.order.status = "SUCCEEDED";
        ctx.order.stripePaymentIntentId = "pi_someone_else";
      }
      return snapshot;
    });

    await expect(
      finalizePaymentIntent(ctx.deps, { stripeEvent: ctx.stripeEvent }),
    ).rejects.toMatchObject({ code: "PAYMENT_INTENT_MISMATCH" });
    expect(ctx.mocks.tickets.create).not.toHaveBeenCalled();
    expect(ctx.deps.logger!.error).toHaveBeenCalledWith(
      "finalizePaymentIntent.order_cas_lost",
      expect.objectContaining({ step: "link", status: "SUCCEEDED" }),
    );
  });

  it("a re-delivered succeeded event for a SUCCEEDED order with NO linked PI replays instead of failing the link CAS", async () => {
    // Legacy rows / a P2002 the old unconditional link swallowed. The link
    // CAS only matches PENDING/PROCESSING, so it must not run for a
    // SUCCEEDED row.
    const ctx = makeContext();
    ctx.order.status = "SUCCEEDED";
    ctx.order.stripePaymentIntentId = null;

    await expect(
      finalizePaymentIntent(ctx.deps, { stripeEvent: ctx.stripeEvent }),
    ).resolves.toEqual({ ok: true, orderId: DEFAULT_ORDER_ID });

    expect(ctx.mocks.orders.linkPaymentIntentIfPending).not.toHaveBeenCalled();
    expect(ctx.mocks.orders.markSucceededIfOpen).not.toHaveBeenCalled();
    expect(ctx.mocks.tickets.create).not.toHaveBeenCalled();
    expect(ctx.mocks.idempotency.commit).toHaveBeenCalledTimes(1);
  });

  // ── Promo hold confirmation ──────────────────────────────────────────────

  it("confirms promo holds inside the finalization transaction", async () => {
    const ctx = makeContext();

    await finalizePaymentIntent(ctx.deps, { stripeEvent: ctx.stripeEvent });

    expect(ctx.mocks.promos.confirmHoldsForOrder).toHaveBeenCalledWith({
      orderId: DEFAULT_ORDER_ID,
      confirmedAt: expect.any(Date),
    });
  });

  // ── Stale cart cleanup ──────────────────────────────────────────────────

  it("cancels stale PENDING orders for the same buyer+event after success", async () => {
    const ctx = makeContext();
    const staleOrderId = "33333333-3333-4333-8333-333333333333";
    ctx.mocks.staleCarts.listOtherPending.mockResolvedValue([
      { id: staleOrderId, stripePaymentIntentId: "pi_stale" },
    ]);

    await finalizePaymentIntent(ctx.deps, { stripeEvent: ctx.stripeEvent });

    expect(ctx.mocks.staleCarts.listOtherPending).toHaveBeenCalledWith({
      buyerHumanId: "buyer-1",
      eventId: DEFAULT_EVENT_ID,
      excludeOrderId: DEFAULT_ORDER_ID,
    });
    // The sibling's PaymentIntent is cancelled and proven dead BEFORE the
    // order is cancelled: a PI left confirmable under a CANCELLED order is
    // one the buyer's other tab can still pay — and nothing would mint.
    expect(ctx.mocks.payments.cancelPaymentIntent).toHaveBeenCalledWith({
      paymentIntentId: "pi_stale",
    });
    expect(
      ctx.mocks.payments.cancelPaymentIntent.mock.invocationCallOrder[0],
    ).toBeLessThan(
      ctx.mocks.staleCarts.cancelPendingOrder.mock.invocationCallOrder[0]!,
    );
    expect(ctx.mocks.staleCarts.cancelPendingOrder).toHaveBeenCalledWith(
      staleOrderId,
      { expectedPaymentIntentId: "pi_stale" },
    );
    expect(ctx.mocks.promos.releaseHoldsForOrder).toHaveBeenCalledWith(
      staleOrderId,
    );
    // The stale cart reserved fee-waiver allowance at checkout. Once it is
    // CANCELLED the expiry reaper never visits it, so this is the only place
    // that allowance can come back to the buyer.
    expect(ctx.mocks.feeWaivers.release).toHaveBeenCalledWith(staleOrderId);
    // ...and its platform credit, which was SPENT at checkout, not held.
    expect(ctx.mocks.credits.releaseForOrder).toHaveBeenCalledWith(staleOrderId);
    // Cleanup runs post-commit in the sibling's own transaction, never on
    // finalize's (closed) one.
    expect(ctx.mocks.txFeeWaivers.release).not.toHaveBeenCalled();
    expect(ctx.mocks.txFeeWaivers.settle).toHaveBeenCalledWith(DEFAULT_ORDER_ID);
  });

  it("keeps a stale cart PENDING when its PaymentIntent already succeeded", async () => {
    // Two tabs, both paid within the same window: the second tab's PI is
    // not cancellable. Cancelling ITS order would strand a real charge, so
    // the cart is left for its own webhook to finalize.
    const ctx = makeContext();
    const staleOrderId = "33333333-3333-4333-8333-333333333333";
    ctx.mocks.staleCarts.listOtherPending.mockResolvedValue([
      { id: staleOrderId, stripePaymentIntentId: "pi_stale" },
    ]);
    ctx.mocks.payments.cancelPaymentIntent.mockResolvedValue({ canceled: false });
    ctx.mocks.payments.retrievePaymentIntent.mockResolvedValue({
      status: "succeeded",
    } as never);
    const reportError = vi.fn();
    ctx.deps.reportError = reportError;

    const result = await finalizePaymentIntent(ctx.deps, {
      stripeEvent: ctx.stripeEvent,
    });

    expect(result).toMatchObject({ ok: true });
    expect(ctx.mocks.staleCarts.cancelPendingOrder).not.toHaveBeenCalled();
    expect(ctx.mocks.promos.releaseHoldsForOrder).not.toHaveBeenCalledWith(
      staleOrderId,
    );
    expect(ctx.mocks.feeWaivers.release).not.toHaveBeenCalledWith(staleOrderId);
    // The refusal is reported (a live charge on a cart we wanted gone).
    expect(
      reportError.mock.calls.some(
        ([, meta]) =>
          (meta as { tags?: { step?: string } }).tags?.step ===
          "retireCarriedOverCart",
      ),
    ).toBe(true);
  });

  it("keeps a stale cart PENDING when no payment processor is available", async () => {
    // De-holding a live PI is the unsafe direction; with no processor the
    // helper cannot prove the PI dead, so it must refuse rather than cancel.
    const ctx = makeContext();
    const staleOrderId = "33333333-3333-4333-8333-333333333333";
    ctx.mocks.staleCarts.listOtherPending.mockResolvedValue([
      { id: staleOrderId, stripePaymentIntentId: "pi_stale" },
    ]);
    ctx.deps.payments = null;
    const reportError = vi.fn();
    ctx.deps.reportError = reportError;

    const result = await finalizePaymentIntent(ctx.deps, {
      stripeEvent: ctx.stripeEvent,
    });

    expect(result).toMatchObject({ ok: true });
    expect(ctx.mocks.staleCarts.cancelPendingOrder).not.toHaveBeenCalled();
    expect(
      reportError.mock.calls.some(
        ([err]) =>
          (err as Error).message === "carried_over_cart_pi_uncancellable_no_processor",
      ),
    ).toBe(true);
  });

  it("a stale cart with no PaymentIntent is cancelled without touching Stripe", async () => {
    const ctx = makeContext();
    const staleOrderId = "33333333-3333-4333-8333-333333333333";
    ctx.mocks.staleCarts.listOtherPending.mockResolvedValue([
      { id: staleOrderId, stripePaymentIntentId: null },
    ]);

    await finalizePaymentIntent(ctx.deps, { stripeEvent: ctx.stripeEvent });

    expect(ctx.mocks.payments.cancelPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.mocks.staleCarts.cancelPendingOrder).toHaveBeenCalledWith(
      staleOrderId,
      { expectedPaymentIntentId: null },
    );
  });

  it("a failing stale-cart QUERY neither fails finalization nor hides", async () => {
    const ctx = makeContext();
    const reportError = vi.fn();
    ctx.deps.reportError = reportError;
    ctx.mocks.staleCarts.listOtherPending.mockRejectedValue(
      new Error("db_timeout"),
    );

    const result = await finalizePaymentIntent(ctx.deps, {
      stripeEvent: ctx.stripeEvent,
    });

    expect(result).toEqual({ ok: true, orderId: DEFAULT_ORDER_ID });
    const queryReports = reportError.mock.calls.filter(
      (call) =>
        (call[1] as { tags?: { step?: string } } | undefined)?.tags?.step ===
        "cancelStalePendingCarts.query",
    );
    expect(queryReports).toHaveLength(1);
    expect(queryReports[0]).toEqual([
      expect.objectContaining({ message: "db_timeout" }),
      expect.objectContaining({
        tags: {
          useCase: "finalizePaymentIntent",
          step: "cancelStalePendingCarts.query",
        },
        extra: { orderId: DEFAULT_ORDER_ID },
      }),
    ]);
  });

  it("a RESALE sibling retired after success gives its listing hold back in its own transaction (G1)", async () => {
    const ctx = makeContext();
    const staleOrderId = "44444444-4444-4444-8444-444444444444";
    const holdExpiresAt = "2026-10-04T12:15:00.000Z";
    ctx.mocks.staleCarts.listOtherPending.mockResolvedValue([
      { id: staleOrderId, stripePaymentIntentId: "pi_stale" },
    ]);
    const defaultGetById = ctx.mocks.orders.getById.getMockImplementation()!;
    ctx.mocks.orders.getById.mockImplementation(async (id: string) =>
      id === staleOrderId
        ? ({
            id: staleOrderId,
            source: "RESALE",
            buyerHumanId: "buyer-1",
            status: "CANCELLED",
            items: [
              {
                id: "stale-item-1",
                resaleListingId: "listing-stale",
                meta: { holdExpiresAt, resaleListingId: "listing-stale" },
              },
            ],
          } as never)
        : defaultGetById(id),
    );
    const { cleanupTx } = ctx.mocks;

    await finalizePaymentIntent(ctx.deps, { stripeEvent: ctx.stripeEvent });

    // Three transactions: finalize's own, the ledger credits
    // (`createCreditsFromOrder`), then the sibling's retire.
    expect(ctx.mocks.tx).toHaveBeenCalledTimes(3);
    // Cancel, read-back, release and fee-waiver release all went through a
    // post-commit transaction's view, never finalize's (which has no
    // `releaseHold` and the tx fee-waiver spy).
    expect(cleanupTx.orders.cancelPendingOrder).toHaveBeenCalledWith(
      staleOrderId,
      { expectedPaymentIntentId: "pi_stale" },
    );
    expect(cleanupTx.orders.getById).toHaveBeenCalledWith(staleOrderId);
    expect(cleanupTx.resaleListings.releaseHold).toHaveBeenCalledWith(
      "listing-stale",
      { buyerHumanId: "buyer-1", heldUntil: new Date(holdExpiresAt) },
    );
    expect(
      cleanupTx.resaleListings.releaseHold.mock.invocationCallOrder[0],
    ).toBeGreaterThan(
      cleanupTx.orders.cancelPendingOrder.mock.invocationCallOrder[0]!,
    );
    expect(ctx.mocks.feeWaivers.release).toHaveBeenCalledWith(staleOrderId);
    expect(ctx.mocks.txFeeWaivers.release).not.toHaveBeenCalled();
    // The sibling's whole retire ran inside the LAST transaction.
    const lastTxStarted = ctx.mocks.tx.mock.invocationCallOrder[2]!;
    expect(
      cleanupTx.orders.cancelPendingOrder.mock.invocationCallOrder[0],
    ).toBeGreaterThan(lastTxStarted);
  });

  it("a RESALE sibling whose cancel CAS loses keeps its listing hold", async () => {
    const ctx = makeContext();
    const staleOrderId = "44444444-4444-4444-8444-444444444444";
    ctx.mocks.staleCarts.listOtherPending.mockResolvedValue([
      { id: staleOrderId, stripePaymentIntentId: "pi_stale" },
    ]);
    ctx.mocks.staleCarts.cancelPendingOrder.mockImplementation(
      async (id: string) => id !== staleOrderId,
    );

    await finalizePaymentIntent(ctx.deps, { stripeEvent: ctx.stripeEvent });

    expect(ctx.mocks.cleanupTx.orders.cancelPendingOrder).toHaveBeenCalledWith(
      staleOrderId,
      { expectedPaymentIntentId: "pi_stale" },
    );
    expect(ctx.mocks.cleanupTx.resaleListings.releaseHold).not.toHaveBeenCalled();
  });

  it("a throwing feeWaivers.release neither fails finalization nor hides", async () => {
    const ctx = makeContext();
    const reportError = vi.fn();
    ctx.deps.reportError = reportError;
    const staleOrderId = "33333333-3333-4333-8333-333333333333";
    ctx.mocks.staleCarts.listOtherPending.mockResolvedValue([
      { id: staleOrderId, stripePaymentIntentId: "pi_stale" },
    ]);
    ctx.mocks.feeWaivers.release.mockRejectedValueOnce(
      new Error("fee_waiver_release_boom"),
    );

    const result = await finalizePaymentIntent(ctx.deps, {
      stripeEvent: ctx.stripeEvent,
    });

    // The paid order is already durable; stale-cart cleanup is best-effort.
    expect(result).toEqual({ ok: true, orderId: DEFAULT_ORDER_ID });
    expect(ctx.mocks.orders.markSucceededIfOpen).toHaveBeenCalled();
    // ...but a deliberate swallow must reach Sentry (CLAUDE.md convention).
    // The default fixture has no payout terms, so the (pre-existing) ledger-
    // credit swallow reports too — scope to the stale-cart step.
    const staleCartReports = reportError.mock.calls.filter(
      (call) =>
        (call[1] as { tags?: { step?: string } } | undefined)?.tags?.step ===
        "cancelStalePendingCarts",
    );
    expect(staleCartReports).toHaveLength(1);
    expect(staleCartReports[0]).toEqual([
      expect.objectContaining({ message: "fee_waiver_release_boom" }),
      expect.objectContaining({
        tags: { useCase: "finalizePaymentIntent", step: "cancelStalePendingCarts" },
        extra: { orderId: DEFAULT_ORDER_ID, staleOrderId },
      }),
    ]);
  });

  it("a throwing reporter during stale-cart cleanup cannot fail finalization", async () => {
    const ctx = makeContext();
    ctx.deps.reportError = vi.fn(() => {
      throw new Error("sentry down");
    });
    const staleOrderId = "33333333-3333-4333-8333-333333333333";
    ctx.mocks.staleCarts.listOtherPending.mockResolvedValue([
      { id: staleOrderId, stripePaymentIntentId: "pi_stale" },
    ]);
    ctx.mocks.feeWaivers.release.mockRejectedValueOnce(
      new Error("fee_waiver_release_boom"),
    );

    await expect(
      finalizePaymentIntent(ctx.deps, { stripeEvent: ctx.stripeEvent }),
    ).resolves.toEqual({ ok: true, orderId: DEFAULT_ORDER_ID });
  });

  it("does not break finalization if stale cart cleanup fails", async () => {
    const ctx = makeContext();
    ctx.mocks.staleCarts.listOtherPending.mockRejectedValue(
      new Error("db_timeout"),
    );

    const result = await finalizePaymentIntent(ctx.deps, {
      stripeEvent: ctx.stripeEvent,
    });

    // Main finalization still succeeds
    expect(result).toEqual({ ok: true, orderId: DEFAULT_ORDER_ID });
    expect(ctx.mocks.orders.markSucceededIfOpen).toHaveBeenCalled();
  });

  describe("buyer in-app notification", () => {
    /** Wire a notify spy + a loginable-buyer auth-account lookup onto the ctx. */
    function withNotify(
      ctx: ReturnType<typeof makeContext>,
      opts?: { authAccounts?: unknown[] },
    ) {
      const notify = vi.fn(async () => ({}) as never);
      const accounts = opts?.authAccounts ?? [
        {
          providerId: "credential",
          accountId: "buyer-1",
          createdAt: new Date("2025-01-01"),
        },
      ];
      const listAuthAccounts = vi.fn(async () => accounts);
      (ctx.repos as unknown as { humans: unknown }).humans = {
        listAuthAccounts,
        // A loginable buyer also has a verified email (B2: isLoginableBuyer).
        getByIdWithIdentity: vi.fn(async (id: string) => ({
          human: { id },
          identity: { emailVerified: true },
        })),
      };
      ctx.deps.notify = notify;
      return { notify, listAuthAccounts };
    }

    it("fires order.confirmed for a primary ticket-issued order", async () => {
      const ctx = makeContext();
      const { notify } = withNotify(ctx);

      await finalizePaymentIntent(ctx.deps, { stripeEvent: ctx.stripeEvent });

      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({
          humanId: "buyer-1",
          variant: "order.confirmed",
          idempotencyKey: `order-confirmed:${DEFAULT_ORDER_ID}`,
          payload: expect.objectContaining({
            orderId: DEFAULT_ORDER_ID,
            eventId: DEFAULT_EVENT_ID,
            eventTitle: "Downtown Night",
            ticketCount: 2,
            amountCents: 5500,
            currency: "usd",
          }),
          channels: expect.objectContaining({
            inApp: { enabled: true },
            email: { enabled: false },
            sms: { enabled: false },
          }),
        }),
      );
    });

    it("fires resale.purchase-confirmed (not order.confirmed) for a resale order", async () => {
      const ctx = makeContext();
      ctx.order.source = "RESALE";
      ctx.order.parentOrderId = "parent-order-1";
      ctx.stripeEvent.data.object.metadata.source = "resale";
      ctx.order.items = [
        {
          ...ctx.order.items[0]!,
          qty: 1,
          resaleListingId: "resale-listing-1",
          meta: {
            buyerTotalCents: 5500,
            resaleListingId: "resale-listing-1",
          },
          // Checkout's pricing snapshot, consistent with the 4500 basis.
          resaleFaceValueCents: 4500,
          eventShareCents: 0,
          sharePayer: "SELLER",
        },
      ];
      ctx.mocks.agreements.listByEvent.mockResolvedValue([
        {
          id: "agreement-resale-1",
          kind: "RESALE",
          status: "ACTIVE",
          feeMode: null,
          feePolicyId: null,
          payoutSchedule: "WEEK_OF_EVENT",
          isDefault: false,
          settlementCurrency: "usd",
          version: 1,
          createdAt: new Date("2025-03-01T12:00:00.000Z"),
          updatedAt: new Date("2025-03-01T12:00:00.000Z"),
        },
      ]);
      // Finalize resolves RESALE terms the way checkout priced them — off the
      // listing (`listing.resalePayoutTermsId ?? event.resalePayoutTermsId`).
      ctx.mocks.resaleListings.getById.mockImplementation(async () => ({
        id: "resale-listing-1",
        ticketId: "resale-ticket-1",
        sellerHumanId: "seller-1",
        status: "HELD",
        buyerOrderId: null,
        resalePayoutTermsId: "agreement-resale-1",
      }));
      ctx.mocks.agreements.getById.mockImplementation(async (id: string) =>
        id === "agreement-resale-1"
          ? ((await ctx.mocks.agreements.listByEvent("")) as any)[0]
          : null,
      );
      const { notify } = withNotify(ctx);

      await finalizePaymentIntent(ctx.deps, { stripeEvent: ctx.stripeEvent });

      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({
          humanId: "buyer-1",
          variant: "resale.purchase-confirmed",
          idempotencyKey: `resale-purchase:${DEFAULT_ORDER_ID}`,
          payload: expect.objectContaining({
            orderId: DEFAULT_ORDER_ID,
            eventId: DEFAULT_EVENT_ID,
            amountCents: 5500,
            currency: "usd",
          }),
        }),
      );
      // Mutually exclusive: never the primary variant for a resale order.
      const variants = notify.mock.calls.map(
        (c) => (c[0] as { variant: string }).variant,
      );
      expect(variants).not.toContain("order.confirmed");
    });

    it("skips the notification for a guest buyer with no auth accounts", async () => {
      const ctx = makeContext();
      const { notify } = withNotify(ctx, { authAccounts: [] });

      const result = await finalizePaymentIntent(ctx.deps, {
        stripeEvent: ctx.stripeEvent,
      });

      // Order still finalized; buyer keeps their existing email receipt.
      expect(result).toEqual({ ok: true, orderId: DEFAULT_ORDER_ID });
      expect(ctx.mocks.tickets.create).toHaveBeenCalledTimes(2);
      expect(notify).not.toHaveBeenCalled();
    });

    it("never throws when notify fails", async () => {
      const ctx = makeContext();
      const { notify } = withNotify(ctx);
      notify.mockRejectedValueOnce(new Error("notify exploded"));

      const result = await finalizePaymentIntent(ctx.deps, {
        stripeEvent: ctx.stripeEvent,
      });

      expect(result).toEqual({ ok: true, orderId: DEFAULT_ORDER_ID });
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it("does not re-fire on an idempotent replay", async () => {
      const ctx = makeContext();
      const { notify } = withNotify(ctx);

      await finalizePaymentIntent(ctx.deps, { stripeEvent: ctx.stripeEvent });
      notify.mockClear();

      // Second delivery of the same Stripe event → cached replay, no notify.
      await finalizePaymentIntent(ctx.deps, { stripeEvent: ctx.stripeEvent });
      expect(notify).not.toHaveBeenCalled();
    });
  });
});
