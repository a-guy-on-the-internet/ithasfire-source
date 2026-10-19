// @ts-nocheck — THIS FILE ONLY. The fake-repo harness below is copied from
// packages/core/src/use-cases/orders/__tests__/create-checkout.test.ts, where
// test files sit outside every typecheck (tsconfig.base.json excludes them)
// and the fakes are deliberately partial (PaymentProcessorPort alone has 20+
// methods createCheckout never calls). apps/web's tsc DOES check tests, so
// the untyped fakes are quarantined here and the assertions that use them
// (`../pay-what-you-want-create-checkout.test.ts`) ARE typechecked.
//
// Changes from the copy: imports re-pointed at `@th/core/...`, the local
// tax-imposition `vi.mock` seam dropped (identity when unset; not needed
// here), and a `maxFeeCents` option on the fee policy.

import { vi } from "vitest";
import { randomUUID } from "node:crypto";

import { formatOrderCode } from "@th/types/order-identifier";

import { createCheckout } from "@th/core/use-cases/orders/create-checkout";
import type { CreateCheckoutDeps } from "@th/core/use-cases/orders/create-checkout";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  PayoutTermsRecord,
  PayoutTermsRepo,
} from "@th/ports/repos/payout-terms";
import type { AuditRepo } from "@th/ports/repos/audit";
import type { EventsRepo } from "@th/ports/repos/events";
import type { HumanRecord } from "@th/ports/repos/humans";
import type { OrganizationRecord } from "@th/ports/repos/organizations";
import type {
  FeePoliciesRepo,
  FeePolicyRecord,
} from "@th/ports/repos/fee-policies";
import type {
  OrderItemRecord,
  OrderRecord,
  OrdersRepo,
} from "@th/ports/repos/orders";
import type { PromosRepo, PromoRecord } from "@th/ports/repos/promos";
import type { TicketRecord } from "@th/ports/repos/tickets";
import type {
  AcceptanceRecordRow,
  CreateAcceptanceRecordInput,
  FindCurrentAcceptanceInput,
} from "@th/ports/repos/acceptances";
import { createTestLogger } from "@th/test-utils/fakes/logger";
import { claimFreeTickets } from "@th/core/use-cases/orders/claim-free-tickets";
import { SEAT_FENCE_SLACK_SECONDS } from "@th/core/use-cases/orders/_shared/cart-seat-release";
import {
  CURRENT_BUYER_TERMS_TEXT,
  CURRENT_BUYER_TERMS_VERSION,
} from "@th/core/lib/legal/buyer-terms";
import { CURRENT_CHARGEBACK_TERMS_VERSION } from "@th/core/lib/payments/chargeback-terms";

/**
 * A version the owner accepted before the current one. Checkout is a
 * version-agnostic backstop: the strict current-version gate lives at Stripe
 * Connect onboarding, so a stale acceptance must never block a sale.
 */
const STALE_CHARGEBACK_TERMS_VERSION = "2000-01-01";
import {
  CURRENT_REFUND_POLICY_TEXT,
  CURRENT_REFUND_POLICY_VERSION,
  getCurrentRefundPolicySnapshot,
} from "@th/core/lib/payments/refund-policy";
import { computeAgreementBasis } from "@th/core/use-cases/orders/finalize-from-payment-intent";
import { computeExpectedPaymentAmount } from "@th/core/lib/orders/compute-expected-payment-amount";
import { solveProcessingFeeGrossUp } from "@th/core/lib/pricing/processing-cost-schedule";


const DEFAULT_EVENT_ID = "11111111-1111-4111-8111-111111111111";
const DEFAULT_ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const DEFAULT_CLIENT_KEY = "idem-key-123";
const DEFAULT_TICKET_TYPE_ID = "33333333-3333-4333-8333-333333333333";
const DEFAULT_AGREEMENT_ID = "44444444-4444-4444-8444-444444444444";
const DEFAULT_FEE_POLICY_ID = "55555555-5555-4555-8555-555555555555";
const DEFAULT_ORDER_ID = "66666666-6666-4666-8666-666666666666";
const DEFAULT_PAYEE_ID = "77777777-7777-4777-8777-777777777777";

interface SeedCredit {
  id: string;
  balanceCents: number;
  currency?: string;
  sourceType?: string;
  reason?: string;
}

interface MakeContextOptions {
  /** Per-ticket platform fee cap (FeePolicy.maxFeeCents). null = uncapped. */
  maxFeeCents?: number | null;
  ticketPriceCents?: number;
  stripeConnected?: boolean;
  waiverTemplateId?: string | null;
  /**
   * `true` = accepted the CURRENT version; `"stale"` = accepted an older
   * version; `false` = never accepted.
   */
  chargebackTermsAccepted?: boolean | "stale";
  activeCredits?: SeedCredit[];
  feeMode?: "PASS_THROUGH" | "ABSORB";
  buyerFeePct?: number;
  /** Flat platform fee per ticket in cents (FeePolicy.platformFixedCents). */
  platformFixedCents?: number;
  /** Admission sales-tax rate in basis points, stamped on the event. */
  admissionTaxRateBps?: number;
  /**
   * INLINE venue jurisdiction for the event (country / region / postal). Drives
   * the situs `resolveCheckoutTax` freezes onto the order — and therefore the
   * TAXABLE BASE (`lib/pricing/taxable-base.ts`), which decides whether the
   * admission rate applies to the ticket face or to everything the buyer pays.
   * Inline on purpose: no Place / SavedLocation read, so these fixtures need no
   * extra fake repos.
   */
  taxSitus?: {
    countryCode?: string | null;
    region?: string | null;
    postalCode?: string | null;
  };
  /**
   * Scheduled price change on the default ticket type
   * (time-based-ticket-pricing FR-005). Both or neither.
   */
  scheduledPriceCents?: number | null;
  scheduledPriceAt?: Date | null;
  /**
   * Per-type sales window on the default ticket type (FR-014). Independent
   * bounds; null = no bound, which is the default and today's behaviour.
   */
  salesOpenAt?: Date | null;
  salesCloseAt?: Date | null;
  /**
   * Authored capacity of the default ticket type. Defaults high so the
   * capacity gate is a no-op for tests that aren't about inventory; set it low
   * (with `issuedForTicketType` / `heldForTicketType`) to exercise the gate.
   */
  capacity?: number;
  /** Tickets already minted for the default type — the `issued` half. */
  issuedForTicketType?: number;
  /** Qty on other buyers' unexpired PENDING holds — the `held` half. */
  heldForTicketType?: number;
  /**
   * Named PENDING cart holds, keyed by order id. Unlike `heldForTicketType`
   * (an opaque constant) these live in a ledger that `cancelPendingOrder`
   * actually mutates, so a test can prove a retired cart STOPS consuming
   * inventory for the next buyer rather than merely asserting a cancel call.
   */
  pendingCartHolds?: Record<string, number>;
  /**
   * Overrides the instant the injected ClockPort reports. Every price read in
   * checkout resolves against this, so it is how a test sits on either side of
   * a scheduled flip — or of a sales-window boundary.
   */
  now?: Date;
}

export function makeContext(options: MakeContextOptions = {}) {
  const now = options.now ?? new Date("2025-01-01T00:00:00.000Z");
  const ticketPriceCents = options.ticketPriceCents ?? 1000;
  const scheduledPriceCents = options.scheduledPriceCents ?? null;
  const scheduledPriceAt = options.scheduledPriceAt ?? null;
  const stripeConnected = options.stripeConnected ?? true;
  const waiverTemplateId = options.waiverTemplateId ?? null;
  const chargebackTermsAccepted = options.chargebackTermsAccepted ?? true;
  const seedCredits = options.activeCredits ?? [];
  const feeMode = options.feeMode ?? "PASS_THROUGH";
  const buyerFeePct = options.buyerFeePct ?? 0.05;
  const platformFixedCents = options.platformFixedCents ?? 0;
  const admissionTaxRateBps = options.admissionTaxRateBps ?? 0;
  const capacity = options.capacity ?? 1000;
  const issuedForTicketType = options.issuedForTicketType ?? 0;
  const heldForTicketType = options.heldForTicketType ?? 0;
  // Live ledger of PENDING cart holds. `cancelPendingOrder` deletes from it,
  // which is what makes "the retired cart no longer blocks anyone" observable.
  const pendingCartHolds = new Map<string, number>(
    Object.entries(options.pendingCartHolds ?? {}),
  );

  const eventRecord = {
    id: DEFAULT_EVENT_ID,
    orgId: "org-1",
    humanId: null,
    title: "Launch Party",
    status: "PUBLISHED" as const,
    visibility: "PUBLIC" as const,
    gateType: "NONE" as const,
    waiverTemplateId,
    startsAt: new Date("2025-02-01T20:00:00.000Z"),
    endsAt: null,
    placeId: null,
    savedLocationId: null,
    categoryId: null,
    addressText: null,
    lat: null,
    lng: null,
    slug: "launch-party",
    shortId: "launchpr",
    regionCode: null,
    postalCode: options.taxSitus?.postalCode ?? null,
    countryCode: options.taxSitus?.countryCode ?? null,
    region: options.taxSitus?.region ?? null,
    admissionTaxRateBps,
    publishedAt: now,
    agreementPrimaryId: DEFAULT_AGREEMENT_ID,
    agreementResaleId: null,
    defaultLocale: null,
    currency: "usd",
  };

  const eventsRepo = {
    getById: vi.fn(async (id: string) =>
      id === eventRecord.id ? eventRecord : null,
    ),
    listTicketTypes: vi.fn(async (eventId: string) =>
      eventId === eventRecord.id
        ? [
            {
              id: DEFAULT_TICKET_TYPE_ID,
              priceCents: ticketPriceCents,
              status: "ACTIVE" as const,
              capacity,
              seatSectionId: null as string | null,
              resaleAllowed: false,
              resaleCapCents: null as number | null,
              transferAllowed: true,
              scheduledPriceCents,
              scheduledPriceAt,
              salesOpenAt: options.salesOpenAt ?? null,
              salesCloseAt: options.salesCloseAt ?? null,
            },
          ]
        : [],
    ),
    ensureHostPermission: vi.fn(async () => true),
    upsertDraft: vi.fn(),
    listPublishedForSitemap: vi.fn(async () => []),
  };

  const agreement: PayoutTermsRecord = {
    id: DEFAULT_AGREEMENT_ID,
    kind: "PRIMARY_SPLIT",
    status: "ACTIVE",
    feeMode,
    feePolicyId: DEFAULT_FEE_POLICY_ID,
    payoutSchedule: "WEEK_OF_EVENT",
    isDefault: false,
    settlementCurrency: "usd",
    version: 1,
    createdAt: now,
    updatedAt: now,
  };

  const agreementsRepo = {
    listByEvent: vi.fn(async () => [agreement]),
    listLines: vi.fn(async () => [
      {
        id: "line-1",
        agreementId: DEFAULT_AGREEMENT_ID,
        payeeId: DEFAULT_PAYEE_ID,
        percent: 100,
        floorCents: 0,
        capPercent: null,
        priority: 0,
        rounding: "FLOOR" as const,
      },
    ]),
    getById: vi.fn(async () => agreement),
    createDraft: vi.fn(),
    updateDraft: vi.fn(),
    replaceLines: vi.fn(async () => undefined),
  };

  const feePolicy: FeePolicyRecord = {
    id: DEFAULT_FEE_POLICY_ID,
    scopeType: "EVENT",
    scopeId: eventRecord.id,
    status: "ACTIVE",
    version: 1,
    buyerFeePct,
    maxFeeCents: options.maxFeeCents ?? null,
    minFeeCents: 0,
    platformFixedCents,
    feeMode,
    processsorFeePct: 0.029,
    processorFixedCents: 30,
    payoutPct: 0.9,
    payoutFixedCents: 0,
    monthlyPayoutCents: 0,
    effectiveFrom: now,
    effectiveTo: null,
  };

  const feePoliciesRepo = {
    getById: vi.fn(async (id: string) =>
      id === feePolicy.id ? feePolicy : null,
    ),
  };

  const orderState: OrderRecord = {
    id: DEFAULT_ORDER_ID,
    eventId: eventRecord.id,
    buyerHumanId: DEFAULT_ACTOR_ID,
    amountGrossCents: 0,
    feesPlatformCents: 0,
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
    items: [] as OrderItemRecord[],
  };

  let itemSequence = 0;
  let lastCreatePendingInput:
    | Parameters<OrdersRepo["createPending"]>[0]
    | null = null;
  let lastCreateTaxLinesInput:
    | Parameters<OrdersRepo["createTaxLines"]>[0]
    | null = null;

  type SeatState = {
    eventId: string;
    seatSectionId: string;
    status: "AVAILABLE" | "HELD" | "SOLD" | "BLOCKED";
    label: string;
    row: string | null;
    number: number | null;
  };

  const seatStore = new Map<string, SeatState>();
  const seatSectionCapacity = new Map<string, number>();

  type PendingItemInput = Parameters<
    OrdersRepo["createPending"]
  >[0]["items"][number];

  const ordersRepoImpl = {
    createPending: vi.fn(async (input) => {
      lastCreatePendingInput = input;
      orderState.amountGrossCents = input.amountGrossCents;
      orderState.feesPlatformCents = input.feesPlatformCents;
      orderState.feePolicySnapshot = input.feePolicySnapshot ?? {};
      orderState.source = input.source;
      orderState.currency = input.currency;
      orderState.items = input.items.map((item: PendingItemInput) => ({
        // A UUID (not `item-N`) so `updateOrderItems`' output schema accepts
        // the held order too — the parity test holds before it charges.
        id: `00000000-0000-4000-8000-${String(itemSequence++).padStart(12, "0")}`,
        kind: item.kind,
        ticketTypeId: item.ticketTypeId ?? null,
        qty: item.qty,
        unitPriceCents: item.unitPriceCents,
        amountCents: item.amountCents,
        meta: item.meta ?? {},
      })) as OrderItemRecord[];
      return {
        id: DEFAULT_ORDER_ID,
        amountGrossCents: input.amountGrossCents,
        feesPlatformCents: input.feesPlatformCents,
        currency: input.currency,
      };
    }),
    createTaxLines: vi.fn(
      async (input: Parameters<OrdersRepo["createTaxLines"]>[0]) => {
        lastCreateTaxLinesInput = input;
      },
    ),
    getById: vi.fn(async (id: string) =>
      id === DEFAULT_ORDER_ID ? { ...orderState } : null,
    ),
    linkPaymentIntent: vi.fn(async (_orderId: string, piId: string) => {
      orderState.stripePaymentIntentId = piId;
    }),
    // createCheckout links its PaymentIntent after the order commits, through
    // this CAS (PENDING, and no PI yet or already this one), like the adapter.
    linkPaymentIntentIfPending: vi.fn(async (orderId: string, piId: string) => {
      if (
        orderId !== orderState.id ||
        orderState.status !== "PENDING" ||
        (orderState.stripePaymentIntentId !== null &&
          orderState.stripePaymentIntentId !== piId)
      ) {
        return false;
      }
      orderState.stripePaymentIntentId = piId;
      return true;
    }),
    findByPaymentIntent: vi.fn(async (piId: string) =>
      orderState.stripePaymentIntentId === piId
        ? { id: DEFAULT_ORDER_ID, status: orderState.status }
        : null,
    ),
    markSucceeded: vi.fn(async () => {
      orderState.status = "SUCCEEDED";
    }),
    markProcessing: vi.fn(async () => {
      orderState.status = "PROCESSING";
    }),
    markRefunded: vi.fn(async () => {
      orderState.status = "REFUNDED";
    }),
    cancelProcessingOrder: vi.fn(async () => true),
    // CAS on PENDING, like the adapter: retiring a cart removes its hold from
    // the ledger, so the very next capacity read sees the freed inventory.
    // Returns true because the adapter's `updateMany` matches any PENDING row
    // — the hold ledger only tracks the CAPACITY side, and a cart with no
    // seeded hold is still a real cancellable order.
    cancelPendingOrder: vi.fn(async (orderId: string) => {
      pendingCartHolds.delete(orderId);
      return true;
    }),
    setPaymentMethodType: vi.fn(),
  };

  const ordersRepo = ordersRepoImpl as unknown as OrdersRepo;

  const auditRepo = {
    log: vi.fn(async () => undefined),
  };

  const organizationRecord: OrganizationRecord = {
    id: "org-1",
    name: "Org One",
    slug: "org-one",
    status: "ACTIVE",
    defaultLocale: null,
    contactEmail: null,
    physicalAddress: null,
    defaultPrimaryPayoutTermsId: null,
    defaultResalePayoutTermsId: null,
    trustTier: "NEW",
    trustBadgeLabel: null,
    trustBadgeIcon: null,
    chargebackTermsVersion:
      chargebackTermsAccepted === "stale"
        ? STALE_CHARGEBACK_TERMS_VERSION
        : chargebackTermsAccepted
          ? CURRENT_CHARGEBACK_TERMS_VERSION
          : null,
    chargebackTermsAcceptedAt: chargebackTermsAccepted
      ? new Date("2024-12-15T00:00:00.000Z")
      : null,
    chargebackTermsAcceptedByHumanId: chargebackTermsAccepted
      ? DEFAULT_ACTOR_ID
      : null,
    createdAt: now,
  };

  const humanRecord: HumanRecord = {
    id: DEFAULT_ACTOR_ID,
    name: "Buyer",
    status: "ACTIVE",
    roles: [],
    locale: null,
    phone: null,
    billingAddressLine1: null,
    billingAddressLine2: null,
    billingCity: null,
    billingState: null,
    billingPostalCode: null,
    billingCountry: null,
    defaultPrimaryPayoutTermsId: null,
    defaultResalePayoutTermsId: null,
    trustTier: "NEW",
    trustBadgeLabel: null,
    trustBadgeIcon: null,
    chargebackTermsVersion:
      chargebackTermsAccepted === "stale"
        ? STALE_CHARGEBACK_TERMS_VERSION
        : chargebackTermsAccepted
          ? CURRENT_CHARGEBACK_TERMS_VERSION
          : null,
    chargebackTermsAcceptedAt: chargebackTermsAccepted
      ? new Date("2024-12-15T00:00:00.000Z")
      : null,
    jobs: [],
    genreTags: [],
    otherJobDescription: null,
    createdAt: now,
  };

  const organizationsRepo = {
    getById: vi.fn(async (id: string) =>
      id === organizationRecord.id ? { ...organizationRecord } : null,
    ),
    acceptChargebackTerms: vi.fn(async () => ({ ...organizationRecord })),
  };

  const humansRepo = {
    getById: vi.fn(async (id: string) =>
      id === humanRecord.id ? { ...humanRecord } : null,
    ),
    acceptChargebackTerms: vi.fn(async () => ({ ...humanRecord })),
  };

  const seatsRepoImpl = {
    findByIdsForUpdate: vi.fn(
      async ({ seatIds, eventId }: { seatIds: string[]; eventId: string }) => {
        const results: Array<{
          id: string;
          seatSectionId: string;
          status: SeatState["status"];
          eventId: string;
          label: string;
          row: string | null;
          number: number | null;
        }> = [];
        for (const seatId of seatIds) {
          const seat = seatStore.get(seatId);
          if (seat && seat.eventId === eventId) {
            results.push({
              id: seatId,
              seatSectionId: seat.seatSectionId,
              status: seat.status,
              eventId: seat.eventId,
              label: seat.label,
              row: seat.row,
              number: seat.number,
            });
          }
        }
        return results;
      },
    ),
    // No overrides by default: every seat is priced at its tier.
    findPriceOverridesByIds: vi.fn(
      async ({ seatIds, eventId }: { seatIds: string[]; eventId: string }) =>
        seatIds
          .filter((id) => seatStore.get(id)?.eventId === eventId)
          .map((id) => ({
            id,
            seatSectionId: seatStore.get(id)!.seatSectionId,
            priceOverride: null,
          })),
    ),
    updateStatuses: vi.fn(
      async ({
        seatIds,
        status,
      }: {
        seatIds: string[];
        status: SeatState["status"];
        updatedAt: Date;
      }) => {
        for (const seatId of seatIds) {
          const seat = seatStore.get(seatId);
          if (seat) {
            seat.status = status;
          }
        }
      },
    ),
    reserveForHold: vi.fn(
      async ({
        seatSectionId,
        eventId,
        qty,
      }: {
        seatSectionId: string;
        eventId: string;
        qty: number;
      }) => {
        const capacity = seatSectionCapacity.get(seatSectionId) ?? 0;
        const existingSeats = Array.from(seatStore.entries()).filter(
          ([, seat]) => seat.seatSectionId === seatSectionId,
        );
        const availableSeats = existingSeats.filter(
          ([, seat]) => seat.status === "AVAILABLE",
        );
        const missing = Math.max(qty - availableSeats.length, 0);
        const remainingCapacity = Math.max(capacity - existingSeats.length, 0);
        const seatsToCreate = Math.min(missing, remainingCapacity);

        for (let i = 0; i < seatsToCreate; i += 1) {
          const id = `ga-${existingSeats.length + i + 1}`;
          seatStore.set(id, {
            eventId,
            seatSectionId,
            status: "AVAILABLE",
            label: `GA-${existingSeats.length + i + 1}`,
            row: null,
            number: existingSeats.length + i + 1,
          });
        }

        const refreshedAvailable = Array.from(seatStore.entries())
          .filter(
            ([, seat]) =>
              seat.seatSectionId === seatSectionId &&
              seat.status === "AVAILABLE",
          )
          .slice(0, qty);

        if (refreshedAvailable.length < qty) {
          return [];
        }

        for (const [seatId, seat] of refreshedAvailable) {
          seat.status = "HELD";
        }

        return refreshedAvailable.map(([id, seat]) => ({
          id,
          seatSectionId: seat.seatSectionId,
          status: "HELD",
          eventId: seat.eventId,
          label: seat.label,
          row: seat.row,
          number: seat.number,
        }));
      },
    ),
    releaseSeats: vi.fn(
      async ({ seatIds }: { seatIds: string[]; releasedAt: Date }) => {
        for (const seatId of seatIds) {
          const seat = seatStore.get(seatId);
          if (seat && seat.status === "HELD") {
            seat.status = "AVAILABLE";
          }
        }
      },
    ),
    releaseExpiredHolds: vi.fn(async () => 0),
  };

  const ticketsRepoImpl = {
    findBySeatIds: vi.fn(async () => [] as TicketRecord[]),
    // Mint reads the unfiltered twin for its @unique pre-flight.
    findBySeatIdsIncludingTerminal: vi.fn(async () => [] as TicketRecord[]),
    countIssuedForTicketType: vi.fn(async () => issuedForTicketType),
    // The pre-charge capacity gate. Mirrors the adapter: `held` sums every
    // live PENDING cart hold EXCEPT the one the caller is superseding. A hold
    // that has been retired (cancelPendingOrder) is gone from the ledger and
    // therefore counts for nobody — which is the property the retirement
    // regression test turns on.
    lockAndCountCapacityForTicketType: vi.fn(
      async ({ excludeOrderId }: { excludeOrderId?: string | null } = {}) => {
        let ledgerHeld = 0;
        for (const [orderId, qty] of pendingCartHolds) {
          if (orderId !== excludeOrderId) ledgerHeld += qty;
        }
        return {
          issued: issuedForTicketType,
          held: heldForTicketType + ledgerHeld,
        };
      },
    ),
    countIssuedForEvent: vi.fn(async () => 0),
    countForOrderTicketType: vi.fn(async () => 0),
    getByOrderItemId: vi.fn(async () => null),
    create: vi.fn(async (input: any) => ({
      id: `ticket-${crypto.randomUUID().slice(0, 8)}`,
      eventId: input.eventId,
      ticketTypeId: input.ticketTypeId,
      ownerHumanId: input.ownerHumanId,
      orderId: input.orderId ?? null,
      orderItemId: input.orderItemId ?? null,
      seatId: input.seatId ?? null,
      code: input.code,
      status: input.status,
      issuedAt: input.issuedAt,
      scannedAt: null,
    })),
    markScanned: vi.fn(),
    getById: vi.fn(),
    getByCode: vi.fn(),
    setStatus: vi.fn(),
    recordScan: vi.fn(),
    transfer: vi.fn(),
    findTicketTypeByName: vi.fn(),
    createTicketType: vi.fn(),
  };

  const promosRepoImpl = {
    findActiveByCodes: vi.fn<
      [Parameters<PromosRepo["findActiveByCodes"]>[0]],
      ReturnType<PromosRepo["findActiveByCodes"]>
    >(async () => []),
    findActiveByIds: vi.fn<
      [Parameters<PromosRepo["findActiveByIds"]>[0]],
      ReturnType<PromosRepo["findActiveByIds"]>
    >(async () => []),
    getRedemptionStats: vi.fn<
      [Parameters<PromosRepo["getRedemptionStats"]>[0]],
      ReturnType<PromosRepo["getRedemptionStats"]>
    >(async () => ({ totalRedemptions: 0, redemptionsForHuman: 0 })),
    createHolds: vi.fn<
      [Parameters<PromosRepo["createHolds"]>[0]],
      ReturnType<PromosRepo["createHolds"]>
    >(async () => []),
    releaseHoldsForOrder: vi.fn<
      [Parameters<PromosRepo["releaseHoldsForOrder"]>[0]],
      ReturnType<PromosRepo["releaseHoldsForOrder"]>
    >(async () => undefined),
    listHoldsForOrder: vi.fn<
      [Parameters<PromosRepo["listHoldsForOrder"]>[0]],
      ReturnType<PromosRepo["listHoldsForOrder"]>
    >(async () => []),
    confirmHoldsForOrder: vi.fn<
      [Parameters<PromosRepo["confirmHoldsForOrder"]>[0]],
      ReturnType<PromosRepo["confirmHoldsForOrder"]>
    >(async () => []),
  };

  const promosRepo = promosRepoImpl as unknown as PromosRepo;

  const creditStore = new Map(
    seedCredits.map((credit) => [
      credit.id,
      {
        id: credit.id,
        humanId: DEFAULT_ACTOR_ID,
        amountCents: credit.balanceCents,
        currency: credit.currency ?? "usd",
        balanceCents: credit.balanceCents,
        reason: credit.reason ?? "Test credit",
        sourceType: credit.sourceType ?? "MANUAL_STAFF_GRANT",
        grantedByHumanId: null,
        sourceRef: null,
        status: "ACTIVE" as const,
        expiresAt: undefined,
        createdAt: now,
        updatedAt: now,
      },
    ]),
  );
  // Atomic conditional debit — mirrors the adapter's redeemConditional UPDATE.
  // Re-derives the applied amount from the live store entry (not a snapshot),
  // so a credit drained by a prior call in the same run yields 0.
  const redeemConditionalMock = vi.fn(
    async (input: { creditId: string; requestedCents: number }) => {
      const credit = creditStore.get(input.creditId);
      if (
        !credit ||
        credit.status !== "ACTIVE" ||
        credit.balanceCents <= 0 ||
        input.requestedCents <= 0
      ) {
        return {
          appliedCents: 0,
          balanceAfterCents: credit?.balanceCents ?? 0,
        };
      }
      const appliedCents = Math.min(credit.balanceCents, input.requestedCents);
      credit.balanceCents -= appliedCents;
      if (credit.balanceCents <= 0) {
        credit.status = "REDEEMED";
      }
      return { appliedCents, balanceAfterCents: credit.balanceCents };
    },
  );
  // Insert-only: the balance debit is handled by redeemConditional above.
  const recordRedemptionMock = vi.fn(
    async (input: {
      creditId: string;
      orderId: string;
      amountCents: number;
    }) => ({
      id: `redemption-${input.creditId}-${input.orderId}`,
      creditId: input.creditId,
      orderId: input.orderId,
      amountCents: input.amountCents,
      createdAt: now,
    }),
  );
  const creditsRepo = {
    grant: vi.fn(async () => {
      throw new Error("not implemented in harness");
    }),
    listActiveForHuman: vi.fn(
      async ({ currency }: { humanId: string; currency: string }) =>
        Array.from(creditStore.values()).filter(
          (credit) =>
            credit.status === "ACTIVE" &&
            credit.balanceCents > 0 &&
            credit.currency === currency,
        ),
    ),
    listAllForHuman: vi.fn(async () => Array.from(creditStore.values())),
    listRedemptionsForHuman: vi.fn(async () => []),
    findBySource: vi.fn(async () => null),
    redeemConditional: redeemConditionalMock,
    recordRedemption: recordRedemptionMock,
    // Released only on the cancel paths (releaseRetiredCartHolds); a superseded
    // cart's credit comes back through this.
    releaseForOrder: vi.fn(async () => ({ releasedCents: 0, creditIds: [] })),
  } as unknown as TxRepos["credits"];

  // ── Functional splits + settlements stores ──────────────────────────
  // The fully credit-covered (zero-charge) path writes OrderSplits inside
  // the checkout tx and then calls createCreditsFromOrder after commit.
  // These mocks model just enough behaviour for that flow to run end-to-end
  // so tests can assert the organiser is actually paid. Ids are UUIDs so the
  // settlement output schema (which requires uuid()) parses.
  const splitsStore = new Map<
    string,
    Array<{
      id: string;
      orderId: string;
      orderSplitId: string;
      payeeId: string;
      amountCents: number;
    }>
  >();
  const splitsUpsertForOrderMock = vi.fn(
    async (
      orderId: string,
      rows: Array<{ payeeId: string; amountCents: number }>,
    ) => {
      splitsStore.set(
        orderId,
        rows.map((row) => ({
          id: randomUUID(),
          orderId,
          orderSplitId: randomUUID(),
          payeeId: row.payeeId,
          amountCents: row.amountCents,
        })),
      );
    },
  );
  const splitsRepo = {
    upsertForOrder: splitsUpsertForOrderMock,
    getForOrder: vi.fn(
      async (orderId: string) => splitsStore.get(orderId) ?? [],
    ),
  };

  const settlementStore = new Map<
    string,
    {
      id: string;
      payeeId: string;
      amountCents: number;
      currency: string;
      scheduledPayoutDate: Date;
      date: Date;
      agreementId: string;
      eventId: string;
    }
  >();
  const settlementsCreateMock = vi.fn(
    async (input: {
      payeeId: string;
      amountCents: number;
      currency: string;
      scheduledPayoutDate: Date;
      date: Date;
      agreementId: string;
      eventId: string;
    }) => {
      const id = randomUUID();
      const record = { id, ...input };
      settlementStore.set(id, record);
      return record;
    },
  );
  const settlementsRepo = {
    getByPayeeAndScheduledDate: vi.fn(async () => null),
    create: settlementsCreateMock,
    updateAmount: vi.fn(async (id: string, amountCents: number) => {
      const record = settlementStore.get(id);
      if (record) record.amountCents = amountCents;
    }),
    getById: vi.fn(async (id: string) => settlementStore.get(id) ?? null),
  };

  const settlementLinesStore: Array<{
    id: string;
    settlementId: string;
    orderId: string;
    orderSplitId: string;
    payeeId: string;
    amountCents: number;
    currency: string;
  }> = [];
  const settlementLinesAddDraftMock = vi.fn(
    async (
      rows: Array<{
        settlementId: string;
        orderId: string;
        orderSplitId: string;
        payeeId: string;
        amountCents: number;
        currency: string;
      }>,
    ) => {
      for (const row of rows) {
        settlementLinesStore.push({ id: randomUUID(), ...row });
      }
    },
  );
  const settlementLinesRepo = {
    addDraft: settlementLinesAddDraftMock,
    listByOrderId: vi.fn(async (orderId: string) =>
      settlementLinesStore.filter((line) => line.orderId === orderId),
    ),
  };

  const orderItemsRepo = {
    listByOrderId: vi.fn(async (orderId: string) =>
      orderId === DEFAULT_ORDER_ID ? orderState.items : [],
    ),
  };

  const orderItemSettlementLinesAddDraftMock = vi.fn(async () => undefined);
  const orderItemSettlementLinesRepo = {
    addDraft: orderItemSettlementLinesAddDraftMock,
  };

  // Payee ledger — SETTLEMENT_CREDIT writes for the credit-covered path
  // (createCreditsFromOrder runs after the checkout tx commits).
  let ledgerEntrySeq = 0;
  const payeeLedgerSettlementCreditMock = vi.fn(
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
    settlementCredit: payeeLedgerSettlementCreditMock,
  };

  // ── Acceptance ledger fake (AcceptanceRecord rows) ───────────────────
  // Keyed exactly like the adapter: (human, documentType, version, scope).
  const acceptanceStore: AcceptanceRecordRow[] = [];
  const acceptancesFindCurrentMock = vi.fn(
    async (query: FindCurrentAcceptanceInput) =>
      acceptanceStore.find(
        (row) =>
          row.humanId === query.humanId &&
          row.documentType === query.documentType &&
          row.documentVersion === query.documentVersion &&
          row.scopeType === (query.scopeType ?? "GLOBAL") &&
          row.scopeId === (query.scopeId ?? null),
      ) ?? null,
  );
  const acceptancesCreateMock = vi.fn(
    async (record: CreateAcceptanceRecordInput) => {
      const row: AcceptanceRecordRow = {
        id: `acceptance-${acceptanceStore.length + 1}`,
        humanId: record.humanId,
        documentType: record.documentType,
        documentVersion: record.documentVersion,
        documentTextSnapshot: record.documentTextSnapshot,
        scopeType: record.scopeType,
        scopeId: record.scopeId ?? null,
        acceptedAt: record.acceptedAt ?? now,
        ipAddress: record.ipAddress ?? null,
        userAgent: record.userAgent ?? null,
        metadata: record.metadata ?? null,
      };
      acceptanceStore.push(row);
      return row;
    },
  );
  const acceptancesRepoImpl = {
    findCurrent: acceptancesFindCurrentMock,
    create: acceptancesCreateMock,
  };

  // ── Membership benefit resolution fakes ──────────────────────────────
  // resolveMemberBenefits runs inside every checkout tx. Default: the buyer
  // has no memberships, so no member promos join the evaluation. Tests seed
  // these mocks to exercise auto-applied member benefits.
  const membershipsRepoImpl = {
    listForMember: vi.fn(
      async (_input: { memberHumanId: string; statuses: string[] }) => [],
    ),
  };
  const membershipTiersRepoImpl = {
    // resolveMemberBenefits reads the granting tiers to derive each grant's
    // ownerScope, so BOTH reads must exist even in the no-membership default.
    listByIds: vi.fn(async (_ids: string[]) => []),
    listBenefitsForTiers: vi.fn(async (_tierIds: string[]) => []),
  };

  // Only the surface the cancel paths touch. `resolveApplicable` answers
  // "no waiver" so the checkout's own reservation step stays a no-op, and
  // `release` is a spy on the SAME object the tx hands out — a missing method
  // here would throw inside the transaction and must fail red, not green.
  const feeWaiversRepo = {
    resolveApplicable: vi.fn(async (): Promise<unknown[]> => []),
    reserve: vi.fn(async () => ({
      reservedTickets: 0,
      feeWaivedCents: 0,
      redemptionId: null,
    })),
    release: vi.fn(async () => ({ releasedTickets: 0 })),
  };

  const txRepos = {
    events: eventsRepo as unknown as EventsRepo,
    agreements: agreementsRepo as unknown as PayoutTermsRepo,
    payoutTerms: agreementsRepo as unknown as PayoutTermsRepo,
    feePolicies: feePoliciesRepo as unknown as FeePoliciesRepo,
    orders: ordersRepo,
    audit: auditRepo as unknown as AuditRepo,
    promos: promosRepo,
    tickets: ticketsRepoImpl as any,
    seats: seatsRepoImpl as any,
    humans: humansRepo as any,
    payees: {
      getBySubject: vi.fn(async () =>
        stripeConnected ? ({ id: "acct_test_connected" } as const) : null,
      ),
      getById: vi.fn(async (id: string) =>
        id === "acct_test_connected" && stripeConnected
          ? ({
              id: "acct_test_connected",
              subjectType: "ORGANIZATION",
              subjectId: "org-1",
              status: "ACTIVE",
              payoutsEnabled: true,
              chargesEnabled: true,
              defaultCurrency: "usd",
            } as any)
          : null,
      ),
      syncCapabilities: vi.fn(async () => undefined),
    } as any,
    settlements: settlementsRepo as any,
    settlementLines: settlementLinesRepo as any,
    payeeLedger: payeeLedgerRepo as any,
    orderItems: orderItemsRepo as any,
    resaleListings: {} as any,
    idempotency: {} as any,
    authz: {} as any,
    apiKeys: {} as any,
    organizations: organizationsRepo as any,
    places: {} as any,
    savedLocations: {} as any,
    profiles: {} as any,
    splits: splitsRepo as any,
    eventUnlocks: {
      isUnlocked: vi.fn(async () => true),
    } as any,
    eventHumans: {
      getById: vi.fn(async () => null),
    } as any,
    ticketAttributions: {
      findByIdempotencyKey: vi.fn(async () => null),
      create: vi.fn(async () => ({}) as any),
      findByEventAndOrder: vi.fn(async () => null),
      listByEvent: vi.fn(async () => []),
      listByAttributedHuman: vi.fn(async () => []),
    },
    credits: creditsRepo,
    acceptances: acceptancesRepoImpl as any,
    memberships: membershipsRepoImpl as any,
    membershipTiers: membershipTiersRepoImpl as any,
    feeWaivers: feeWaiversRepo as any,
  } as unknown as TxRepos;

  const repos = {
    events: eventsRepo as unknown as EventsRepo,
    agreements: agreementsRepo as unknown as PayoutTermsRepo,
    payoutTerms: agreementsRepo as unknown as PayoutTermsRepo,
    feePolicies: feePoliciesRepo as unknown as FeePoliciesRepo,
    orders: ordersRepo,
    audit: auditRepo as unknown as AuditRepo,
    profiles: {} as any,
    promos: promosRepo,
    tickets: ticketsRepoImpl as any,
    seats: seatsRepoImpl as any,
    humans: humansRepo as any,
    payees: txRepos.payees as any,
    settlements: settlementsRepo as any,
    settlementLines: settlementLinesRepo as any,
    payeeLedger: payeeLedgerRepo as any,
    orderItems: orderItemsRepo as any,
    orderItemSettlementLines: orderItemSettlementLinesRepo as any,
    resaleListings: {} as any,
    idempotency: {} as any,
    authz: {} as any,
    apiKeys: {} as any,
    organizations: organizationsRepo as any,
    places: {} as any,
    savedLocations: {} as any,
    splits: splitsRepo as any,
    // The SAME fakes the tx hands out, so non-tx reads (previewPromos'
    // member benefits, updateOrderItems' waiver lookup) see what a test seeds.
    memberships: membershipsRepoImpl as any,
    membershipTiers: membershipTiersRepoImpl as any,
    feeWaivers: feeWaiversRepo as any,
    tx: async <T>(fn: (tx: TxRepos) => Promise<T>) => fn(txRepos),
  } as unknown as Repos;

  const createPaymentIntentMock = vi.fn(async () => ({
    id: "pi-123",
    clientSecret: "secret-123",
  }));
  const cancelPaymentIntentMock = vi.fn(async () => ({ canceled: true }));
  const retrievePaymentIntentMock = vi.fn(async () => ({
    id: "pi-123",
    status: "canceled",
    amountReceived: 0,
    currency: "usd",
    metadata: {} as Record<string, string>,
  }));
  const payments: PaymentProcessorPort = {
    createPaymentIntent:
      createPaymentIntentMock as PaymentProcessorPort["createPaymentIntent"],
    refundPaymentIntent: vi.fn(async () => ({
      refundId: "re_123",
    })) as PaymentProcessorPort["refundPaymentIntent"],
    getProcessingFeeForPaymentIntent: vi.fn(async ({ paymentIntentId }) => {
      void paymentIntentId;
      return { feeCents: 0, currency: "usd" };
    }) as PaymentProcessorPort["getProcessingFeeForPaymentIntent"],
    createTransfer: vi.fn(async () => ({
      id: "tr_123",
    })) as PaymentProcessorPort["createTransfer"],
    getChargeIdForPaymentIntent: vi.fn(
      async () => "ch_123",
    ) as PaymentProcessorPort["getChargeIdForPaymentIntent"],
    getPaymentMethodType: vi.fn(async () => ({
      methodType: "card",
    })) as PaymentProcessorPort["getPaymentMethodType"],
    cancelPaymentIntent:
      cancelPaymentIntentMock as PaymentProcessorPort["cancelPaymentIntent"],
    retrievePaymentIntent:
      retrievePaymentIntentMock as unknown as PaymentProcessorPort["retrievePaymentIntent"],
  };

  const idempotencyStore = new Map<string, unknown>();
  const beginMock = vi.fn(async (key: string, _ttl?: number) => true);
  const commitMock = vi.fn(async (key: string, value: unknown) => {
    idempotencyStore.set(key, value);
  });
  const failMock = vi.fn(async () => undefined);
  const getMock = vi.fn(
    async (key: string) => idempotencyStore.get(key) ?? null,
  );
  const runMock = vi.fn(async () => {
    throw new Error("not implemented in tests");
  });

  const idempotency: IdempotencyPort = {
    begin: beginMock as unknown as IdempotencyPort["begin"],
    commit: commitMock as unknown as IdempotencyPort["commit"],
    fail: failMock as unknown as IdempotencyPort["fail"],
    get: getMock as unknown as IdempotencyPort["get"],
    run: runMock as unknown as IdempotencyPort["run"],
    purgeExpired: async () => 0,
  };

  const clock = { now: () => now };
  const logger = createTestLogger();
  // `child()` returns the SAME spy. `createCheckout` emits through a scoped
  // child (`useCase: "createCheckout"`), and the shared fake hands back a
  // FRESH logger per call — so every scoped emit would land on a spy no test
  // can reach, and an assertion on `mocks.logger` would silently never match.
  // Same idiom as the resale/POS suites.
  vi.mocked(logger.child).mockReturnValue(logger);

  const deps: CreateCheckoutDeps = {
    repos,
    payments,
    idempotency,
    clock,
    logger,
    // Make settlement scheduling deterministic for the credit-covered path.
    devInstantPayouts: true,
  };

  const input = {
    actorHumanId: DEFAULT_ACTOR_ID,
    buyerHumanId: DEFAULT_ACTOR_ID,
    eventId: eventRecord.id,
    clientKey: DEFAULT_CLIENT_KEY,
    termsAccepted: true,
    refundPolicyAccepted: true,
    requestIp: "203.0.113.9",
    requestUserAgent: "vitest-agent/1.0",
    items: [
      {
        ticketTypeId: DEFAULT_TICKET_TYPE_ID,
        qty: 2,
      },
    ],
  } as const;

  return {
    deps,
    input,
    defaults: {
      eventId: eventRecord.id,
      actorHumanId: DEFAULT_ACTOR_ID,
      buyerHumanId: DEFAULT_ACTOR_ID,
      ticketTypeId: DEFAULT_TICKET_TYPE_ID,
      orgId: eventRecord.orgId,
      now,
    },
    mocks: {
      logger,
      repos: {
        events: eventsRepo,
        agreements: agreementsRepo,
        payoutTerms: agreementsRepo,
        feePolicies: feePoliciesRepo,
        orders: ordersRepoImpl,
        audit: auditRepo,
        promos: promosRepoImpl,
        seats: seatsRepoImpl,
        tickets: ticketsRepoImpl,
        organizations: organizationsRepo,
        humans: humansRepo,
        credits: creditsRepo,
        splits: splitsRepo,
        settlements: settlementsRepo,
        settlementLines: settlementLinesRepo,
        payeeLedger: payeeLedgerRepo,
        acceptances: acceptancesRepoImpl,
        memberships: membershipsRepoImpl,
        membershipTiers: membershipTiersRepoImpl,
        feeWaivers: feeWaiversRepo,
      },
      payments: {
        createPaymentIntent: createPaymentIntentMock,
        cancelPaymentIntent: cancelPaymentIntentMock,
        retrievePaymentIntent: retrievePaymentIntentMock,
      },
      idempotency: {
        begin: beginMock,
        commit: commitMock,
        fail: failMock,
        get: getMock,
        store: idempotencyStore,
      },
    },
    state: {
      order: orderState,
      seats: seatStore,
      seatSectionCapacity,
      pendingCartHolds,
      creditStore,
      recordRedemptionMock,
      redeemConditionalMock,
      acceptanceStore,
      get lastCreatePendingInput() {
        return lastCreatePendingInput;
      },
      get lastCreateTaxLinesInput() {
        return lastCreateTaxLinesInput;
      },
    },
  } as const;
}
