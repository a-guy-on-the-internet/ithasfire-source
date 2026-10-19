import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

import { formatOrderCode } from "@th/types/order-identifier";

import { createCheckout } from "../create-checkout";
import type { CreateCheckoutDeps } from "../create-checkout";
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
import { claimFreeTickets } from "../claim-free-tickets";
import { SEAT_FENCE_SLACK_SECONDS } from "../_shared/cart-seat-release";
import {
  CURRENT_BUYER_TERMS_TEXT,
  CURRENT_BUYER_TERMS_VERSION,
} from "../../../lib/legal/buyer-terms";
import { CURRENT_CHARGEBACK_TERMS_VERSION } from "../../../lib/payments/chargeback-terms";

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
} from "../../../lib/payments/refund-policy";
import { computeAgreementBasis } from "../finalize-from-payment-intent";
import { computeExpectedPaymentAmount } from "../../../lib/orders/compute-expected-payment-amount";
import { solveProcessingFeeGrossUp } from "../../../lib/pricing/processing-cost-schedule";
import type { LocalTaxImpositionRule } from "../../../lib/pricing/tax-impositions";

/**
 * Seam for the LOCAL imposition table, which ships the Minneapolis
 * entertainment-tax row (MN ZIPs only). `null` (the default) means "use the
 * shipped table", so every pre-existing test here runs against production
 * data; the per-imposition tests below inject a fixture row to prove a second
 * line flows through the real charge.
 */
const localTaxRules = vi.hoisted(() => ({
  rules: null as LocalTaxImpositionRule[] | null,
}));
vi.mock("../../../lib/pricing/tax-impositions", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../lib/pricing/tax-impositions")>();
  return {
    ...actual,
    resolveTaxImpositions: (
      args: Parameters<typeof actual.resolveTaxImpositions>[0],
    ) =>
      actual.resolveTaxImpositions(
        args,
        localTaxRules.rules ?? actual.LOCAL_TAX_IMPOSITION_RULES,
      ),
  };
});

const DEFAULT_EVENT_ID = "11111111-1111-4111-8111-111111111111";
const DEFAULT_ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const DEFAULT_CLIENT_KEY = "idem-key-123";
// The embed guest checkout refuses a key shorter than the widget's own
// (`EMBED_GUEST_CLIENT_KEY_MIN_LENGTH`).
const EMBED_CLIENT_KEY = "emb_1760000000000_a1b2c3d4";
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

/**
 * A policy that charges the buyer nothing on top: no platform fee and no
 * processing fee, so the charge is the face. These fixtures used to get that
 * from ABSORB + buyerFeePct 0; ABSORB is removed
 * (docs/decisions/absorb-removed.md) and every sale grosses up the processing
 * fee, so the zero has to come from the rates.
 */
const ZERO_FEE_POLICY = {
  buyerFeePct: 0,
  processorFeePct: 0,
  processorFixedCents: 0,
} as const;

interface MakeContextOptions {
  ticketPriceCents?: number;
  stripeConnected?: boolean;
  waiverTemplateId?: string | null;
  /**
   * `true` = accepted the CURRENT version; `"stale"` = accepted an older
   * version; `false` = never accepted.
   */
  chargebackTermsAccepted?: boolean | "stale";
  activeCredits?: SeedCredit[];
  /**
   * The fake fee policy's STORED mode. Pricing never reads it (SALE_FEE_MODE):
   * "ABSORB" here models a legacy row that slipped past the migration.
   */
  feeMode?: "PASS_THROUGH" | "ABSORB";
  buyerFeePct?: number;
  /** FeePolicy.processsorFeePct; default 2.9%. */
  processorFeePct?: number;
  /** FeePolicy.processorFixedCents; default 30¢. */
  processorFixedCents?: number;
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

function makeContext(options: MakeContextOptions = {}) {
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
    maxFeeCents: null,
    minFeeCents: 0,
    platformFixedCents,
    feeMode,
    processsorFeePct: options.processorFeePct ?? 0.029,
    processorFixedCents: options.processorFixedCents ?? 30,
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
        id: `item-${itemSequence++}`,
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
    // CAS like the adapter: PENDING, and no PI yet (or already this one).
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
  let txDepth = 0;

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
    findPriceOverridesByIds: vi.fn(
      async ({ seatIds, eventId }: { seatIds: string[]; eventId: string }) =>
        seatIds.flatMap((id) => {
          const seat = seatStore.get(id);
          return seat && seat.eventId === eventId
            ? [{ id, priceOverride: null }]
            : [];
        }),
    ),
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
    countCapacityConsumingForTicketType: vi.fn(async () => issuedForTicketType),
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

  // The tax self-heal stamp is written AFTER the checkout transaction
  // commits, on the non-transaction repos (compare-and-set
  // `fillTaxRateIfUnset`). On the transaction's handle any stamp write is a
  // test failure. Same vi.fn method objects otherwise, so mockImplementation
  // on `ctx.mocks.repos.events.*` reaches both.
  const txEventsTaxWrite = vi.fn(async () => {
    throw new Error("tax self-heal written ON the checkout transaction");
  });
  const nonTxFillTaxRateIfUnset = vi.fn(async () => true);
  (eventsRepo as Record<string, unknown>).fillTaxRateIfUnset =
    nonTxFillTaxRateIfUnset;

  const txRepos = {
    events: {
      ...eventsRepo,
      updateTaxRate: txEventsTaxWrite,
      fillTaxRateIfUnset: txEventsTaxWrite,
    } as unknown as EventsRepo,
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
    tx: async <T>(fn: (tx: TxRepos) => Promise<T>) => {
      // Depth, not a boolean: tracks whether a payments call happens while
      // ANY `repos.tx` callback is still running (see `paymentCallsInTx`).
      txDepth++;
      try {
        return await fn(txRepos);
      } finally {
        txDepth--;
      }
    },
  } as unknown as Repos;

  // Every PaymentProcessorPort call the checkout makes, with whether a
  // transaction was open at the time. No network call may run inside one.
  const paymentCalls: Array<{ method: string; inTx: boolean }> = [];
  const recordPaymentCall = (method: string) => {
    paymentCalls.push({ method, inTx: txDepth > 0 });
  };

  const createPaymentIntentMock = vi.fn(async () => {
    recordPaymentCall("createPaymentIntent");
    return {
      id: "pi-123",
      clientSecret: "secret-123",
    };
  });
  const cancelPaymentIntentMock = vi.fn(async () => {
    recordPaymentCall("cancelPaymentIntent");
    return { canceled: true };
  });
  const retrievePaymentIntentMock = vi.fn(async () => {
    recordPaymentCall("retrievePaymentIntent");
    return {
      id: "pi-123",
      status: "canceled",
      amountReceived: 0,
      currency: "usd",
      metadata: {} as Record<string, string>,
    };
  });
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

  // Pinned to the real adapters (prisma-adapter.ts / redis-adapter.ts):
  // `begin` refuses while a claim or a `failed` record lives; `fail` keeps a
  // `failed` record for 15 minutes that `get` never returns, so it does NOT
  // free the key; only an owner-checked `release` does. Every test finishes
  // well inside 15 minutes, so a `failed` record here blocks for good.
  const idempotencyStore = new Map<string, unknown>();
  const idempotencyHolds = new Map<string, string | null>();
  const beginMock = vi.fn(
    async (key: string, _ttl?: number, ownerToken?: string) => {
      if (idempotencyHolds.has(key)) return false;
      idempotencyHolds.set(key, ownerToken ?? null);
      return true;
    },
  );
  const commitMock = vi.fn(async (key: string, value: unknown) => {
    idempotencyStore.set(key, value);
    idempotencyHolds.set(key, null);
  });
  const failMock = vi.fn(async (key: string) => {
    idempotencyStore.delete(key);
    idempotencyHolds.set(key, null);
  });
  const releaseMock = vi.fn(async (key: string, ownerToken: string) => {
    if (idempotencyHolds.get(key) !== ownerToken) return false;
    idempotencyHolds.delete(key);
    return true;
  });
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
    release: releaseMock as unknown as IdempotencyPort["release"],
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
      txEventsTaxWrite,
      nonTxFillTaxRateIfUnset,
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
        release: releaseMock,
        get: getMock,
        store: idempotencyStore,
      },
    },
    state: {
      order: orderState,
      paymentCalls,
      get txDepth() {
        return txDepth;
      },
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

describe("createCheckout", () => {
  it("refuses an over-long clientKey as invalid input before any claim, transaction or Stripe call", async () => {
    const ctx = makeContext();
    // 129 chars: the Stripe key `pi:checkout:<actor>:<clientKey>:<orderId>`
    // would pass Stripe's 255-character cap.
    await expect(
      createCheckout(ctx.deps, { ...ctx.input, clientKey: "k".repeat(129) }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(ctx.mocks.idempotency.begin).not.toHaveBeenCalled();
    expect(ctx.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
  });

  it("accepts a clientKey at the 128-character bound", async () => {
    const ctx = makeContext();
    const result = await createCheckout(ctx.deps, {
      ...ctx.input,
      clientKey: "k".repeat(128),
    });
    expect(result.clientSecret).toBe("secret-123");
  });

  it("creates a pending order and payment intent", async () => {
    const ctx = makeContext();
    const refundPolicySnapshot = getCurrentRefundPolicySnapshot();

    const result = await createCheckout(ctx.deps, ctx.input);

    expect(result).toEqual({
      orderId: DEFAULT_ORDER_ID,
      clientSecret: "secret-123",
      amountGrossCents: 2000,
      feesPlatformCents: 100,
      buyerFeesCents: 100,
      // PASS_THROUGH (harness default): base 2100 grossed up by Stripe's exact
      // fee → buyer also funds the 94¢ processor fee.
      processorFeeCents: 94,
      feeMode: "PASS_THROUGH",
      taxAmountCents: 0,
      creditAppliedCents: 0,
      holdExpiresAt: "2025-01-01T00:15:00.000Z",
      feeWaivedCents: 0,
    });

    // Read WITH the owner standing, so a banned owner's event is refused
    // (ban-that-sticks).
    expect(ctx.mocks.repos.events.getById).toHaveBeenCalledWith(
      ctx.defaults.eventId,
      { withOwnerStanding: true },
    );
    expect(ctx.mocks.repos.orders.createPending).toHaveBeenCalledWith(
      expect.objectContaining({
        amountGrossCents: 2000,
        feesPlatformCents: 100,
        currency: "usd",
        billingDescriptor: "LAUNCH PARTY",
        refundPolicyAckAt: ctx.defaults.now,
        refundPolicyAckIp: "203.0.113.9",
        checkoutIp: "203.0.113.9",
        refundPolicyVersion: refundPolicySnapshot.version,
        refundPolicyText: refundPolicySnapshot.text,
        // Now creates 2 items with qty=1 each (one per ticket) for granular refund/settlement tracking
        items: [
          expect.objectContaining({
            ticketTypeId: ctx.defaults.ticketTypeId,
            qty: 1,
            unitPriceCents: 1000,
            amountCents: 1000, // Per-ticket amount
          }),
          expect.objectContaining({
            ticketTypeId: ctx.defaults.ticketTypeId,
            qty: 1,
            unitPriceCents: 1000,
            amountCents: 1000, // Per-ticket amount
          }),
        ],
      }),
    );

    expect(ctx.mocks.payments.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 2194,
        currency: "usd",
        metadata: expect.objectContaining({
          orderId: DEFAULT_ORDER_ID,
          eventId: ctx.defaults.eventId,
          buyerHumanId: ctx.defaults.buyerHumanId,
          currency: "usd",
        }),
        idempotencyKey: expect.stringContaining("pi:checkout:"),
        statementDescriptorSuffix: "LAUNCH PARTY",
        // Dashboard/exports summary — 2 TICKET lines and no POS segment.
        // Note DEFAULT_ORDER_ID's head and tail are identical, so this pins
        // the FORMAT, not the head-vs-tail choice; that is pinned by
        // `lib/payments/payment-description.test.ts`, whose fixture id has a
        // head and tail that differ.
        description: `Launch Party — 2 tickets · Order ${formatOrderCode(DEFAULT_ORDER_ID)}`,
      }),
    );

    // Linked by the post-commit CAS, never the unconditional link.
    expect(
      ctx.mocks.repos.orders.linkPaymentIntentIfPending,
    ).toHaveBeenCalledWith(DEFAULT_ORDER_ID, "pi-123");
    expect(ctx.mocks.repos.orders.linkPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.state.order.stripePaymentIntentId).toBe("pi-123");
    expect(ctx.mocks.repos.audit.log).toHaveBeenCalledTimes(2);
    expect(ctx.mocks.idempotency.begin).toHaveBeenCalledTimes(1);
    // The lock must outlive the worst case (two settles, three transactions,
    // PI create, link, unwind ≈ 875 s — see IDEMPOTENCY_TTL_SECONDS), or a
    // retry could start a second checkout while the first is still running.
    expect(ctx.mocks.idempotency.begin).toHaveBeenCalledWith(
      expect.any(String),
      900,
      expect.any(String),
    );
    expect(ctx.mocks.idempotency.commit).toHaveBeenCalledTimes(1);
  });

  it("can disable redirect-capable payment methods for iframe checkout surfaces", async () => {
    const ctx = makeContext();

    await createCheckout(ctx.deps, {
      ...ctx.input,
      allowRedirectPaymentMethods: false,
    });

    expect(ctx.mocks.payments.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        allowRedirectPaymentMethods: false,
      }),
    );
  });

  it("passes allowBankDebit through to the processor, defaulting to true", async () => {
    const defaulted = makeContext();
    await createCheckout(defaulted.deps, defaulted.input);
    expect(defaulted.mocks.payments.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        allowRedirectPaymentMethods: true,
        allowBankDebit: true,
      }),
    );

    // The embed's policy (owner ruling 2026-10-12): redirects on, ACH off.
    const embed = makeContext();
    await createCheckout(embed.deps, {
      ...embed.input,
      allowRedirectPaymentMethods: true,
      allowBankDebit: false,
    });
    expect(embed.mocks.payments.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        allowRedirectPaymentMethods: true,
        allowBankDebit: false,
      }),
    );
  });

  it("rejects when buyerHumanId does not match actorHumanId (impersonation guard)", async () => {
    const ctx = makeContext();
    const impersonationInput = {
      ...ctx.input,
      buyerHumanId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    };

    await expect(
      createCheckout(ctx.deps, impersonationInput),
    ).rejects.toMatchObject({ code: "BUYER_MUST_BE_ACTOR" });

    expect(ctx.mocks.repos.orders.createPending).not.toHaveBeenCalled();
    expect(ctx.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.mocks.idempotency.begin).not.toHaveBeenCalled();
  });

  it("rejects checkout once the event has ended (sales closed)", async () => {
    const ctx = makeContext();
    // Clock is fixed at 2025-01-01; make the event end before that.
    ctx.mocks.repos.events.getById.mockResolvedValueOnce({
      ...(await ctx.mocks.repos.events.getById(ctx.defaults.eventId)),
      endsAt: new Date("2024-12-31T23:00:00.000Z"),
    });

    await expect(createCheckout(ctx.deps, ctx.input)).rejects.toMatchObject({
      code: "EVENT_SALES_CLOSED",
    });

    expect(ctx.mocks.repos.orders.createPending).not.toHaveBeenCalled();
    expect(ctx.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
  });

  it("throws terms_required when termsAccepted is not provided", async () => {
    const ctx = makeContext();
    const { termsAccepted: _, ...inputWithoutTerms } = ctx.input;

    await expect(
      createCheckout(ctx.deps, inputWithoutTerms),
    ).rejects.toMatchObject({ code: "TERMS_REQUIRED" });

    expect(ctx.mocks.repos.orders.createPending).not.toHaveBeenCalled();
    expect(ctx.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.mocks.idempotency.begin).not.toHaveBeenCalled();
  });

  it("throws refund_policy_required when refundPolicyAccepted is not provided before side effects", async () => {
    const ctx = makeContext();
    const { refundPolicyAccepted: _, ...inputWithoutRefundPolicy } = ctx.input;

    await expect(
      createCheckout(ctx.deps, inputWithoutRefundPolicy),
    ).rejects.toMatchObject({ code: "REFUND_POLICY_REQUIRED" });

    expect(ctx.mocks.repos.orders.createPending).not.toHaveBeenCalled();
    expect(ctx.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.mocks.idempotency.get).not.toHaveBeenCalled();
    expect(ctx.mocks.idempotency.begin).not.toHaveBeenCalled();
  });

  it("throws refund_policy_required when refundPolicyAccepted is false before side effects", async () => {
    const ctx = makeContext();

    await expect(
      createCheckout(ctx.deps, { ...ctx.input, refundPolicyAccepted: false }),
    ).rejects.toMatchObject({ code: "REFUND_POLICY_REQUIRED" });

    expect(ctx.mocks.repos.orders.createPending).not.toHaveBeenCalled();
    expect(ctx.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.mocks.idempotency.get).not.toHaveBeenCalled();
    expect(ctx.mocks.idempotency.begin).not.toHaveBeenCalled();
  });

  // ── Waiver gate ──────────────────────────────────────────────────────────
  // A malicious client can skip the frontend checkbox; the server must
  // reject the order when the event carries a waiver template and
  // waiverAccepted !== true. The gate fires inside the prep tx (after
  // idempotency.begin), so we don't assert begin was skipped — we assert
  // no order / payment intent / hold side-effects landed.
  it("throws waiver_required when event has a waiver template and waiverAccepted is omitted", async () => {
    const ctx = makeContext({ waiverTemplateId: "template-1" });
    const { waiverAccepted: _, ...inputWithoutWaiver } =
      ctx.input as typeof ctx.input & {
        waiverAccepted?: boolean;
      };

    await expect(
      createCheckout(ctx.deps, inputWithoutWaiver),
    ).rejects.toMatchObject({ code: "WAIVER_REQUIRED" });

    expect(ctx.mocks.repos.orders.createPending).not.toHaveBeenCalled();
    expect(ctx.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
  });

  it("throws waiver_required when event has a waiver template and waiverAccepted=false", async () => {
    const ctx = makeContext({ waiverTemplateId: "template-1" });

    await expect(
      createCheckout(ctx.deps, { ...ctx.input, waiverAccepted: false }),
    ).rejects.toMatchObject({ code: "WAIVER_REQUIRED" });

    expect(ctx.mocks.repos.orders.createPending).not.toHaveBeenCalled();
    expect(ctx.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
  });

  it("succeeds when event has no waiver template even if waiverAccepted is omitted", async () => {
    const ctx = makeContext();
    const { waiverAccepted: _, ...inputWithoutWaiver } =
      ctx.input as typeof ctx.input & {
        waiverAccepted?: boolean;
      };

    const result = await createCheckout(ctx.deps, inputWithoutWaiver);

    expect(result.orderId).toBe(DEFAULT_ORDER_ID);
    expect(ctx.mocks.repos.orders.createPending).toHaveBeenCalled();
  });

  it("succeeds when event has a waiver template and waiverAccepted=true", async () => {
    const ctx = makeContext({ waiverTemplateId: "template-1" });

    const result = await createCheckout(ctx.deps, {
      ...ctx.input,
      waiverAccepted: true,
    });

    expect(result.orderId).toBe(DEFAULT_ORDER_ID);
    expect(ctx.mocks.repos.orders.createPending).toHaveBeenCalled();
  });

  it("applies promo discounts and creates holds", async () => {
    const ctx = makeContext();

    const promo: PromoRecord = {
      id: "promo-1",
      code: "SAVE5",
      codeNormalized: "SAVE5",
      status: "ACTIVE",
      kind: "AMOUNT",
      scope: "EVENT",
      scopeId: ctx.defaults.eventId,
      value: 500,
      currency: "usd",
      minOrderCents: 0,
      maxRedemptions: undefined,
      maxRedemptionsPerHuman: undefined,
      maxDiscountCents: undefined,
      stackable: false,
      isPublic: false,
      startsAt: undefined,
      endsAt: undefined,
      createdAt: ctx.defaults.now,
      updatedAt: ctx.defaults.now,
    };

    ctx.mocks.repos.promos.findActiveByCodes.mockResolvedValue([promo]);
    ctx.mocks.repos.promos.getRedemptionStats.mockResolvedValue({
      totalRedemptions: 0,
      redemptionsForHuman: 0,
    });

    const input = { ...ctx.input, promoCodes: ["save5"] } as const;

    const result = await createCheckout(ctx.deps, input);

    expect(result).toEqual({
      orderId: DEFAULT_ORDER_ID,
      clientSecret: "secret-123",
      amountGrossCents: 1500,
      feesPlatformCents: 100,
      buyerFeesCents: 100,
      // PASS_THROUGH: post-promo base 1500 + 100 fee = 1600, grossed up by 79.
      processorFeeCents: 79,
      feeMode: "PASS_THROUGH",
      taxAmountCents: 0,
      creditAppliedCents: 0,
      holdExpiresAt: "2025-01-01T00:15:00.000Z",
      feeWaivedCents: 0,
    });

    expect(ctx.mocks.repos.orders.createPending).toHaveBeenCalledWith(
      expect.objectContaining({
        amountGrossCents: 1500,
        currency: "usd",
        items: expect.arrayContaining([
          expect.objectContaining({
            kind: "discount",
            amountCents: -500,
            meta: expect.objectContaining({ promoId: promo.id }),
          }),
        ]),
      }),
    );

    expect(ctx.mocks.payments.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 1679,
        // REGRESSION GUARD for the description's ticket count: this order
        // carries a negative `discount` line alongside its 2 ticket lines, so
        // a reducer that forgot `item.kind === "ticket"` would say "3 tickets".
        description: `Launch Party \u2014 2 tickets \u00b7 Order ${formatOrderCode(DEFAULT_ORDER_ID)}`,
      }),
    );

    expect(ctx.mocks.repos.promos.createHolds).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.repos.promos.createHolds).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          promoId: promo.id,
          orderId: DEFAULT_ORDER_ID,
          code: "SAVE5",
          amountDiscountCents: 500,
          humanId: ctx.defaults.buyerHumanId,
          idempotencyKey: `order:${DEFAULT_ORDER_ID}:promo:${promo.id}`,
        }),
      ]),
      { now: expect.any(Date) },
    );
  });

  it("holds reserved seats when seat assignments are provided", async () => {
    const ctx = makeContext();

    const seatSectionId = "section-1";
    ctx.mocks.repos.events.listTicketTypes.mockResolvedValue([
      {
        id: ctx.defaults.ticketTypeId,
        priceCents: 1000,
        status: "ACTIVE" as const,
        capacity: 10,
        seatSectionId,
        resaleAllowed: false,
        resaleCapCents: null,
        transferAllowed: true,
      },
    ]);

    const seatIdA = "77777777-7777-4777-8777-777777777777";
    const seatIdB = "88888888-8888-4888-8888-888888888888";

    ctx.state.seats.set(seatIdA, {
      eventId: ctx.defaults.eventId,
      seatSectionId,
      status: "AVAILABLE",
    });
    ctx.state.seats.set(seatIdB, {
      eventId: ctx.defaults.eventId,
      seatSectionId,
      status: "AVAILABLE",
    });

    const input = {
      ...ctx.input,
      items: [
        {
          ticketTypeId: ctx.defaults.ticketTypeId,
          qty: 2,
          seatIds: [seatIdA, seatIdB],
        },
      ],
    } as const;

    const result = await createCheckout(ctx.deps, input);

    expect(result).toEqual({
      orderId: DEFAULT_ORDER_ID,
      clientSecret: "secret-123",
      amountGrossCents: 2000,
      feesPlatformCents: 100,
      buyerFeesCents: 100,
      processorFeeCents: 94,
      feeMode: "PASS_THROUGH",
      taxAmountCents: 0,
      creditAppliedCents: 0,
      holdExpiresAt: "2025-01-01T00:15:00.000Z",
      feeWaivedCents: 0,
    });

    expect(ctx.mocks.repos.seats.findByIdsForUpdate).toHaveBeenCalledWith({
      seatIds: [seatIdA, seatIdB],
      eventId: ctx.defaults.eventId,
    });

    expect(ctx.mocks.repos.tickets.findBySeatIds).toHaveBeenCalledWith([
      seatIdA,
      seatIdB,
    ]);

    expect(ctx.mocks.repos.seats.updateStatuses).toHaveBeenCalledWith({
      seatIds: [seatIdA, seatIdB],
      status: "HELD",
      updatedAt: ctx.defaults.now,
    });

    const pending = ctx.state.lastCreatePendingInput;
    expect(pending).not.toBeNull();
    const ticketItems =
      pending?.items.filter((item) => item.kind === "ticket") ?? [];
    expect(ticketItems).toHaveLength(2);

    const meta0 = ticketItems[0]?.meta as
      | { seatIds?: string[]; seatHoldExpiresAt?: string }
      | undefined;
    const meta1 = ticketItems[1]?.meta as
      | { seatIds?: string[]; seatHoldExpiresAt?: string }
      | undefined;
    expect(meta0).toMatchObject({ seatIds: [seatIdA] });
    expect(meta1).toMatchObject({ seatIds: [seatIdB] });

    const expectedExpiry = new Date(
      ctx.defaults.now.getTime() + 900 * 1000,
    ).toISOString();
    expect(meta0?.seatHoldExpiresAt).toBe(expectedExpiry);
    expect(meta1?.seatHoldExpiresAt).toBe(expectedExpiry);

    expect(ctx.state.seats.get(seatIdA)?.status).toBe("HELD");
    expect(ctx.state.seats.get(seatIdB)?.status).toBe("HELD");
  });

  it("holds general admission seats using section capacity", async () => {
    const ctx = makeContext();

    const seatSectionId = "section-ga";
    ctx.state.seatSectionCapacity.set(seatSectionId, 5);
    ctx.mocks.repos.events.listTicketTypes.mockResolvedValue([
      {
        id: ctx.defaults.ticketTypeId,
        priceCents: 1000,
        status: "ACTIVE" as const,
        capacity: 10,
        seatSectionId,
        resaleAllowed: false,
        resaleCapCents: null,
        transferAllowed: true,
      },
    ]);

    const input = {
      ...ctx.input,
      items: [{ ticketTypeId: ctx.defaults.ticketTypeId, qty: 2 }],
    } as const;

    const result = await createCheckout(ctx.deps, input);

    expect(result).toEqual({
      orderId: DEFAULT_ORDER_ID,
      clientSecret: "secret-123",
      amountGrossCents: 2000,
      feesPlatformCents: 100,
      buyerFeesCents: 100,
      processorFeeCents: 94,
      feeMode: "PASS_THROUGH",
      taxAmountCents: 0,
      creditAppliedCents: 0,
      holdExpiresAt: "2025-01-01T00:15:00.000Z",
      feeWaivedCents: 0,
    });
    expect(ctx.mocks.repos.seats.reserveForHold).toHaveBeenCalledWith(
      expect.objectContaining({
        seatSectionId,
        eventId: ctx.defaults.eventId,
        qty: 2,
        heldAt: ctx.defaults.now,
      }),
    );

    const pending = ctx.state.lastCreatePendingInput;
    const ticketItems =
      pending?.items.filter((item) => item.kind === "ticket") ?? [];
    expect(ticketItems).toHaveLength(2);
    for (const item of ticketItems) {
      const meta = item.meta as { seatIds?: string[] } | undefined;
      expect(meta?.seatIds).toHaveLength(1);
    }
  });

  it("fails when promo code is invalid", async () => {
    const ctx = makeContext();

    ctx.mocks.repos.promos.findActiveByCodes.mockResolvedValue([]);

    await expect(
      createCheckout(ctx.deps, { ...ctx.input, promoCodes: ["INVALID"] }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: "promo_not_found",
      promoCode: "INVALID",
    });

    expect(ctx.mocks.repos.orders.createPending).not.toHaveBeenCalled();
    expect(ctx.mocks.repos.promos.createHolds).not.toHaveBeenCalled();
  });

  it("rejects promos that would make the order free", async () => {
    const ctx = makeContext();

    const promo: PromoRecord = {
      id: "promo-2",
      code: "FREE",
      codeNormalized: "FREE",
      status: "ACTIVE",
      kind: "AMOUNT",
      scope: "EVENT",
      scopeId: ctx.defaults.eventId,
      value: 2000,
      currency: "usd",
      minOrderCents: 0,
      maxRedemptions: undefined,
      maxRedemptionsPerHuman: undefined,
      maxDiscountCents: undefined,
      stackable: false,
      isPublic: false,
      startsAt: undefined,
      endsAt: undefined,
      createdAt: ctx.defaults.now,
      updatedAt: ctx.defaults.now,
    };

    ctx.mocks.repos.promos.findActiveByCodes.mockResolvedValue([promo]);
    ctx.mocks.repos.promos.getRedemptionStats.mockResolvedValue({
      totalRedemptions: 0,
      redemptionsForHuman: 0,
    });

    const result = await createCheckout(ctx.deps, {
      ...ctx.input,
      promoCodes: ["free"],
    });

    expect(result).toEqual({
      orderId: DEFAULT_ORDER_ID,
      clientSecret: null,
      amountGrossCents: 0,
      // A promo that cancels the whole subtotal produces a genuinely free
      // order, so it carries no platform fee — the computation's fees were
      // derived from the undiscounted ticket prices and are zeroed before
      // the order is written.
      feesPlatformCents: 0,
      buyerFeesCents: 0,
      processorFeeCents: 0,
      feeMode: "PASS_THROUGH",
      taxAmountCents: 0,
      creditAppliedCents: 0,
      holdExpiresAt: null,
    });
    expect(ctx.mocks.repos.orders.createPending).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
  });

  it("caps stackable promo discounts at the order subtotal", async () => {
    const ctx = makeContext();

    const firstPromo: PromoRecord = {
      id: "promo-stackable-1",
      code: "STACK15A",
      codeNormalized: "STACK15A",
      status: "ACTIVE",
      kind: "AMOUNT",
      scope: "EVENT",
      scopeId: ctx.defaults.eventId,
      value: 1500,
      currency: "usd",
      minOrderCents: 0,
      maxRedemptions: undefined,
      maxRedemptionsPerHuman: undefined,
      maxDiscountCents: undefined,
      stackable: true,
      isPublic: false,
      startsAt: undefined,
      endsAt: undefined,
      createdAt: ctx.defaults.now,
      updatedAt: ctx.defaults.now,
    };
    const secondPromo: PromoRecord = {
      ...firstPromo,
      id: "promo-stackable-2",
      code: "STACK15B",
      codeNormalized: "STACK15B",
    };

    ctx.mocks.repos.promos.findActiveByCodes.mockResolvedValue([
      firstPromo,
      secondPromo,
    ]);
    ctx.mocks.repos.promos.getRedemptionStats.mockResolvedValue({
      totalRedemptions: 0,
      redemptionsForHuman: 0,
    });

    const result = await createCheckout(ctx.deps, {
      ...ctx.input,
      promoCodes: ["stack15a", "stack15b"],
    });

    expect(result).toEqual({
      orderId: DEFAULT_ORDER_ID,
      clientSecret: null,
      amountGrossCents: 0,
      // Stacked promos that consume the whole subtotal leave a free order —
      // no platform fee survives onto it.
      feesPlatformCents: 0,
      buyerFeesCents: 0,
      processorFeeCents: 0,
      feeMode: "PASS_THROUGH",
      taxAmountCents: 0,
      creditAppliedCents: 0,
      holdExpiresAt: null,
    });
    expect(ctx.state.lastCreatePendingInput?.amountGrossCents).toBe(0);
    expect(ctx.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.mocks.repos.orders.createPending).toHaveBeenCalledWith(
      expect.objectContaining({
        amountGrossCents: 0,
        items: expect.arrayContaining([
          expect.objectContaining({
            kind: "discount",
            amountCents: -1500,
            meta: expect.objectContaining({ promoId: firstPromo.id }),
          }),
          expect.objectContaining({
            kind: "discount",
            amountCents: -500,
            meta: expect.objectContaining({ promoId: secondPromo.id }),
          }),
        ]),
      }),
    );
    expect(ctx.mocks.repos.promos.createHolds).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          promoId: firstPromo.id,
          amountDiscountCents: 1500,
        }),
        expect.objectContaining({
          promoId: secondPromo.id,
          amountDiscountCents: 500,
        }),
      ]),
      { now: expect.any(Date) },
    );
  });

  it("does not create a payment intent when the ticket price is zero", async () => {
    const ctx = makeContext({ ticketPriceCents: 0 });

    const result = await createCheckout(ctx.deps, ctx.input);

    expect(result).toEqual({
      orderId: DEFAULT_ORDER_ID,
      clientSecret: null,
      amountGrossCents: 0,
      feesPlatformCents: 0,
      buyerFeesCents: 0,
      processorFeeCents: 0,
      feeMode: "PASS_THROUGH",
      taxAmountCents: 0,
      creditAppliedCents: 0,
      holdExpiresAt: null,
    });
    expect(ctx.mocks.repos.orders.createPending).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
  });

  it("holds and sells assigned seats for zero-price checkout", async () => {
    const ctx = makeContext({ ticketPriceCents: 0 });

    const seatSectionId = "section-free";
    ctx.mocks.repos.events.listTicketTypes.mockResolvedValue([
      {
        id: ctx.defaults.ticketTypeId,
        priceCents: 0,
        status: "ACTIVE" as const,
        capacity: 10,
        seatSectionId,
        resaleAllowed: false,
        resaleCapCents: null,
        transferAllowed: true,
      },
    ]);

    const previousSeatId = "99999999-9999-4999-8999-999999999999";
    const seatId = "77777777-7777-4777-8777-777777777777";
    ctx.state.order.items = [
      {
        id: "pending-item-1",
        kind: "ticket",
        ticketTypeId: ctx.defaults.ticketTypeId,
        qty: 1,
        unitPriceCents: 0,
        amountCents: 0,
        meta: { seatIds: [previousSeatId] },
      } as OrderItemRecord,
    ];
    ctx.state.seats.set(previousSeatId, {
      eventId: ctx.defaults.eventId,
      seatSectionId,
      status: "HELD",
      label: "A1",
      row: "A",
      number: 1,
    });
    ctx.state.seats.set(seatId, {
      eventId: ctx.defaults.eventId,
      seatSectionId,
      status: "AVAILABLE",
      label: "A2",
      row: "A",
      number: 2,
    });

    const result = await createCheckout(ctx.deps, {
      ...ctx.input,
      pendingOrderId: DEFAULT_ORDER_ID,
      items: [
        { ticketTypeId: ctx.defaults.ticketTypeId, qty: 1, seatIds: [seatId] },
      ],
    });

    expect(result).toEqual({
      orderId: DEFAULT_ORDER_ID,
      clientSecret: null,
      amountGrossCents: 0,
      feesPlatformCents: 0,
      buyerFeesCents: 0,
      processorFeeCents: 0,
      feeMode: "PASS_THROUGH",
      taxAmountCents: 0,
      creditAppliedCents: 0,
      holdExpiresAt: null,
    });
    expect(ctx.mocks.repos.seats.releaseSeats).toHaveBeenCalledWith({
      seatIds: [previousSeatId],
      releasedAt: ctx.defaults.now,
      // This is the FREE path (`claimFreeTickets`), which now fences its
      // carried-over release the same way the paid path does. The superseded
      // cart's `occurredAt` is the fixture's `now`, so the fence is that plus
      // `SEAT_FENCE_SLACK_SECONDS`.
      heldBefore: new Date(
        ctx.defaults.now.getTime() + SEAT_FENCE_SLACK_SECONDS * 1000,
      ),
    });
    expect(ctx.mocks.repos.seats.findByIdsForUpdate).toHaveBeenCalledWith({
      seatIds: [seatId],
      eventId: ctx.defaults.eventId,
    });
    expect(ctx.mocks.repos.seats.updateStatuses).toHaveBeenNthCalledWith(1, {
      seatIds: [seatId],
      status: "HELD",
      updatedAt: ctx.defaults.now,
    });
    expect(ctx.mocks.repos.seats.updateStatuses).toHaveBeenLastCalledWith({
      seatIds: [seatId],
      status: "SOLD",
      updatedAt: ctx.defaults.now,
    });
    expect(ctx.mocks.repos.tickets.create).toHaveBeenCalledWith(
      expect.objectContaining({ seatId }),
    );
    expect(ctx.state.seats.get(previousSeatId)?.status).toBe("AVAILABLE");
    expect(ctx.state.seats.get(seatId)?.status).toBe("SOLD");

    const ticketItems =
      ctx.state.lastCreatePendingInput?.items.filter(
        (item) => item.kind === "ticket",
      ) ?? [];
    expect(ticketItems).toHaveLength(1);
    expect(ticketItems[0]?.meta).toMatchObject({ seatIds: [seatId] });
  });

  it("holds and sells assigned seats for fully-discounted checkout", async () => {
    const ctx = makeContext();

    const seatSectionId = "section-discounted";
    ctx.mocks.repos.events.listTicketTypes.mockResolvedValue([
      {
        id: ctx.defaults.ticketTypeId,
        priceCents: 1000,
        status: "ACTIVE" as const,
        capacity: 10,
        seatSectionId,
        resaleAllowed: false,
        resaleCapCents: null,
        transferAllowed: true,
      },
    ]);

    const seatId = "88888888-8888-4888-8888-888888888888";
    ctx.state.seats.set(seatId, {
      eventId: ctx.defaults.eventId,
      seatSectionId,
      status: "AVAILABLE",
      label: "B1",
      row: "B",
      number: 1,
    });

    const promo: PromoRecord = {
      id: "promo-free-seat",
      code: "SEATFREE",
      codeNormalized: "SEATFREE",
      status: "ACTIVE",
      kind: "AMOUNT",
      scope: "EVENT",
      scopeId: ctx.defaults.eventId,
      value: 1000,
      currency: "usd",
      minOrderCents: 0,
      maxRedemptions: undefined,
      maxRedemptionsPerHuman: undefined,
      maxDiscountCents: undefined,
      stackable: false,
      isPublic: false,
      startsAt: undefined,
      endsAt: undefined,
      createdAt: ctx.defaults.now,
      updatedAt: ctx.defaults.now,
    };

    ctx.mocks.repos.promos.findActiveByCodes.mockResolvedValue([promo]);
    ctx.mocks.repos.promos.getRedemptionStats.mockResolvedValue({
      totalRedemptions: 0,
      redemptionsForHuman: 0,
    });

    const result = await createCheckout(ctx.deps, {
      ...ctx.input,
      promoCodes: ["seatfree"],
      items: [
        { ticketTypeId: ctx.defaults.ticketTypeId, qty: 1, seatIds: [seatId] },
      ],
    });

    expect(result).toEqual({
      orderId: DEFAULT_ORDER_ID,
      clientSecret: null,
      amountGrossCents: 0,
      // Fully discounted, so fee-free — assigned seating doesn't change that.
      feesPlatformCents: 0,
      buyerFeesCents: 0,
      processorFeeCents: 0,
      feeMode: "PASS_THROUGH",
      taxAmountCents: 0,
      creditAppliedCents: 0,
      holdExpiresAt: null,
    });
    expect(ctx.mocks.repos.seats.updateStatuses).toHaveBeenNthCalledWith(1, {
      seatIds: [seatId],
      status: "HELD",
      updatedAt: ctx.defaults.now,
    });
    expect(ctx.mocks.repos.seats.updateStatuses).toHaveBeenLastCalledWith({
      seatIds: [seatId],
      status: "SOLD",
      updatedAt: ctx.defaults.now,
    });
    expect(ctx.mocks.repos.tickets.create).toHaveBeenCalledWith(
      expect.objectContaining({ seatId }),
    );
    expect(ctx.mocks.repos.promos.createHolds).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.repos.promos.confirmHoldsForOrder).toHaveBeenCalledWith({
      orderId: DEFAULT_ORDER_ID,
      confirmedAt: ctx.defaults.now,
    });
    expect(ctx.state.seats.get(seatId)?.status).toBe("SOLD");

    const ticketItems =
      ctx.state.lastCreatePendingInput?.items.filter(
        (item) => item.kind === "ticket",
      ) ?? [];
    expect(ticketItems).toHaveLength(1);
    expect(ticketItems[0]?.meta).toMatchObject({ seatIds: [seatId] });
  });

  it("blocks paid checkout when Stripe isn't connected", async () => {
    const ctx = makeContext({ stripeConnected: false });

    await expect(createCheckout(ctx.deps, ctx.input)).rejects.toMatchObject({
      code: "STRIPE_NOT_CONNECTED",
    });

    // Order is created inside the transaction before PI creation.
    expect(ctx.mocks.repos.orders.createPending).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
  });

  it("blocks paid checkout when chargeback terms are not accepted before order or payment side effects", async () => {
    const ctx = makeContext({ chargebackTermsAccepted: false });

    await expect(createCheckout(ctx.deps, ctx.input)).rejects.toMatchObject({
      code: "chargeback_terms_required",
      message: "chargeback_terms_required",
    });

    expect(ctx.mocks.repos.orders.createPending).not.toHaveBeenCalled();
    expect(ctx.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
  });

  // Checkout is a VERSION-AGNOSTIC backstop: a terms version bump must never
  // hard-fail sales on already-published paid events. The strict gate lives
  // at Stripe Connect onboarding.
  it("allows paid checkout when the owner's chargeback acceptance is a stale version", async () => {
    const ctx = makeContext({ chargebackTermsAccepted: "stale" });

    const result = await createCheckout(ctx.deps, ctx.input);

    expect(result.clientSecret).not.toBeNull();
    expect(ctx.mocks.repos.organizations.getById).toHaveBeenCalledWith("org-1");
    expect(ctx.mocks.repos.orders.createPending).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.payments.createPaymentIntent).toHaveBeenCalledTimes(1);
  });

  it("does not require chargeback terms for free checkout", async () => {
    const ctx = makeContext({
      ticketPriceCents: 0,
      chargebackTermsAccepted: false,
    });

    const result = await createCheckout(ctx.deps, ctx.input);

    expect(result.clientSecret).toBeNull();
    expect(ctx.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
  });

  it("replays the cached result when idempotent input matches", async () => {
    const ctx = makeContext();

    const first = await createCheckout(ctx.deps, ctx.input);

    ctx.mocks.repos.orders.createPending.mockClear();
    ctx.mocks.payments.createPaymentIntent.mockClear();
    ctx.mocks.idempotency.begin.mockClear();
    ctx.mocks.idempotency.commit.mockClear();

    const second = await createCheckout(ctx.deps, ctx.input);

    expect(second).toEqual(first);
    expect(ctx.mocks.repos.orders.createPending).not.toHaveBeenCalled();
    expect(ctx.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.mocks.idempotency.begin).not.toHaveBeenCalled();
    expect(ctx.mocks.idempotency.commit).not.toHaveBeenCalled();
  });

  it("keeps the claim when the result cannot be stored, so a retry cannot price a second order", async () => {
    const ctx = makeContext();
    ctx.mocks.idempotency.commit.mockRejectedValueOnce(
      new Error("store unavailable"),
    );

    await expect(createCheckout(ctx.deps, ctx.input)).rejects.toThrow(
      "store unavailable",
    );

    // The order is committed and linked; freeing the key would let the
    // buyer's retry run a second checkout beside it.
    expect(ctx.state.order.stripePaymentIntentId).toBe("pi-123");
    expect(ctx.mocks.idempotency.release).not.toHaveBeenCalled();
    expect(ctx.mocks.idempotency.fail).not.toHaveBeenCalled();
    await expect(createCheckout(ctx.deps, ctx.input)).rejects.toMatchObject({
      code: "IDEMPOTENCY_LOCK_IN_PROGRESS",
    });
    expect(ctx.mocks.payments.createPaymentIntent).toHaveBeenCalledTimes(1);
  });

  it("rejects idempotency collisions when payload differs", async () => {
    const ctx = makeContext();

    ctx.mocks.idempotency.store.set(
      `checkout:${DEFAULT_ACTOR_ID}:${DEFAULT_CLIENT_KEY}`,
      {
        payloadHash: "different",
        response: { orderId: DEFAULT_ORDER_ID, clientSecret: "secret-old" },
        orderItemId: null,
      },
    );

    await expect(createCheckout(ctx.deps, ctx.input)).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_CONFLICT",
    });

    expect(ctx.mocks.repos.orders.createPending).not.toHaveBeenCalled();
    expect(ctx.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
  });
});

describe("createCheckout — platform credit auto-apply", () => {
  // Default fixture: ticketPrice 1000 × qty 2 = subtotal 2000, buyerFee 100,
  // tax 0. PASS_THROUGH (harness default) grosses up the processor fee over the
  // post-tax base 2100 (+94) → PaymentIntent 2194 with no credit. Credits only
  // offset the 2000 subtotal, never the fees/processor, so a fully-subtotal-
  // covered order still charges 194 (100 platform + 94 processor).
  const NO_CREDIT_PI = 2194;
  const SUBTOTAL = 2000;
  // Charge left after credit fully covers the subtotal: platform + processor.
  const FEES_ONLY_PI = 194;

  it("reduces the PaymentIntent by the credit but keeps amountGrossCents (org entitlement) unchanged", async () => {
    // Baseline with no credit.
    const baseline = makeContext();
    await createCheckout(baseline.deps, baseline.input);
    const baselineGross =
      baseline.state.lastCreatePendingInput?.amountGrossCents;
    expect(baselineGross).toBe(SUBTOTAL);
    expect(baseline.mocks.payments.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: NO_CREDIT_PI }),
    );

    // Same order, now with a $5.00 credit.
    const ctx = makeContext({
      activeCredits: [{ id: "credit-1", balanceCents: 500 }],
    });
    await createCheckout(ctx.deps, ctx.input);

    // INVARIANT: organiser basis (amountGrossCents) is identical to the
    // no-credit case. The credit only reduces the buyer's Stripe charge.
    expect(ctx.state.lastCreatePendingInput?.amountGrossCents).toBe(
      baselineGross,
    );
    expect(ctx.mocks.payments.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: NO_CREDIT_PI - 500,
        // REGRESSION GUARD for the description's ticket count: a negative
        // `platform_credit` line rides in the same `orderItems` array as the
        // 2 ticket lines and must not be counted as a ticket.
        description: `Launch Party \u2014 2 tickets \u00b7 Order ${formatOrderCode(DEFAULT_ORDER_ID)}`,
      }),
    );

    // A negative platform_credit line item was appended.
    const items = ctx.state.lastCreatePendingInput?.items ?? [];
    const creditItem = items.find(
      (item: { kind?: string }) => item.kind === "platform_credit",
    );
    expect(creditItem).toMatchObject({
      kind: "platform_credit",
      amountCents: -500,
      unitPriceCents: -500,
    });

    // Redemption row written for the debited amount (insert-only); the
    // balance debit is performed by the atomic redeemConditional call.
    expect(ctx.state.recordRedemptionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        creditId: "credit-1",
        orderId: DEFAULT_ORDER_ID,
        amountCents: 500,
      }),
    );
    expect(ctx.state.redeemConditionalMock).toHaveBeenCalledWith(
      expect.objectContaining({ creditId: "credit-1", requestedCents: 500 }),
    );
    expect(ctx.state.creditStore.get("credit-1")?.balanceCents).toBe(0);

    // INVARIANT (zero-charge case): when a credit covers the ENTIRE charge,
    // no PaymentIntent is created so the splits/ledger credits that the Stripe
    // webhook would normally write must be produced inline — at the same
    // organiser basis a fully-charged order would owe. Here the platform
    // funds the whole face value, so the organiser is still credited 2000.
    const covered = makeContext({
      ...ZERO_FEE_POLICY,
      activeCredits: [{ id: "credit-cover", balanceCents: SUBTOTAL }],
    });
    await createCheckout(covered.deps, covered.input);

    expect(covered.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
    const coveredBasis =
      (covered.state.lastCreatePendingInput?.amountGrossCents ?? 0) -
      (covered.state.lastCreatePendingInput?.feesPlatformCents ?? 0);
    expect(coveredBasis).toBe(baselineGross);
    expect(covered.mocks.repos.splits.upsertForOrder).toHaveBeenCalledWith(
      DEFAULT_ORDER_ID,
      [
        expect.objectContaining({
          payeeId: DEFAULT_PAYEE_ID,
          amountCents: baselineGross,
        }),
      ],
    );
    expect(
      covered.mocks.repos.payeeLedger.settlementCredit,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        payeeId: DEFAULT_PAYEE_ID,
        amountCents: baselineGross,
      }),
    );
    // Step B of the ledger cutover: revenue writes NO settlement rows.
    expect(covered.mocks.repos.settlements.create).not.toHaveBeenCalled();
  });

  it("partially consumes a credit larger than the subtotal and carries the balance forward", async () => {
    const ctx = makeContext({
      activeCredits: [{ id: "credit-big", balanceCents: 3000 }],
    });
    await createCheckout(ctx.deps, ctx.input);

    // Only the subtotal (2000) is redeemable; fees/tax are never offset.
    expect(ctx.mocks.payments.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: FEES_ONLY_PI }),
    );
    expect(ctx.state.recordRedemptionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        creditId: "credit-big",
        amountCents: SUBTOTAL,
      }),
    );
    expect(ctx.state.creditStore.get("credit-big")?.balanceCents).toBe(1000);
  });

  it("consumes multiple credits soonest-first until the subtotal is covered", async () => {
    const ctx = makeContext({
      activeCredits: [
        { id: "credit-a", balanceCents: 1200 },
        { id: "credit-b", balanceCents: 1200 },
      ],
    });
    await createCheckout(ctx.deps, ctx.input);

    // 1200 + 800 = 2000 consumed; second credit retains 400.
    expect(ctx.state.recordRedemptionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        creditId: "credit-a",
        amountCents: 1200,
      }),
    );
    expect(ctx.state.recordRedemptionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        creditId: "credit-b",
        amountCents: 800,
      }),
    );
    expect(ctx.state.creditStore.get("credit-a")?.balanceCents).toBe(0);
    expect(ctx.state.creditStore.get("credit-b")?.balanceCents).toBe(400);
    expect(ctx.mocks.payments.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: FEES_ONLY_PI }),
    );
  });

  it("ignores credits in a different currency", async () => {
    const ctx = makeContext({
      activeCredits: [{ id: "credit-eur", balanceCents: 500, currency: "eur" }],
    });
    await createCheckout(ctx.deps, ctx.input);

    expect(ctx.mocks.payments.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: NO_CREDIT_PI }),
    );
    expect(ctx.state.recordRedemptionMock).not.toHaveBeenCalled();
    const items = ctx.state.lastCreatePendingInput?.items ?? [];
    expect(
      items.some((item: { kind?: string }) => item.kind === "platform_credit"),
    ).toBe(false);
  });

  it("still charges the buyer the fees when a credit fully covers the subtotal", async () => {
    const ctx = makeContext({
      activeCredits: [{ id: "credit-full", balanceCents: SUBTOTAL }],
    });
    await createCheckout(ctx.deps, ctx.input);

    // Subtotal fully offset; buyer is left paying only the 100 fee.
    expect(ctx.mocks.payments.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: FEES_ONLY_PI }),
    );
    expect(ctx.state.lastCreatePendingInput?.amountGrossCents).toBe(SUBTOTAL);
    expect(ctx.state.recordRedemptionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        creditId: "credit-full",
        amountCents: SUBTOTAL,
      }),
    );
    expect(ctx.state.creditStore.get("credit-full")?.balanceCents).toBe(0);
  });

  it("never double-spends a single credit across two concurrent checkouts", async () => {
    // FIX 1: two checkouts for the same buyer race on one $10 credit. The
    // atomic conditional debit (redeemConditional) must let only one consume
    // it; the other re-derives a zero applied amount from the drained row.
    const ctx = makeContext({
      activeCredits: [{ id: "credit-race", balanceCents: 1000 }],
    });

    await Promise.all([
      createCheckout(ctx.deps, {
        ...ctx.input,
        clientKey: "idem-key-race-a",
      }),
      createCheckout(ctx.deps, {
        ...ctx.input,
        clientKey: "idem-key-race-b",
      }),
    ]);

    // The balance is debited exactly once and never goes negative.
    expect(ctx.state.creditStore.get("credit-race")?.balanceCents).toBe(0);

    // One checkout charged the discounted PI (2100 - 1000), the other paid
    // full freight (2100). The credit was applied to exactly one order.
    const piAmounts = ctx.mocks.payments.createPaymentIntent.mock.calls
      .map((call) => (call[0] as { amountCents: number }).amountCents)
      .sort((a, b) => a - b);
    expect(piAmounts).toEqual([NO_CREDIT_PI - 1000, NO_CREDIT_PI]);

    // recordRedemption fired once (for the winning checkout only).
    expect(ctx.state.recordRedemptionMock).toHaveBeenCalledTimes(1);
    expect(ctx.state.recordRedemptionMock).toHaveBeenCalledWith(
      expect.objectContaining({ creditId: "credit-race", amountCents: 1000 }),
    );
  });

  it("completes via the zero-charge path when credit covers the full charge", async () => {
    // FIX 2(a): a zero-fee policy (buyerFeesCents 0) + a credit covering the
    // whole 2000 subtotal leaves a 0 charge. No PaymentIntent is created;
    // the order is minted directly via the zero-charge path.
    const ctx = makeContext({
      ...ZERO_FEE_POLICY,
      activeCredits: [{ id: "credit-cover", balanceCents: SUBTOTAL }],
    });

    const result = await createCheckout(ctx.deps, ctx.input);

    // No Stripe PaymentIntent — credit fully covered the charge.
    expect(ctx.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
    expect(result.clientSecret).toBeNull();
    expect(result.holdExpiresAt).toBeNull();
    expect(result.processorFeeCents).toBe(0);
    expect(result.creditAppliedCents).toBe(SUBTOTAL);

    // Organiser entitlement (amountGrossCents) is unchanged — the platform
    // funds the order out of margin.
    expect(result.amountGrossCents).toBe(SUBTOTAL);
    expect(ctx.state.lastCreatePendingInput?.amountGrossCents).toBe(SUBTOTAL);

    // Credit debited and a redemption row written even with no PaymentIntent.
    expect(ctx.state.creditStore.get("credit-cover")?.balanceCents).toBe(0);
    expect(ctx.state.recordRedemptionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        creditId: "credit-cover",
        amountCents: SUBTOTAL,
      }),
    );

    // Order marked succeeded and tickets minted inside the same transaction.
    expect(ctx.mocks.repos.orders.markSucceeded).toHaveBeenCalled();
    expect(ctx.mocks.repos.tickets.create).toHaveBeenCalled();

    // ── Organiser is actually paid (the bug this fixes) ───────────────
    // The zero-charge path must write OrderSplits at the order's full
    // agreement basis (computeAgreementBasis: amountGrossCents for a
    // FULL_PRICE order) and create settlements from them — otherwise a
    // credit-covered order silently stiffs the organiser. A credit-covered
    // order cannot carry a platform fee (credit covers only the ticket
    // subtotal, so a zero charge needs a zero buyer fee), so the amount is
    // the same under either rule; the pin is the marker the order carries.
    const gross = ctx.state.lastCreatePendingInput?.amountGrossCents ?? 0;
    expect(ctx.state.lastCreatePendingInput?.feePolicySnapshot).toMatchObject({
      organiserCredit: "FULL_PRICE",
    });
    expect(ctx.state.lastCreatePendingInput?.feesPlatformCents ?? 0).toBe(0);
    const expectedBasis = gross;
    expect(expectedBasis).toBe(SUBTOTAL);

    expect(ctx.mocks.repos.splits.upsertForOrder).toHaveBeenCalledWith(
      DEFAULT_ORDER_ID,
      [
        expect.objectContaining({
          payeeId: DEFAULT_PAYEE_ID,
          amountCents: expectedBasis,
        }),
      ],
    );
    expect(ctx.mocks.repos.payeeLedger.settlementCredit).toHaveBeenCalledWith(
      expect.objectContaining({
        payeeId: DEFAULT_PAYEE_ID,
        amountCents: expectedBasis,
        idempotencyKey: `settlement-credit:${DEFAULT_ORDER_ID}:${DEFAULT_PAYEE_ID}`,
        sourceKind: "order_split",
        sourceId: DEFAULT_ORDER_ID,
      }),
    );
    // Step B of the ledger cutover: revenue writes NO settlement rows.
    expect(ctx.mocks.repos.settlements.create).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown organiserCredit value", { organiserCredit: "HALF" }, true],
    ["no organiserCredit key (sold before the ruling)", {}, false],
  ] as const)(
    "credit-covered order with %s: reports organiser_credit_unknown = %s after the commit",
    async (_label, snapshot, shouldReport) => {
      const reportError = vi.fn();
      const ctx = makeContext({
        ...ZERO_FEE_POLICY,
        activeCredits: [{ id: "credit-cover", balanceCents: SUBTOTAL }],
      });
      ctx.deps.reportError = reportError;
      const original = ctx.mocks.repos.orders.getById.getMockImplementation()!;
      ctx.mocks.repos.orders.getById.mockImplementation(async (id: string) => {
        const order = await original(id);
        return order ? { ...order, feePolicySnapshot: { ...snapshot } } : null;
      });

      await createCheckout(ctx.deps, ctx.input);

      const unknownCalls = reportError.mock.calls.filter(
        ([, ctxArg]) =>
          ctxArg?.tags?.reason === "organiser_credit_unknown",
      );
      if (shouldReport) {
        expect(unknownCalls).toHaveLength(1);
        expect(unknownCalls[0]![1]).toMatchObject({
          tags: {
            useCase: "createCheckout",
            reason: "organiser_credit_unknown",
          },
          extra: expect.objectContaining({ orderId: DEFAULT_ORDER_ID }),
        });
      } else {
        expect(unknownCalls).toHaveLength(0);
      }
    },
  );

  it("keeps a credit-covered order succeeded and fires onSettlementFailure + reportError when the ledger credit throws", async () => {
    // Same fully credit-covered (zero-charge) setup as above, but the ledger
    // credit blows up AFTER the order tx already committed (tickets minted +
    // OrderSplits written). We must NOT roll those back — the order is
    // SUCCEEDED — but the failure must surface via onSettlementFailure so an
    // operator can re-drive via settlements.createFromOrder. This path has no
    // Stripe webhook DLQ backstop, so the alert hook + Sentry report are the
    // only signals.
    const onSettlementFailure = vi.fn();
    const reportError = vi.fn();
    const ctx = makeContext({
      ...ZERO_FEE_POLICY,
      activeCredits: [{ id: "credit-cover", balanceCents: SUBTOTAL }],
    });
    ctx.deps.onSettlementFailure = onSettlementFailure;
    ctx.deps.reportError = reportError;

    // Make the ledger-credit write throw, after the committed order tx.
    ctx.mocks.repos.payeeLedger.settlementCredit.mockRejectedValue(
      new Error("ledger boom"),
    );

    const result = await createCheckout(ctx.deps, ctx.input);

    // Zero-charge path still completed: no PaymentIntent, order succeeded,
    // tickets minted, and OrderSplits written at the full basis. None of this
    // is rolled back by the settlement failure.
    expect(ctx.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
    expect(result.clientSecret).toBeNull();
    expect(ctx.mocks.repos.orders.markSucceeded).toHaveBeenCalled();
    expect(ctx.mocks.repos.tickets.create).toHaveBeenCalled();
    expect(ctx.mocks.repos.splits.upsertForOrder).toHaveBeenCalledWith(
      DEFAULT_ORDER_ID,
      [
        expect.objectContaining({
          payeeId: DEFAULT_PAYEE_ID,
          amountCents: SUBTOTAL,
        }),
      ],
    );

    // The credit failure surfaced through the alert hook, keyed on the
    // order id, so operators can re-drive the payout.
    expect(onSettlementFailure).toHaveBeenCalledTimes(1);
    expect(onSettlementFailure).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: DEFAULT_ORDER_ID }),
    );
    // …and reached Sentry (deliberate swallow → reportError, per convention).
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "ledger boom" }),
      expect.objectContaining({
        tags: { useCase: "createCheckout", step: "createLedgerCredits" },
        extra: expect.objectContaining({ orderId: DEFAULT_ORDER_ID }),
      }),
    );
  });

  it("caps credit to keep the remaining charge at the processor minimum", async () => {
    // FIX 2(b): a zero-fee policy → no platform/processor fee added, so
    // chargeable == subtotal 2000. A 1970 credit would leave a 30¢ charge
    // (below the 50¢ minimum). The credit is capped to 1950 so the buyer pays
    // exactly 50¢, and the 20¢ remainder stays on the balance.
    //
    // NOTE: this scenario needs ZERO processing rates. With the real rates
    // the buyer funds a grossed-up processing fee on top of the subtotal, and
    // credits never offset fees, so the remaining charge stays above the
    // sub-minimum band the cap protects against. (It used ABSORB for the
    // zero; ABSORB is removed.)
    const ctx = makeContext({
      ...ZERO_FEE_POLICY,
      activeCredits: [{ id: "credit-cap", balanceCents: 1970 }],
    });

    await createCheckout(ctx.deps, ctx.input);

    expect(ctx.mocks.payments.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 50 }),
    );
    expect(ctx.state.recordRedemptionMock).toHaveBeenCalledWith(
      expect.objectContaining({ creditId: "credit-cap", amountCents: 1950 }),
    );
    expect(ctx.state.creditStore.get("credit-cap")?.balanceCents).toBe(20);
  });

  it("consumes no credit when a 100%-off promo already zeroes the subtotal", async () => {
    // Short-circuit-ordering invariant: a 100%-off promo makes `prep.isFree`
    // true, so checkout returns via `claimFreeTickets` BEFORE
    // `createPaidCheckout` (where the credit logic and its
    // `Math.min(totalAvailableCreditCents, amountGrossAfterDiscount)` clamp
    // live) ever runs. This test does NOT exercise that clamp — it pins the
    // ordering: credit logic never runs for a fully-promo'd free order, so no
    // credit is burned and the organiser is owed nothing. A regression that
    // reordered the free-path check after the credit logic — burning the
    // buyer's credit on an already-free order — must fail here.
    const ctx = makeContext({
      activeCredits: [{ id: "credit-x", balanceCents: 1000 }],
    });

    const promo: PromoRecord = {
      id: "promo-free-credit",
      code: "FREE",
      codeNormalized: "FREE",
      status: "ACTIVE",
      kind: "AMOUNT",
      scope: "EVENT",
      scopeId: ctx.defaults.eventId,
      value: 2000,
      currency: "usd",
      minOrderCents: 0,
      maxRedemptions: undefined,
      maxRedemptionsPerHuman: undefined,
      maxDiscountCents: undefined,
      stackable: false,
      isPublic: false,
      startsAt: undefined,
      endsAt: undefined,
      createdAt: ctx.defaults.now,
      updatedAt: ctx.defaults.now,
    };

    ctx.mocks.repos.promos.findActiveByCodes.mockResolvedValue([promo]);
    ctx.mocks.repos.promos.getRedemptionStats.mockResolvedValue({
      totalRedemptions: 0,
      redemptionsForHuman: 0,
    });

    const result = await createCheckout(ctx.deps, {
      ...ctx.input,
      promoCodes: ["free"],
    });

    // No credit redemption was attempted (insert-only row never written and
    // the atomic conditional debit never fired).
    expect(ctx.state.recordRedemptionMock).not.toHaveBeenCalled();
    expect(ctx.state.redeemConditionalMock).not.toHaveBeenCalled();

    // The seeded balance is untouched — not silently burned.
    expect(ctx.state.creditStore.get("credit-x")?.balanceCents).toBe(1000);

    // No platform_credit line item was appended to the order.
    const items = ctx.state.lastCreatePendingInput?.items ?? [];
    expect(
      items.some((item: { kind?: string }) => item.kind === "platform_credit"),
    ).toBe(false);

    // Nothing was applied.
    expect(result.creditAppliedCents).toBe(0);

    // Free-path guard (NOT a credit-clamp/overpay guard): a fully-promo'd
    // $0-basis order routes through claimFreeTickets, which writes neither
    // OrderSplits nor a ledger credit. The agreement basis is 0, so the
    // organiser is owed nothing and no $0 credit is written on the free path.
    expect(ctx.mocks.repos.payeeLedger.settlementCredit).not.toHaveBeenCalled();
    expect(ctx.mocks.repos.settlements.create).not.toHaveBeenCalled();

    // Zero-charge completion: the FREE promo zeroes the charge with no credit,
    // so no PaymentIntent is created and there is no client secret.
    expect(ctx.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
    expect(result.clientSecret).toBeNull();
  });

  it("caps applied credit at the post-promo subtotal, not the pre-promo price", async () => {
    // Clamp invariant (the one the FREE test above does NOT exercise): a
    // PARTIAL promo leaves a small positive subtotal that reaches
    // `createPaidCheckout`, where credit is clamped via
    // `Math.min(totalAvailableCreditCents, amountGrossAfterDiscount)`. Here a
    // 5000 credit must NOT spend against the pre-promo 2000 price nor its full
    // 5000 balance — it is capped at the post-promo subtotal (500).
    //
    // Fixture: ticketPrice 1000 × qty 2 = 2000. A partial AMOUNT promo of 1500
    // leaves amountGrossAfterDiscount = 500. Using a zero-fee policy
    // means no buyer fee, so the 500 credit covers the charge exactly and the
    // order completes via the zero-charge path (no PaymentIntent). This keeps
    // the clamp assertion clean — no Stripe-minimum cap interferes with the
    // 500 applied amount.
    const ctx = makeContext({
      ...ZERO_FEE_POLICY,
      activeCredits: [{ id: "credit-clamp", balanceCents: 5000 }],
    });

    const promo: PromoRecord = {
      id: "promo-partial-credit",
      code: "HALF",
      codeNormalized: "HALF",
      status: "ACTIVE",
      kind: "AMOUNT",
      scope: "EVENT",
      scopeId: ctx.defaults.eventId,
      value: 1500,
      currency: "usd",
      minOrderCents: 0,
      maxRedemptions: undefined,
      maxRedemptionsPerHuman: undefined,
      maxDiscountCents: undefined,
      stackable: false,
      isPublic: false,
      startsAt: undefined,
      endsAt: undefined,
      createdAt: ctx.defaults.now,
      updatedAt: ctx.defaults.now,
    };

    ctx.mocks.repos.promos.findActiveByCodes.mockResolvedValue([promo]);
    ctx.mocks.repos.promos.getRedemptionStats.mockResolvedValue({
      totalRedemptions: 0,
      redemptionsForHuman: 0,
    });

    const result = await createCheckout(ctx.deps, {
      ...ctx.input,
      promoCodes: ["half"],
    });

    // Credit applied is capped at the POST-promo subtotal (500), not the
    // pre-promo 2000 and not the full 5000 balance.
    expect(result.creditAppliedCents).toBe(500);
    expect(ctx.state.recordRedemptionMock).toHaveBeenCalledWith(
      expect.objectContaining({ creditId: "credit-clamp", amountCents: 500 }),
    );
    expect(ctx.state.creditStore.get("credit-clamp")?.balanceCents).toBe(4500);

    // The negative platform_credit line item is -500 (the clamped amount).
    const items = ctx.state.lastCreatePendingInput?.items ?? [];
    const creditItem = items.find(
      (item: { kind?: string }) => item.kind === "platform_credit",
    );
    expect(creditItem).toMatchObject({
      kind: "platform_credit",
      amountCents: -500,
    });

    // Organiser basis is reduced by the PROMO (gross = 500) but NOT by the
    // credit — credit only offsets the buyer's charge.
    expect(ctx.state.lastCreatePendingInput?.amountGrossCents).toBe(500);

    // Fee/PI behaviour: a zero-fee policy → no buyer fee, so the 500
    // credit covers the 500 charge exactly and the order mints via the
    // zero-charge path. No PaymentIntent is created.
    expect(ctx.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
    expect(result.clientSecret).toBeNull();
  });
});

describe("createCheckout — buyer in-app order.confirmed (inline-completion paths)", () => {
  const SUBTOTAL = 2000;

  /** Wire a notify spy + a loginable-buyer auth-account lookup onto the ctx. */
  function withNotify(
    ctx: ReturnType<typeof makeContext>,
    opts?: { authAccounts?: unknown[] },
  ) {
    const notify = vi.fn(
      async (_input: { idempotencyKey?: string; variant?: string }) =>
        ({}) as never,
    );
    const accounts = opts?.authAccounts ?? [
      {
        providerId: "credential",
        accountId: DEFAULT_ACTOR_ID,
        createdAt: new Date("2024-01-01"),
      },
    ];
    const listAuthAccounts = vi.fn(async () => accounts);
    (
      ctx.mocks.repos.humans as { listAuthAccounts?: unknown }
    ).listAuthAccounts = listAuthAccounts;
    // A loginable buyer also has a verified email (B2: isLoginableBuyer).
    (
      ctx.mocks.repos.humans as { getByIdWithIdentity?: unknown }
    ).getByIdWithIdentity = vi.fn(async (id: string) => ({
      human: { id },
      identity: { emailVerified: true },
    }));
    (ctx.deps as CreateCheckoutDeps).notify = notify as never;
    return { notify, listAuthAccounts };
  }

  function makeFreePromo(eventId: string, now: Date): PromoRecord {
    return {
      id: "promo-free",
      code: "FREE",
      codeNormalized: "FREE",
      status: "ACTIVE",
      kind: "AMOUNT",
      scope: "EVENT",
      scopeId: eventId,
      value: 100_000,
      currency: "usd",
      minOrderCents: 0,
      maxRedemptions: undefined,
      maxRedemptionsPerHuman: undefined,
      maxDiscountCents: undefined,
      stackable: false,
      isPublic: false,
      startsAt: undefined,
      endsAt: undefined,
      createdAt: now,
      updatedAt: now,
    };
  }

  it("fires order.confirmed for a fully credit-covered (zero-charge) order", async () => {
    const ctx = makeContext({
      ...ZERO_FEE_POLICY,
      activeCredits: [{ id: "credit-cover", balanceCents: SUBTOTAL }],
    });
    const { notify } = withNotify(ctx);

    const result = await createCheckout(ctx.deps, ctx.input);

    // Credit-covered, no Stripe PI.
    expect(ctx.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
    expect(result.clientSecret).toBeNull();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: DEFAULT_ACTOR_ID,
        variant: "order.confirmed",
        idempotencyKey: `order-confirmed:${DEFAULT_ORDER_ID}`,
        payload: expect.objectContaining({
          orderId: DEFAULT_ORDER_ID,
          eventId: ctx.defaults.eventId,
          eventTitle: "Launch Party",
          ticketCount: 2,
          amountCents: 0,
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

  it("fires order.confirmed for a free (100%-off) order via claimFreeTickets", async () => {
    const ctx = makeContext();
    const { notify } = withNotify(ctx);

    ctx.mocks.repos.promos.findActiveByCodes.mockResolvedValue([
      makeFreePromo(ctx.defaults.eventId, ctx.defaults.now),
    ]);
    ctx.mocks.repos.promos.getRedemptionStats.mockResolvedValue({
      totalRedemptions: 0,
      redemptionsForHuman: 0,
    });

    const result = await createCheckout(ctx.deps, {
      ...ctx.input,
      promoCodes: ["free"],
    });

    expect(result.clientSecret).toBeNull();
    expect(ctx.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: DEFAULT_ACTOR_ID,
        variant: "order.confirmed",
        idempotencyKey: `order-confirmed:${DEFAULT_ORDER_ID}`,
        payload: expect.objectContaining({
          orderId: DEFAULT_ORDER_ID,
          eventId: ctx.defaults.eventId,
          eventTitle: "Launch Party",
          ticketCount: 2,
          amountCents: 0,
          currency: "usd",
        }),
      }),
    );
  });

  it("uses the SAME order-confirmed key as the finalize path (no cross-path double-fire)", async () => {
    // The inline-completion key must match what finalizePaymentIntent emits
    // (order-confirmed:${orderId}) so a webhook/finalize for the same order id
    // can never produce a second feed entry.
    const ctx = makeContext({
      ...ZERO_FEE_POLICY,
      activeCredits: [{ id: "credit-cover", balanceCents: SUBTOTAL }],
    });
    const { notify } = withNotify(ctx);

    await createCheckout(ctx.deps, ctx.input);

    const call = notify.mock.calls[0]?.[0];
    expect(call?.idempotencyKey).toBe(`order-confirmed:${DEFAULT_ORDER_ID}`);
  });

  it("skips the notification for a guest buyer with no auth accounts", async () => {
    const ctx = makeContext({
      ...ZERO_FEE_POLICY,
      activeCredits: [{ id: "credit-cover", balanceCents: SUBTOTAL }],
    });
    const { notify } = withNotify(ctx, { authAccounts: [] });

    const result = await createCheckout(ctx.deps, ctx.input);

    // Order still completed; buyer keeps their existing receipt email.
    expect(result.clientSecret).toBeNull();
    expect(ctx.mocks.repos.tickets.create).toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("never throws when notify fails on the credit-covered path", async () => {
    const ctx = makeContext({
      ...ZERO_FEE_POLICY,
      activeCredits: [{ id: "credit-cover", balanceCents: SUBTOTAL }],
    });
    const { notify } = withNotify(ctx);
    notify.mockRejectedValueOnce(new Error("notify exploded"));

    const result = await createCheckout(ctx.deps, ctx.input);

    expect(result.clientSecret).toBeNull();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("does not notify on a normal paid checkout (finalize/webhook owns that)", async () => {
    const ctx = makeContext();
    const { notify } = withNotify(ctx);

    await createCheckout(ctx.deps, ctx.input);

    // Paid order → a PaymentIntent was created; tickets mint later via the
    // webhook, which is where order.confirmed fires — not here.
    expect(ctx.mocks.payments.createPaymentIntent).toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("createCheckout — buyer ToS + refund-policy persistence", () => {
  it("stamps the server-side ToS version and strips any client-supplied termsVersion", async () => {
    const ctx = makeContext();

    // A malicious/stale client asserting its own version string must be
    // ignored — the schema no longer carries the field and the stamp comes
    // from CURRENT_BUYER_TERMS_VERSION.
    await createCheckout(ctx.deps, {
      ...ctx.input,
      termsVersion: "client-forged-2031",
    });

    expect(ctx.state.lastCreatePendingInput?.termsVersion).toBe(
      CURRENT_BUYER_TERMS_VERSION,
    );
    expect(ctx.mocks.repos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "order.terms_accepted",
        data: expect.objectContaining({
          termsVersion: CURRENT_BUYER_TERMS_VERSION,
        }),
      }),
    );
  });

  it("writes BUYER_TERMS and REFUND_POLICY GLOBAL ledger rows with ip + user agent in the checkout tx", async () => {
    const ctx = makeContext();

    await createCheckout(ctx.deps, ctx.input);

    expect(ctx.state.acceptanceStore).toHaveLength(2);
    const byType = Object.fromEntries(
      ctx.state.acceptanceStore.map((row) => [row.documentType, row]),
    );

    expect(byType.BUYER_TERMS).toMatchObject({
      humanId: ctx.defaults.buyerHumanId,
      documentVersion: CURRENT_BUYER_TERMS_VERSION,
      documentTextSnapshot: CURRENT_BUYER_TERMS_TEXT,
      scopeType: "GLOBAL",
      scopeId: null,
      acceptedAt: ctx.defaults.now,
      ipAddress: "203.0.113.9",
      userAgent: "vitest-agent/1.0",
    });
    expect(byType.REFUND_POLICY).toMatchObject({
      humanId: ctx.defaults.buyerHumanId,
      documentVersion: CURRENT_REFUND_POLICY_VERSION,
      documentTextSnapshot: CURRENT_REFUND_POLICY_TEXT,
      scopeType: "GLOBAL",
      scopeId: null,
      acceptedAt: ctx.defaults.now,
      ipAddress: "203.0.113.9",
      userAgent: "vitest-agent/1.0",
    });
  });

  it("does not duplicate ledger rows on idempotent replay (early return precedes the tx)", async () => {
    const ctx = makeContext();

    await createCheckout(ctx.deps, ctx.input);
    expect(ctx.mocks.repos.acceptances.create).toHaveBeenCalledTimes(2);

    // Replay with the same clientKey: served from the idempotency cache,
    // so the tx (and therefore the ledger writes) never runs again.
    await createCheckout(ctx.deps, ctx.input);

    expect(ctx.mocks.repos.acceptances.create).toHaveBeenCalledTimes(2);
    expect(ctx.state.acceptanceStore).toHaveLength(2);
  });

  it("writes no new ledger rows on a repeat purchase by the same human at the same versions", async () => {
    const ctx = makeContext();

    await createCheckout(ctx.deps, ctx.input);
    expect(ctx.state.acceptanceStore).toHaveLength(2);

    // A second, distinct purchase (new idempotency key) runs the full flow
    // again — but recordAcceptance finds the current-version rows and
    // returns them unchanged.
    await createCheckout(ctx.deps, {
      ...ctx.input,
      clientKey: "idem-key-second-purchase",
    });

    expect(ctx.mocks.repos.orders.createPending).toHaveBeenCalledTimes(2);
    expect(ctx.mocks.repos.acceptances.create).toHaveBeenCalledTimes(2);
    expect(ctx.state.acceptanceStore).toHaveLength(2);
  });

  it("writes fresh ledger rows after a version bump (stale-version rows do not satisfy the current version)", async () => {
    const ctx = makeContext();

    // Simulate a prior acceptance of OLDER document versions: after a
    // version bump, findCurrent (keyed on the current version) misses and
    // a fresh row is written for each document.
    ctx.state.acceptanceStore.push(
      {
        id: "acceptance-stale-terms",
        humanId: ctx.defaults.buyerHumanId,
        documentType: "BUYER_TERMS",
        documentVersion: "2025-01-stale",
        documentTextSnapshot: "old text",
        scopeType: "GLOBAL",
        scopeId: null,
        acceptedAt: new Date("2025-01-01T00:00:00.000Z"),
        ipAddress: null,
        userAgent: null,
        metadata: null,
      },
      {
        id: "acceptance-stale-refund",
        humanId: ctx.defaults.buyerHumanId,
        documentType: "REFUND_POLICY",
        documentVersion: "platform-refund-2025-01-stale",
        documentTextSnapshot: "old text",
        scopeType: "GLOBAL",
        scopeId: null,
        acceptedAt: new Date("2025-01-01T00:00:00.000Z"),
        ipAddress: null,
        userAgent: null,
        metadata: null,
      },
    );

    await createCheckout(ctx.deps, ctx.input);

    expect(ctx.mocks.repos.acceptances.create).toHaveBeenCalledTimes(2);
    expect(ctx.state.acceptanceStore).toHaveLength(4);
    const currentRows = ctx.state.acceptanceStore.filter(
      (row) =>
        row.documentVersion === CURRENT_BUYER_TERMS_VERSION ||
        row.documentVersion === CURRENT_REFUND_POLICY_VERSION,
    );
    expect(currentRows).toHaveLength(2);
  });

  it("writes both ledger rows for a free claim (zero-price order)", async () => {
    const ctx = makeContext({ ticketPriceCents: 0 });

    await createCheckout(ctx.deps, ctx.input);

    expect(ctx.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.state.acceptanceStore).toHaveLength(2);
    expect(
      ctx.state.acceptanceStore.map((row) => row.documentType).sort(),
    ).toEqual(["BUYER_TERMS", "REFUND_POLICY"]);
    for (const row of ctx.state.acceptanceStore) {
      expect(row).toMatchObject({
        humanId: ctx.defaults.buyerHumanId,
        scopeType: "GLOBAL",
        scopeId: null,
        ipAddress: "203.0.113.9",
        userAgent: "vitest-agent/1.0",
      });
    }
  });

  it("stamps the server ToS version on free claims", async () => {
    const ctx = makeContext({ ticketPriceCents: 0 });

    await createCheckout(ctx.deps, {
      ...ctx.input,
      termsVersion: "client-forged-2031",
    });

    expect(ctx.state.lastCreatePendingInput?.termsVersion).toBe(
      CURRENT_BUYER_TERMS_VERSION,
    );
  });
});

describe("claimFreeTickets — acceptance gates", () => {
  it("rejects with terms_required when termsAccepted is not true", async () => {
    const ctx = makeContext({ ticketPriceCents: 0 });
    const deps = {
      repos: ctx.deps.repos,
      clock: ctx.deps.clock,
    };
    const { termsAccepted: _termsAccepted, ...inputWithoutTerms } = ctx.input;

    await expect(
      claimFreeTickets(deps, inputWithoutTerms as never, [], undefined),
    ).rejects.toMatchObject({ code: "TERMS_REQUIRED" });

    expect(ctx.mocks.repos.orders.createPending).not.toHaveBeenCalled();
    expect(ctx.state.acceptanceStore).toHaveLength(0);
  });

  it("rejects with refund_policy_required when refundPolicyAccepted is not true", async () => {
    const ctx = makeContext({ ticketPriceCents: 0 });
    const deps = {
      repos: ctx.deps.repos,
      clock: ctx.deps.clock,
    };

    await expect(
      claimFreeTickets(
        deps,
        { ...ctx.input, refundPolicyAccepted: false } as never,
        [],
        undefined,
      ),
    ).rejects.toMatchObject({ code: "REFUND_POLICY_REQUIRED" });

    expect(ctx.mocks.repos.orders.createPending).not.toHaveBeenCalled();
    expect(ctx.state.acceptanceStore).toHaveLength(0);
  });
});

describe("createCheckout — PASS_THROUGH processor-fee gross-up", () => {
  // Flat platform fee of $0.50/ticket (platformFixedCents 50, buyerFeePct 0,
  // no cap, no min), no tax/promo/credit. PASS_THROUGH means the buyer funds
  // BOTH the platform fee and the EXACT Stripe processor fee on top.
  const flatFeeOptions = {
    feeMode: "PASS_THROUGH" as const,
    buyerFeePct: 0,
    platformFixedCents: 50,
  };

  const piAmount = (ctx: ReturnType<typeof makeContext>): number => {
    const calls = ctx.mocks.payments.createPaymentIntent.mock.calls;
    const last = calls[calls.length - 1] as
      | [{ amountCents: number }]
      | undefined;
    return last![0].amountCents;
  };

  it("grosses up the processor fee for 1× $35 (buyer pays 3687, Stripe takes 137)", async () => {
    const ctx = makeContext({ ...flatFeeOptions, ticketPriceCents: 3500 });

    const result = await createCheckout(ctx.deps, {
      ...ctx.input,
      items: [{ ticketTypeId: ctx.defaults.ticketTypeId, qty: 1 }],
    });

    // base = 3500 gross + 50 platform = 3550 → +137 processor → 3687 charge.
    expect(piAmount(ctx)).toBe(3687);
    expect(result.processorFeeCents).toBe(137);
    expect(result.feeMode).toBe("PASS_THROUGH");
  });

  it("grosses up the processor fee for 1× $100 (buyer pays 10382, Stripe takes 332)", async () => {
    const ctx = makeContext({ ...flatFeeOptions, ticketPriceCents: 10_000 });

    const result = await createCheckout(ctx.deps, {
      ...ctx.input,
      items: [{ ticketTypeId: ctx.defaults.ticketTypeId, qty: 1 }],
    });

    expect(piAmount(ctx)).toBe(10_382);
    expect(result.processorFeeCents).toBe(332);
  });

  it("grosses up the processor fee for 2× $35 and distributes the share across items", async () => {
    const ctx = makeContext({ ...flatFeeOptions, ticketPriceCents: 3500 });

    const result = await createCheckout(ctx.deps, {
      ...ctx.input,
      items: [{ ticketTypeId: ctx.defaults.ticketTypeId, qty: 2 }],
    });

    // base = 7000 gross + 100 platform = 7100 → +243 processor → 7343 charge.
    expect(piAmount(ctx)).toBe(7343);
    expect(result.processorFeeCents).toBe(243);

    const ticketItems =
      ctx.state.lastCreatePendingInput?.items.filter(
        (item) => item.kind === "ticket",
      ) ?? [];
    expect(ticketItems).toHaveLength(2);

    // Σ per-item buyerTotalCents (gross + platform + processor) === charge.
    const sumBuyerTotal = ticketItems.reduce(
      (sum, item) =>
        sum + ((item.meta as Record<string, number>).buyerTotalCents ?? 0),
      0,
    );
    expect(sumBuyerTotal).toBe(7343);

    // Σ per-item processorFeeShareCents === the grossed-up processor fee.
    const sumShare = ticketItems.reduce(
      (sum, item) =>
        sum +
        ((item.meta as Record<string, number>).processorFeeShareCents ?? 0),
      0,
    );
    expect(sumShare).toBe(243);

    // unit total mirrors total for qty=1 items.
    for (const item of ticketItems) {
      const meta = item.meta as Record<string, number>;
      expect(meta.buyerUnitTotalCents).toBe(meta.buyerTotalCents);
    }
  });

  it("a fee policy still saying ABSORB charges the fees on top (ABSORB removed)", async () => {
    // docs/decisions/absorb-removed.md: a legacy ABSORB row that slipped past
    // the migration must not price a new sale ABSORB. Before the removal the
    // buyer paid the 3500 face alone.
    const ctx = makeContext({
      feeMode: "ABSORB",
      buyerFeePct: 0,
      platformFixedCents: 50,
      ticketPriceCents: 3500,
    });

    const result = await createCheckout(ctx.deps, {
      ...ctx.input,
      items: [{ ticketTypeId: ctx.defaults.ticketTypeId, qty: 1 }],
    });

    const expectedFee = solveProcessingFeeGrossUp(3500 + 50, 0.029, 30);
    expect(result.processorFeeCents).toBe(expectedFee);
    expect(piAmount(ctx)).toBe(3500 + 50 + expectedFee);
    expect(result.feeMode).toBe("PASS_THROUGH");
    // The order records the mode it was priced under, so the order page
    // (computeBuyerChargeBreakdown) shows the fees the buyer paid.
    expect(
      (ctx.state.lastCreatePendingInput!.feePolicySnapshot as { feeMode: string })
        .feeMode,
    ).toBe("PASS_THROUGH");
  });

  it("grosses up the processor fee over the POST-TAX base", async () => {
    // 8.25% admission tax on a $35 ticket. Tax = round(3500 * 825 / 10000)
    // = 289. base = 3500 gross + 50 platform + 289 tax = 3839. The gross-up is
    // solved over that post-tax base.
    const ctx = makeContext({
      ...flatFeeOptions,
      ticketPriceCents: 3500,
      admissionTaxRateBps: 825,
    });

    const result = await createCheckout(ctx.deps, {
      ...ctx.input,
      items: [{ ticketTypeId: ctx.defaults.ticketTypeId, qty: 1 }],
    });

    const expectedTax = Math.round((3500 * 825) / 10_000);
    expect(expectedTax).toBe(289);
    const expectedBase = 3500 + 50 + expectedTax; // 3839
    const expectedFee = solveProcessingFeeGrossUp(expectedBase, 0.029, 30);
    expect(expectedFee).toBe(146);

    expect(result.taxAmountCents).toBe(289);
    expect(result.processorFeeCents).toBe(expectedFee);
    expect(piAmount(ctx)).toBe(expectedBase + expectedFee); // 3985
  });

  it("keeps the finalize AMOUNT_MISMATCH invariant: Σ per-item buyerTotal + tax === charged amount", async () => {
    // The finalize guard sums per-item buyerTotalCents + order tax (+ negative
    // credit/discount items). After the gross-up, a PASS_THROUGH charge must
    // reconcile exactly so a legitimate payment never trips AMOUNT_MISMATCH.
    const ctx = makeContext({
      ...flatFeeOptions,
      ticketPriceCents: 3500,
      admissionTaxRateBps: 825,
    });

    await createCheckout(ctx.deps, {
      ...ctx.input,
      items: [{ ticketTypeId: ctx.defaults.ticketTypeId, qty: 2 }],
    });

    const pending = ctx.state.lastCreatePendingInput!;
    const charged = piAmount(ctx);

    // Reconstruct the order shape computeExpectedPaymentAmount consumes.
    const expected = computeExpectedPaymentAmount({
      amountGrossCents: pending.amountGrossCents,
      feesPlatformCents: pending.feesPlatformCents,
      taxAmountCents: pending.taxAmountCents ?? 0,
      items: pending.items.map((item) => ({
        amountCents: item.amountCents,
        meta: item.meta ?? {},
        kind: item.kind,
      })),
    });

    expect(expected).toBe(charged);
  });

  it("settlement basis: a new order is credited its full gross; a historical ABSORB order keeps gross − fee", async () => {
    // INVARIANT: the processor pass-through lands extra money in the platform
    // balance (offsetting Stripe's deduction) and does NOT touch the seller's
    // entitlement. A new order carries `organiserCredit: "FULL_PRICE"` in the
    // snapshot checkout writes, so its basis is `amountGrossCents` (owner
    // ruling 2026-10-11: the platform fee is taken once, from the buyer). An
    // order without the marker keeps `amountGrossCents − feesPlatformCents`.
    const passThrough = makeContext({
      ...flatFeeOptions,
      ticketPriceCents: 3500,
    });
    await createCheckout(passThrough.deps, {
      ...passThrough.input,
      items: [{ ticketTypeId: passThrough.defaults.ticketTypeId, qty: 2 }],
    });
    const ptPending = passThrough.state.lastCreatePendingInput!;
    expect(ptPending.feePolicySnapshot).toMatchObject({
      feeMode: "PASS_THROUGH",
      organiserCredit: "FULL_PRICE",
    });
    expect(ptPending.feesPlatformCents).toBe(100);
    const ptBasis = computeAgreementBasis({
      amountGrossCents: ptPending.amountGrossCents,
      feesPlatformCents: ptPending.feesPlatformCents,
      feePolicySnapshot: ptPending.feePolicySnapshot,
    });

    // A HISTORICAL ABSORB order's recorded columns (no new sale can be
    // ABSORB): gross 7000, platform fee 100, snapshot feeMode ABSORB, each
    // ticket item buyerTotalCents 3500. Its snapshot has no `organiserCredit`,
    // so the basis is the pre-ruling one. The fee mode is never read.
    const historical = {
      amountGrossCents: 7000,
      feesPlatformCents: 100,
      feePolicySnapshot: { feeMode: "ABSORB" },
      items: [
        { kind: "ticket", amountCents: 3500, meta: { buyerTotalCents: 3500 } },
        { kind: "ticket", amountCents: 3500, meta: { buyerTotalCents: 3500 } },
      ],
    };
    const abBasis = computeAgreementBasis(historical);

    // New order: the full gross. Historical order: gross 7000 − platform 100.
    expect(ptBasis).toBe(7000);
    expect(abBasis).toBe(6900);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Membership benefits at checkout — a benefit granted by an ACTIVE membership
// auto-applies with NO code typed, through the same evaluatePromoApplications
// pipeline and the same PromoHold ledger as a typed code. The only thing that
// differs is which column of that one ledger the row lands in.
// ─────────────────────────────────────────────────────────────────────────────

describe("createCheckout — membership-granted benefits", () => {
  const MEMBERSHIP_ID = "99999999-9999-4999-8999-111111111111";
  const TIER_ID = "99999999-9999-4999-8999-222222222222";
  const BENEFIT_ID = "99999999-9999-4999-8999-333333333333";

  /**
   * Seed the harness so the buyer's active membership grants a benefit with
   * the given terms. The tier is ORG-owned and matches the harness event's
   * org, so the derived ownerScope lets the grant through the one scope gate.
   */
  function seedMembershipGrant(
    ctx: ReturnType<typeof makeContext>,
    terms: {
      discountKind: "AMOUNT" | "PERCENT";
      discountValue: number;
      maxDiscountCents?: number | null;
    },
    tierOverrides: { ownerOrgId?: string | null; ownerHumanId?: string | null } = {},
  ) {
    ctx.mocks.repos.memberships.listForMember.mockImplementation(
      async (input: { memberHumanId: string; statuses: string[] }) =>
        input.memberHumanId === ctx.defaults.buyerHumanId &&
        input.statuses.includes("active")
          ? [
              {
                id: MEMBERSHIP_ID,
                tierId: TIER_ID,
                memberHumanId: ctx.defaults.buyerHumanId,
                status: "active",
                startedAt: ctx.defaults.now,
              } as never,
            ]
          : [],
    );
    ctx.mocks.repos.membershipTiers.listByIds.mockResolvedValue([
      {
        id: TIER_ID,
        ownerOrgId: ctx.defaults.orgId,
        ownerHumanId: null,
        name: "Sustaining Member",
        description: null,
        benefitsDescription: null,
        priceCents: 1000,
        currency: "usd",
        interval: "MONTH",
        stripeProductId: null,
        stripePriceId: null,
        status: "ACTIVE",
        sortOrder: 0,
        createdAt: ctx.defaults.now,
        updatedAt: ctx.defaults.now,
        ...tierOverrides,
      },
    ] as never);
    ctx.mocks.repos.membershipTiers.listBenefitsForTiers.mockResolvedValue([
      {
        id: BENEFIT_ID,
        tierId: TIER_ID,
        discountKind: terms.discountKind,
        discountValue: terms.discountValue,
        maxDiscountCents: terms.maxDiscountCents ?? null,
        categoryId: null,
        placeId: null,
        label: null,
      },
    ] as never);
  }

  it("auto-applies a member benefit with NO code typed and ledgers the hold", async () => {
    const ctx = makeContext();
    seedMembershipGrant(ctx, { discountKind: "AMOUNT", discountValue: 500 });

    // NOTE: no promoCodes on the input at all.
    const result = await createCheckout(ctx.deps, ctx.input);

    expect(result).toEqual({
      orderId: DEFAULT_ORDER_ID,
      clientSecret: "secret-123",
      amountGrossCents: 1500,
      // Fees compute PRE-discount: a partial member discount leaves the
      // platform fee pinned at the undiscounted 100. This is the asymmetry
      // the break-even calculator has to reproduce.
      feesPlatformCents: 100,
      buyerFeesCents: 100,
      processorFeeCents: 79,
      feeMode: "PASS_THROUGH",
      taxAmountCents: 0,
      creditAppliedCents: 0,
      holdExpiresAt: "2025-01-01T00:15:00.000Z",
      feeWaivedCents: 0,
    });

    // Neither promo read fired: nothing was typed, and a benefit has no
    // campaign caps to check.
    expect(ctx.mocks.repos.promos.findActiveByCodes).not.toHaveBeenCalled();
    expect(ctx.mocks.repos.promos.getRedemptionStats).not.toHaveBeenCalled();

    // The discount line is labellable as a member benefit — and carries no
    // code material, because there is none to carry.
    expect(ctx.mocks.repos.orders.createPending).toHaveBeenCalledWith(
      expect.objectContaining({
        amountGrossCents: 1500,
        items: expect.arrayContaining([
          expect.objectContaining({
            kind: "discount",
            amountCents: -500,
            meta: expect.objectContaining({
              source: "membership",
              membershipBenefitId: BENEFIT_ID,
              membershipId: MEMBERSHIP_ID,
              tierId: TIER_ID,
              appliedDiscountCents: 500,
            }),
          }),
        ]),
      }),
    );
    const discountMeta = ctx.state
      .lastCreatePendingInput!.items.find((item) => item.kind === "discount")!
      .meta as Record<string, unknown>;
    expect(discountMeta).not.toHaveProperty("promoId");
    expect(discountMeta).not.toHaveProperty("code");

    // Same PromoHold ledger as typed codes — one table, one lifecycle, with
    // membershipBenefitId where promoId would be.
    expect(ctx.mocks.repos.promos.createHolds).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.repos.promos.createHolds).toHaveBeenCalledWith([
      {
        membershipBenefitId: BENEFIT_ID,
        orderId: DEFAULT_ORDER_ID,
        code: `benefit:${BENEFIT_ID}`,
        amountDiscountCents: 500,
        humanId: ctx.defaults.buyerHumanId,
        idempotencyKey: `order:${DEFAULT_ORDER_ID}:benefit:${BENEFIT_ID}`,
        expiresAt: expect.any(Date),
      },
    ],
      { now: expect.any(Date) },
    );
    // The XOR the DB CHECK enforces, asserted at the boundary that writes it.
    const holds = ctx.mocks.repos.promos.createHolds.mock.calls[0]![0] as Array<
      Record<string, unknown>
    >;
    expect(holds[0]).not.toHaveProperty("promoId");
  });

  it("applies a typed code AND a benefit as two rows in the one ledger", async () => {
    const ctx = makeContext();
    seedMembershipGrant(ctx, { discountKind: "AMOUNT", discountValue: 300 });
    // A stackable typed code — the owner opted into stacking on their own
    // campaign, which is the only stacking question a benefit can raise.
    ctx.mocks.repos.promos.findActiveByCodes.mockResolvedValue([
      {
        id: "99999999-9999-4999-8999-555555555555",
        code: "EARLY",
        codeNormalized: "EARLY",
        status: "ACTIVE",
        kind: "AMOUNT",
        value: 200,
        currency: "usd",
        scope: "EVENT",
        scopeId: ctx.defaults.eventId,
        minOrderCents: 0,
        stackable: true,
        isPublic: false,
        createdAt: ctx.defaults.now,
        updatedAt: ctx.defaults.now,
      },
    ] as never);

    const result = await createCheckout(ctx.deps, {
      ...ctx.input,
      promoCodes: ["early"],
    });

    expect(result.amountGrossCents).toBe(1500);
    const holds = ctx.mocks.repos.promos.createHolds.mock.calls[0]![0] as Array<{
      promoId?: string;
      membershipBenefitId?: string;
      amountDiscountCents: number;
    }>;
    expect(holds).toHaveLength(2);
    // Exactly one source per row.
    for (const hold of holds) {
      expect(
        [hold.promoId, hold.membershipBenefitId].filter(Boolean),
      ).toHaveLength(1);
    }
    expect(holds[1]).toMatchObject({
      membershipBenefitId: BENEFIT_ID,
      amountDiscountCents: 300,
    });
  });

  it("a 100% member benefit routes to the FREE path: $0 order, zero fees, tickets minted", async () => {
    const ctx = makeContext();
    seedMembershipGrant(ctx, { discountKind: "PERCENT", discountValue: 100 });

    const result = await createCheckout(ctx.deps, ctx.input);

    expect(result).toEqual({
      orderId: DEFAULT_ORDER_ID,
      clientSecret: null,
      amountGrossCents: 0,
      // "Free entry to open mics" must never render as Ticket $0.00 / Fee
      // $1.87 — zeroFeesForFreeOrder strips every fee from the $0 order.
      feesPlatformCents: 0,
      buyerFeesCents: 0,
      processorFeeCents: 0,
      feeMode: "PASS_THROUGH",
      taxAmountCents: 0,
      creditAppliedCents: 0,
      holdExpiresAt: null,
    });

    // Free path: no PaymentIntent, order created once, benefit confirmed inline.
    expect(ctx.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.mocks.repos.orders.createPending).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.repos.promos.createHolds).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.repos.promos.confirmHoldsForOrder).toHaveBeenCalledWith({
      orderId: DEFAULT_ORDER_ID,
      confirmedAt: ctx.defaults.now,
    });
    expect(ctx.state.lastCreatePendingInput?.amountGrossCents).toBe(0);
    expect(ctx.state.lastCreatePendingInput?.feesPlatformCents).toBe(0);
  });

  it("logs when a benefit and a typed code TOGETHER reach a $0 order", async () => {
    // Combining is intended and unchanged — a benefit is just another discount.
    // But the free path waives the PLATFORM fee too, so an owner can reach it
    // via a `stackable` code they had forgotten about. Nothing gates it; this
    // pins that the event is at least RECONSTRUCTABLE afterwards, which is the
    // whole ask. One discount reaching zero is ordinary and stays quiet.
    const ctx = makeContext();
    seedMembershipGrant(ctx, { discountKind: "AMOUNT", discountValue: 1000 });
    ctx.mocks.repos.promos.findActiveByCodes.mockResolvedValue([
      {
        id: "99999999-9999-4999-8999-777777777777",
        code: "HALF",
        codeNormalized: "HALF",
        status: "ACTIVE",
        kind: "PERCENT",
        value: 50,
        currency: "usd",
        scope: "EVENT",
        scopeId: ctx.defaults.eventId,
        minOrderCents: 0,
        stackable: true,
        isPublic: false,
        createdAt: ctx.defaults.now,
        updatedAt: ctx.defaults.now,
      },
    ] as never);

    const result = await createCheckout(ctx.deps, {
      ...ctx.input,
      promoCodes: ["half"],
    });

    // 50% of $20 = $10, plus the $10 benefit = $0.
    expect(result.amountGrossCents).toBe(0);
    expect(ctx.mocks.logger.info).toHaveBeenCalledWith(
      "checkout.free_order_via_combined_discounts",
      expect.objectContaining({ appliedDiscountCount: 2 }),
    );
  });

  it("stays quiet when a SINGLE benefit reaches $0 — that is ordinary", async () => {
    const ctx = makeContext();
    seedMembershipGrant(ctx, { discountKind: "PERCENT", discountValue: 100 });

    await createCheckout(ctx.deps, ctx.input);

    expect(ctx.mocks.logger.info).not.toHaveBeenCalledWith(
      "checkout.free_order_via_combined_discounts",
      expect.anything(),
    );
  });

  it("a CANCELED membership grants nothing — full price, no discount line", async () => {
    const ctx = makeContext();
    seedMembershipGrant(ctx, { discountKind: "AMOUNT", discountValue: 500 });
    // The membership store only answers for "active"-inclusive queries; a
    // canceled row is invisible to the benefit-granting statuses.
    ctx.mocks.repos.memberships.listForMember.mockResolvedValue([]);

    const result = await createCheckout(ctx.deps, ctx.input);

    expect(result.amountGrossCents).toBe(2000);
    expect(ctx.mocks.repos.promos.createHolds).not.toHaveBeenCalled();
    const discountItems = ctx.state.lastCreatePendingInput!.items.filter(
      (item) => item.kind === "discount",
    );
    expect(discountItems).toHaveLength(0);
  });

  it("SECURITY: a benefit from ANOTHER owner's tier discounts nothing", async () => {
    // The cross-tenant attack the old promo-scope guard existed to stop, now
    // prevented structurally: the grant's ownerScope comes from the tier, and
    // this tier belongs to a different org than the event's payee.
    const ctx = makeContext();
    seedMembershipGrant(
      ctx,
      { discountKind: "PERCENT", discountValue: 100 },
      { ownerOrgId: "99999999-9999-4999-8999-666666666666" },
    );

    const result = await createCheckout(ctx.deps, ctx.input);

    expect(result.amountGrossCents).toBe(2000);
    expect(ctx.mocks.repos.promos.createHolds).not.toHaveBeenCalled();
  });

  it("SECURITY: a HUMAN-owned tier's benefit does not reach an ORG-owned event", async () => {
    // Payee precedence: orgId is who gets paid, so a human's entitlement must
    // never come out of an org's revenue — the same rule PromoScope.HUMAN has.
    const ctx = makeContext();
    seedMembershipGrant(
      ctx,
      { discountKind: "PERCENT", discountValue: 100 },
      { ownerOrgId: null, ownerHumanId: ctx.defaults.buyerHumanId },
    );

    const result = await createCheckout(ctx.deps, ctx.input);

    expect(result.amountGrossCents).toBe(2000);
    expect(ctx.mocks.repos.promos.createHolds).not.toHaveBeenCalled();
  });
});

/**
 * Time-based ticket pricing — FR-003 / FR-005 / NFR-003, exercised through the
 * REAL checkout path rather than the resolver in isolation.
 *
 * The acceptance criterion this pins: "a ticket type priced $12 with a
 * schedule of $20 at T sells at $12 at T-1ms and $20 at T". Asserted on the
 * order's computed AMOUNTS and on the per-ticket OrderItem snapshot, because
 * those are the two numbers that actually move money — one charges the card,
 * the other is what every historical read (resale face value, wallet passes,
 * refunds) will read back forever.
 */
describe("createCheckout — scheduled price change (FR-005)", () => {
  // Inside the harness event's sales window (starts 2025-02-01).
  const FLIP_AT = new Date("2025-01-15T12:00:00.000Z");
  const FACE_BEFORE = 1200; // $12
  const FACE_AFTER = 2000; // $20

  function makeScheduledContext(now: Date) {
    return makeContext({
      ticketPriceCents: FACE_BEFORE,
      scheduledPriceCents: FACE_AFTER,
      scheduledPriceAt: FLIP_AT,
      now,
      // Strip the fee noise so the assertions below are pure ticket money.
      ...ZERO_FEE_POLICY,
      platformFixedCents: 0,
    });
  }

  const ticketUnitPrices = (ctx: ReturnType<typeof makeContext>) =>
    ctx.state
      .lastCreatePendingInput!.items.filter(
        (item) => item.kind === "ticket",
      )
      .map((item) => item.unitPriceCents);

  it("charges $12 at T minus one millisecond", async () => {
    const ctx = makeScheduledContext(new Date(FLIP_AT.getTime() - 1));

    const result = await createCheckout(ctx.deps, ctx.input);

    // qty 2 × $12
    expect(result.amountGrossCents).toBe(2400);
    // NFR-003 — the price charged is SNAPSHOTTED per ticket, not recomputed later.
    expect(ticketUnitPrices(ctx)).toEqual([FACE_BEFORE, FACE_BEFORE]);
  });

  it("charges $20 at exactly T", async () => {
    const ctx = makeScheduledContext(new Date(FLIP_AT.getTime()));

    const result = await createCheckout(ctx.deps, ctx.input);

    // qty 2 × $20
    expect(result.amountGrossCents).toBe(4000);
    expect(ticketUnitPrices(ctx)).toEqual([FACE_AFTER, FACE_AFTER]);
  });

  it("charges $20 well after T", async () => {
    const ctx = makeScheduledContext(
      new Date(FLIP_AT.getTime() + 3 * 24 * 60 * 60 * 1000),
    );

    const result = await createCheckout(ctx.deps, ctx.input);

    expect(result.amountGrossCents).toBe(4000);
    expect(ticketUnitPrices(ctx)).toEqual([FACE_AFTER, FACE_AFTER]);
  });

  it("NFR-001: an UNSCHEDULED type at the same instants is untouched", async () => {
    for (const now of [
      new Date(FLIP_AT.getTime() - 1),
      new Date(FLIP_AT.getTime()),
    ]) {
      const ctx = makeContext({
        ticketPriceCents: FACE_BEFORE,
        now,
        ...ZERO_FEE_POLICY,
        platformFixedCents: 0,
      });

      const result = await createCheckout(ctx.deps, ctx.input);

      expect(result.amountGrossCents).toBe(2400);
      expect(ticketUnitPrices(ctx)).toEqual([FACE_BEFORE, FACE_BEFORE]);
    }
  });

  it("a tier scheduled to 0 becomes genuinely free at T (0 is a price, not an absence)", async () => {
    const ctx = makeContext({
      ticketPriceCents: FACE_BEFORE,
      scheduledPriceCents: 0,
      scheduledPriceAt: FLIP_AT,
      now: new Date(FLIP_AT.getTime()),
      ...ZERO_FEE_POLICY,
      platformFixedCents: 0,
    });

    // A $0 order routes to claimFreeTickets rather than a PaymentIntent. The
    // point being pinned is that the resolver returned 0 and not FACE_BEFORE:
    // if 0 had collapsed with null, this would have been a $24 paid order with
    // a clientSecret.
    const result = await createCheckout(ctx.deps, ctx.input);

    expect(result.amountGrossCents).toBe(0);
    expect(result.clientSecret).toBeNull();
    expect(ticketUnitPrices(ctx)).toEqual([0, 0]);
  });
});

/**
 * Per-type sales windows — ticket-type-packs FR-014, adopted by
 * time-based-ticket-pricing FR-009, exercised through the REAL checkout path.
 *
 * The requirement this pins is FR-014's, verbatim: "Enforcement lands with the
 * columns, not after them: create-checkout (and the POS path) rejects purchases
 * outside the window — a stored window with no checkout guard is UI theatre."
 *
 * So every assertion here checks BOTH that the call was refused AND that
 * nothing was written — a refusal that still created a pending order or a
 * PaymentIntent would be worse than no guard at all.
 */
describe("createCheckout — sales window (FR-014)", () => {
  // Both bounds sit before the harness event's start (2025-02-01).
  const OPENS_AT = new Date("2025-01-10T12:00:00.000Z");
  const CLOSES_AT = new Date("2025-01-20T12:00:00.000Z");

  const windowed = (now: Date, bounds?: MakeContextOptions) =>
    makeContext({
      ticketPriceCents: 1000,
      salesOpenAt: OPENS_AT,
      salesCloseAt: CLOSES_AT,
      now,
      ...bounds,
    });

  const assertNothingHappened = (ctx: ReturnType<typeof makeContext>) => {
    expect(ctx.mocks.repos.orders.createPending).not.toHaveBeenCalled();
    expect(ctx.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.state.lastCreatePendingInput).toBeNull();
  };

  it("refuses BEFORE the window opens, and writes nothing", async () => {
    const ctx = windowed(new Date(OPENS_AT.getTime() - 1));

    await expect(createCheckout(ctx.deps, ctx.input)).rejects.toThrowError(
      expect.objectContaining({ code: "TICKET_TYPE_NOT_YET_ON_SALE" }),
    );
    assertNothingHappened(ctx);
  });

  it("SELLS at exactly the open instant — the open bound is INCLUSIVE", async () => {
    const ctx = windowed(new Date(OPENS_AT.getTime()));

    const result = await createCheckout(ctx.deps, ctx.input);

    expect(result.amountGrossCents).toBe(2000); // qty 2 × $10
  });

  it("sells BETWEEN the bounds", async () => {
    const ctx = windowed(
      new Date((OPENS_AT.getTime() + CLOSES_AT.getTime()) / 2),
    );

    const result = await createCheckout(ctx.deps, ctx.input);

    expect(result.amountGrossCents).toBe(2000);
  });

  it("sells one millisecond BEFORE the close instant", async () => {
    const ctx = windowed(new Date(CLOSES_AT.getTime() - 1));

    const result = await createCheckout(ctx.deps, ctx.input);

    expect(result.amountGrossCents).toBe(2000);
  });

  it("refuses AT the close instant — the close bound is EXCLUSIVE", async () => {
    const ctx = windowed(new Date(CLOSES_AT.getTime()));

    await expect(createCheckout(ctx.deps, ctx.input)).rejects.toThrowError(
      expect.objectContaining({ code: "TICKET_TYPE_SALES_ENDED" }),
    );
    assertNothingHappened(ctx);
  });

  it("refuses AFTER the close instant", async () => {
    const ctx = windowed(new Date(CLOSES_AT.getTime() + 60_000));

    await expect(createCheckout(ctx.deps, ctx.input)).rejects.toThrowError(
      expect.objectContaining({ code: "TICKET_TYPE_SALES_ENDED" }),
    );
    assertNothingHappened(ctx);
  });

  it("OPEN bound only: refused before it, sells from it onward", async () => {
    const early = makeContext({
      salesOpenAt: OPENS_AT,
      now: new Date(OPENS_AT.getTime() - 1),
    });
    await expect(createCheckout(early.deps, early.input)).rejects.toThrowError(
      expect.objectContaining({ code: "TICKET_TYPE_NOT_YET_ON_SALE" }),
    );
    assertNothingHappened(early);

    const later = makeContext({
      salesOpenAt: OPENS_AT,
      now: new Date(CLOSES_AT.getTime() + 60_000),
    });
    await expect(createCheckout(later.deps, later.input)).resolves.toBeTruthy();
  });

  it("CLOSE bound only: sells arbitrarily early, refused from it onward", async () => {
    const early = makeContext({
      salesCloseAt: CLOSES_AT,
      now: new Date("2024-01-01T00:00:00.000Z"),
    });
    await expect(createCheckout(early.deps, early.input)).resolves.toBeTruthy();

    const late = makeContext({
      salesCloseAt: CLOSES_AT,
      now: new Date(CLOSES_AT.getTime()),
    });
    await expect(createCheckout(late.deps, late.input)).rejects.toThrowError(
      expect.objectContaining({ code: "TICKET_TYPE_SALES_ENDED" }),
    );
    assertNothingHappened(late);
  });

  it("COMPOSES with the event-level close: per-type OPEN but event OVER still refuses", async () => {
    // The stricter gate wins, and it is not this one. The harness event starts
    // 2025-02-01 with no endsAt, so sales close at startsAt; the tier's own
    // window is deliberately left WIDE (no bounds at all) so the only thing
    // that can refuse is the event-level check. A per-type window must never
    // widen the event-level one.
    const ctx = makeContext({
      salesOpenAt: null,
      salesCloseAt: null,
      now: new Date("2025-02-01T20:00:00.001Z"),
    });

    await expect(createCheckout(ctx.deps, ctx.input)).rejects.toThrowError(
      expect.objectContaining({ code: "EVENT_SALES_CLOSED" }),
    );
    assertNothingHappened(ctx);
  });

  it("COMPOSES the other way: per-type window open but event closed still refuses", async () => {
    // Same instant, but now the tier is explicitly, generously on sale
    // (open in the past, closes far in the future). The event-level gate must
    // still win — otherwise a per-type window would be a way to sell tickets
    // to an event that already happened.
    const ctx = makeContext({
      salesOpenAt: new Date("2024-01-01T00:00:00.000Z"),
      salesCloseAt: new Date("2030-01-01T00:00:00.000Z"),
      now: new Date("2025-02-01T20:00:00.001Z"),
    });

    await expect(createCheckout(ctx.deps, ctx.input)).rejects.toThrowError(
      expect.objectContaining({ code: "EVENT_SALES_CLOSED" }),
    );
    assertNothingHappened(ctx);
  });

  it("REPORTS an unparseable bound through deps.reportError, and still sells", async () => {
    // Same fail-open, reached through the ONLINE choke point
    // (computeOrderAmounts) rather than the till — proving the reporter is
    // threaded on both routes, not just the one with an obvious owner.
    const reportError = vi.fn();
    const ctx = makeContext({
      ticketPriceCents: 1000,
      salesCloseAt: new Date("nope"),
      now: new Date("2025-01-15T00:00:00.000Z"),
    });

    const result = await createCheckout(
      { ...ctx.deps, reportError },
      ctx.input,
    );

    expect(result.amountGrossCents).toBe(2000);
    expect(reportError).toHaveBeenCalled();
    const [error, context] = reportError.mock.calls[0]!;
    expect((error as Error).message).toBe(
      "ticket_type_sales_window_unparseable:salesCloseAt",
    );
    expect(context).toMatchObject({
      tags: { area: "checkout", field: "salesCloseAt" },
      extra: { surface: "computeOrderAmounts" },
    });
  });

  it("NFR-001: an UNWINDOWED type sells at every one of those instants", async () => {
    for (const now of [
      new Date(OPENS_AT.getTime() - 1),
      new Date(OPENS_AT.getTime()),
      new Date(CLOSES_AT.getTime()),
      new Date(CLOSES_AT.getTime() + 60_000),
    ]) {
      const ctx = makeContext({ ticketPriceCents: 1000, now });

      const result = await createCheckout(ctx.deps, ctx.input);

      expect(result.amountGrossCents).toBe(2000);
    }
  });
});

// ── Pre-charge capacity gate ────────────────────────────────────────────────
//
// The bug this closes: `capacity` is the authored column and is never
// decremented, and the ONLY inventory check on the web path used to be
// `mintTickets` — which runs inside the payment_intent.succeeded webhook,
// after the buyer's card is charged. A sold-out GA tier therefore produced a
// real charge and no ticket.
//
// So every assertion below is about a refusal that happens BEFORE
// `payments.createPaymentIntent` is called, not merely about a thrown error.
describe("createCheckout — capacity (pre-charge)", () => {
  it("refuses a fully-issued GA tier without creating a PaymentIntent", async () => {
    const ctx = makeContext({ capacity: 10, issuedForTicketType: 10 });

    await expect(createCheckout(ctx.deps, ctx.input)).rejects.toMatchObject({
      code: "TICKET_TYPE_SOLD_OUT",
    });

    // The whole point: no charge, and no order to have to unwind.
    expect(ctx.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.mocks.repos.orders.createPending).not.toHaveBeenCalled();
  });

  it("permits issued + requested === capacity (the last two tickets)", async () => {
    // ctx.input asks for qty 2.
    const ctx = makeContext({ capacity: 10, issuedForTicketType: 8 });

    await expect(createCheckout(ctx.deps, ctx.input)).resolves.toMatchObject({
      orderId: DEFAULT_ORDER_ID,
    });
    expect(ctx.mocks.payments.createPaymentIntent).toHaveBeenCalledTimes(1);
  });

  it("refuses issued + requested === capacity + 1", async () => {
    const ctx = makeContext({ capacity: 10, issuedForTicketType: 9 });

    await expect(createCheckout(ctx.deps, ctx.input)).rejects.toMatchObject({
      code: "TICKET_TYPE_SOLD_OUT",
    });
    expect(ctx.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
  });

  it("counts ANOTHER buyer's in-flight hold against the last ticket", async () => {
    // 8 issued + 1 held on a capacity of 10, asking for 2. Issued-only
    // accounting says "fits"; that is exactly the race that charges two cards
    // for one ticket. TEMPORARILY_HELD rather than SOLD_OUT because the room
    // is not actually full — it is worth retrying.
    const ctx = makeContext({
      capacity: 10,
      issuedForTicketType: 8,
      heldForTicketType: 1,
    });

    await expect(createCheckout(ctx.deps, ctx.input)).rejects.toMatchObject({
      code: "TICKET_TYPE_TEMPORARILY_HELD",
    });
    expect(ctx.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
  });

  it("takes the capacity lock before any seat lock", async () => {
    // Lock ORDER, not merely lock presence. startPosSale acquires capacity
    // first and seats second; a path that reverses it can deadlock against
    // POS on a shared ticket type.
    const ctx = makeContext({ capacity: 10 });
    const order: string[] = [];

    ctx.mocks.repos.tickets.lockAndCountCapacityForTicketType.mockImplementation(
      async () => {
        order.push("capacity");
        return { issued: 0, held: 0 };
      },
    );
    ctx.mocks.repos.seats.releaseExpiredHolds.mockImplementation(async () => {
      order.push("seats");
      return 0;
    });

    await createCheckout(ctx.deps, ctx.input);

    expect(order).toEqual(["capacity", "seats"]);
  });

  it("excludes the buyer's own cart so they aren't refused their own hold", async () => {
    // The cart from updateOrderItems is a PENDING order stamped with
    // holdExpiresAt — it reserves the very stock this checkout is converting.
    // Counting it would make the last two tickets unbuyable by the person
    // already holding them.
    const pendingOrderId = "99999999-9999-4999-8999-999999999999";
    const ctx = makeContext({ capacity: 10 });

    ctx.mocks.repos.orders.getById.mockImplementation(async (id: string) =>
      id === pendingOrderId
        ? {
            id: pendingOrderId,
            buyerHumanId: ctx.defaults.buyerHumanId,
            eventId: ctx.defaults.eventId,
            status: "PENDING",
            items: [],
          }
        : null,
    );

    await createCheckout(ctx.deps, { ...ctx.input, pendingOrderId });

    expect(
      ctx.mocks.repos.tickets.lockAndCountCapacityForTicketType,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ excludeOrderId: pendingOrderId }),
    );
  });

  it("does NOT exclude a pendingOrderId belonging to someone else", async () => {
    // An unvalidated exclusion would let a buyer discount a stranger's hold
    // and sell straight past it.
    const foreignOrderId = "99999999-9999-4999-8999-999999999999";
    const ctx = makeContext({ capacity: 10 });

    ctx.mocks.repos.orders.getById.mockImplementation(async (id: string) =>
      id === foreignOrderId
        ? {
            id: foreignOrderId,
            buyerHumanId: "12121212-1212-4121-8121-121212121212",
            eventId: ctx.defaults.eventId,
            status: "PENDING",
            items: [],
          }
        : null,
    );

    await createCheckout(ctx.deps, {
      ...ctx.input,
      pendingOrderId: foreignOrderId,
    });

    expect(
      ctx.mocks.repos.tickets.lockAndCountCapacityForTicketType,
    ).toHaveBeenCalledWith(expect.objectContaining({ excludeOrderId: null }));
  });
});

describe("claimFreeTickets — capacity (pre-mint)", () => {
  // Free does not mean unlimited: this path mints REAL admissions inline, so
  // an ungated $0 tier oversells the room just as surely as a paid one.
  const freeInput = (ctx: ReturnType<typeof makeContext>) => ({
    ...ctx.input,
    items: [{ ticketTypeId: ctx.defaults.ticketTypeId, qty: 2 }],
  });

  it("refuses a fully-issued free tier without creating an order", async () => {
    const ctx = makeContext({
      ticketPriceCents: 0,
      capacity: 10,
      issuedForTicketType: 10,
    });

    await expect(
      createCheckout(ctx.deps, freeInput(ctx)),
    ).rejects.toMatchObject({ code: "TICKET_TYPE_SOLD_OUT" });

    expect(ctx.mocks.repos.orders.createPending).not.toHaveBeenCalled();
  });

  it("permits issued + requested === capacity on the free path", async () => {
    const ctx = makeContext({
      ticketPriceCents: 0,
      capacity: 10,
      issuedForTicketType: 8,
    });

    await expect(
      createCheckout(ctx.deps, freeInput(ctx)),
    ).resolves.toMatchObject({ clientSecret: null });
    expect(ctx.mocks.repos.orders.createPending).toHaveBeenCalledTimes(1);
  });

  it("refuses issued + requested === capacity + 1 on the free path", async () => {
    const ctx = makeContext({
      ticketPriceCents: 0,
      capacity: 10,
      issuedForTicketType: 9,
    });

    await expect(
      createCheckout(ctx.deps, freeInput(ctx)),
    ).rejects.toMatchObject({ code: "TICKET_TYPE_SOLD_OUT" });
    expect(ctx.mocks.repos.orders.createPending).not.toHaveBeenCalled();
  });

  it("counts another claimer's live hold on the free path too", async () => {
    const ctx = makeContext({
      ticketPriceCents: 0,
      capacity: 10,
      issuedForTicketType: 8,
      heldForTicketType: 1,
    });

    await expect(
      createCheckout(ctx.deps, freeInput(ctx)),
    ).rejects.toMatchObject({ code: "TICKET_TYPE_TEMPORARILY_HELD" });
    expect(ctx.mocks.repos.orders.createPending).not.toHaveBeenCalled();
  });
});

// ── Retiring the superseded cart ────────────────────────────────────────────
//
// Excluding the carried-over cart from the buyer's OWN gate is only half the
// job. If the row stays PENDING with a live `meta.holdExpiresAt`, it keeps
// consuming a unit for every OTHER buyer until the 15-minute TTL — and since
// the web client sends `pendingOrderId` on every cart-based checkout, that
// turns into small tiers looking permanently half-sold-out.
describe("createCheckout — retires the cart it supersedes", () => {
  const CART_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  function withCart(
    ctx: ReturnType<typeof makeContext>,
    cart: { stripePaymentIntentId?: string | null } = {},
  ) {
    ctx.mocks.repos.orders.getById.mockImplementation(async (id: string) =>
      id === CART_ID
        ? {
            id: CART_ID,
            buyerHumanId: ctx.defaults.buyerHumanId,
            eventId: ctx.defaults.eventId,
            status: "PENDING",
            stripePaymentIntentId: cart.stripePaymentIntentId ?? null,
            items: [],
          }
        : { ...ctx.state.order },
    );
  }

  it("frees the cart's hold for the NEXT buyer, not just for this one", async () => {
    // capacity 2, nothing issued, cart X holding 1. B converts X and takes 1.
    // The genuinely-remaining 1 must then be buyable by C. Before the fix, X
    // stayed PENDING and C got TICKET_TYPE_TEMPORARILY_HELD for a ticket
    // nobody was holding.
    const ctx = makeContext({
      capacity: 2,
      pendingCartHolds: { [CART_ID]: 1 },
    });
    withCart(ctx);

    await createCheckout(ctx.deps, {
      ...ctx.input,
      items: [{ ticketTypeId: ctx.defaults.ticketTypeId, qty: 1 }],
      pendingOrderId: CART_ID,
    });

    // The hold is gone from the ledger — the observable consequence, not just
    // the fact that a cancel method was called.
    expect(ctx.state.pendingCartHolds.has(CART_ID)).toBe(false);

    // And now prove it the way a buyer would: the next capacity read, with no
    // exclusion at all (a different buyer), sees the unit as free.
    const after =
      await ctx.mocks.repos.tickets.lockAndCountCapacityForTicketType({
        ticketTypeId: ctx.defaults.ticketTypeId,
        now: ctx.defaults.now,
        excludeOrderId: null,
      });
    expect(after.held).toBe(0);
  });

  it("a 1-per-person code held by the superseded cart is still usable on the retry that carries it", async () => {
    // Money audit #8 follow-up. Stats now count LIVE holds, and the cart being
    // superseded holds this buyer's code until it is retired. The routing
    // probe evaluates promos BEFORE retirement, so it must exclude that cart
    // or every capped-code checkout refuses on the Pay click (the web client
    // re-sends `pendingOrderId` there). The paid path evaluates again after
    // retirement and sees the hold gone.
    const ctx = makeContext({ capacity: 5, pendingCartHolds: { [CART_ID]: 1 } });
    withCart(ctx);

    const promo = {
      id: "promo-once",
      code: "ONCE",
      codeNormalized: "ONCE",
      status: "ACTIVE",
      kind: "AMOUNT",
      scope: "EVENT",
      scopeId: ctx.defaults.eventId,
      value: 500,
      currency: "usd",
      minOrderCents: 0,
      maxRedemptions: undefined,
      maxRedemptionsPerHuman: 1,
      maxDiscountCents: undefined,
      stackable: false,
      isPublic: false,
      startsAt: undefined,
      endsAt: undefined,
      createdAt: ctx.defaults.now,
      updatedAt: ctx.defaults.now,
    };
    ctx.mocks.repos.promos.findActiveByCodes.mockResolvedValue([promo as never]);

    // The ledger: ONE live hold, on the superseded cart, for this buyer. It
    // counts until the cart's holds are released, and never when the caller
    // excludes that cart.
    let cartHoldLive = true;
    ctx.mocks.repos.promos.releaseHoldsForOrder.mockImplementation(
      async (orderId: string) => {
        if (orderId === CART_ID) cartHoldLive = false;
      },
    );
    ctx.mocks.repos.promos.getRedemptionStats.mockImplementation(
      async (params: { excludeOrderId?: string }) => {
        const counted = cartHoldLive && params.excludeOrderId !== CART_ID;
        return {
          totalRedemptions: counted ? 1 : 0,
          redemptionsForHuman: counted ? 1 : 0,
        };
      },
    );

    // BEFORE the fix: promo_redeemed_by_human out of the routing probe.
    const result = await createCheckout(ctx.deps, {
      ...ctx.input,
      promoCodes: ["once"],
      pendingOrderId: CART_ID,
    });

    // The discount applied: 2 × $10 − $5.
    expect(result.amountGrossCents).toBe(1500);

    const statsCalls = ctx.mocks.repos.promos.getRedemptionStats.mock.calls.map(
      (call) => call[0],
    );
    // Routing probe: excludes the carried-over cart.
    expect(statsCalls[0]).toMatchObject({
      promoId: "promo-once",
      humanId: ctx.defaults.buyerHumanId,
      excludeOrderId: CART_ID,
    });
    // Paid path: evaluated again after retirement released the hold, and
    // with NO exclusion — the exclusion is only ever sound on the probe.
    // Excluding here would hide a cart whose retirement DECLINED.
    expect(ctx.mocks.repos.promos.releaseHoldsForOrder).toHaveBeenCalledWith(
      CART_ID,
    );
    expect(statsCalls.length).toBeGreaterThanOrEqual(2);
    expect(statsCalls[1]).toMatchObject({ excludeOrderId: undefined });
  });

  it("when retirement DECLINES, the paid path still counts the un-retired cart's hold and refuses the capped code", async () => {
    // The probe excluded the cart (so routing works), but the cart could not
    // be retired — Stripe blip, PI status unknown — so it still owns its
    // redemption. The post-retirement evaluation must see that hold.
    const ctx = makeContext({ capacity: 5, pendingCartHolds: { [CART_ID]: 1 } });
    withCart(ctx, { stripePaymentIntentId: "pi_superseded" });
    ctx.mocks.payments.cancelPaymentIntent.mockRejectedValue(
      new Error("stripe down"),
    );
    ctx.mocks.repos.promos.findActiveByCodes.mockResolvedValue([
      {
        id: "promo-once",
        code: "ONCE",
        codeNormalized: "ONCE",
        status: "ACTIVE",
        kind: "AMOUNT",
        scope: "EVENT",
        scopeId: ctx.defaults.eventId,
        value: 500,
        currency: "usd",
        minOrderCents: 0,
        maxRedemptions: undefined,
        maxRedemptionsPerHuman: 1,
        maxDiscountCents: undefined,
        stackable: false,
        isPublic: false,
        startsAt: undefined,
        endsAt: undefined,
        createdAt: ctx.defaults.now,
        updatedAt: ctx.defaults.now,
      } as never,
    ]);
    let cartHoldLive = true;
    ctx.mocks.repos.promos.releaseHoldsForOrder.mockImplementation(
      async (orderId: string) => {
        if (orderId === CART_ID) cartHoldLive = false;
      },
    );
    ctx.mocks.repos.promos.getRedemptionStats.mockImplementation(
      async (params: { excludeOrderId?: string }) => {
        const counted = cartHoldLive && params.excludeOrderId !== CART_ID;
        return {
          totalRedemptions: counted ? 1 : 0,
          redemptionsForHuman: counted ? 1 : 0,
        };
      },
    );

    await expect(
      createCheckout(ctx.deps, {
        ...ctx.input,
        promoCodes: ["once"],
        pendingOrderId: CART_ID,
      }),
    ).rejects.toMatchObject({ message: "promo_redeemed_by_human" });

    const statsCalls = ctx.mocks.repos.promos.getRedemptionStats.mock.calls.map(
      (call) => call[0],
    );
    expect(statsCalls[0]).toMatchObject({ excludeOrderId: CART_ID });
    expect(statsCalls[1]).toMatchObject({ excludeOrderId: undefined });
    expect(ctx.mocks.repos.promos.releaseHoldsForOrder).not.toHaveBeenCalled();
    expect(ctx.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
  });

  it("a stranger's pending order id is NOT excluded from the routing probe", async () => {
    // Same setup, but the carried id belongs to another buyer: the probe must
    // count that hold like anyone else's.
    const ctx = makeContext({ capacity: 5 });
    ctx.mocks.repos.orders.getById.mockImplementation(async (id: string) =>
      id === CART_ID
        ? {
            id: CART_ID,
            buyerHumanId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
            eventId: ctx.defaults.eventId,
            status: "PENDING",
            stripePaymentIntentId: null,
            items: [],
          }
        : { ...ctx.state.order },
    );
    ctx.mocks.repos.promos.findActiveByCodes.mockResolvedValue([
      {
        id: "promo-once",
        code: "ONCE",
        codeNormalized: "ONCE",
        status: "ACTIVE",
        kind: "AMOUNT",
        scope: "EVENT",
        scopeId: ctx.defaults.eventId,
        value: 500,
        currency: "usd",
        minOrderCents: 0,
        maxRedemptions: 1,
        maxRedemptionsPerHuman: undefined,
        maxDiscountCents: undefined,
        stackable: false,
        isPublic: false,
        startsAt: undefined,
        endsAt: undefined,
        createdAt: ctx.defaults.now,
        updatedAt: ctx.defaults.now,
      } as never,
    ]);
    ctx.mocks.repos.promos.getRedemptionStats.mockImplementation(
      async (params: { excludeOrderId?: string }) => ({
        totalRedemptions: params.excludeOrderId === CART_ID ? 0 : 1,
        redemptionsForHuman: 0,
      }),
    );

    await expect(
      createCheckout(ctx.deps, {
        ...ctx.input,
        promoCodes: ["once"],
        pendingOrderId: CART_ID,
      }),
    ).rejects.toMatchObject({ message: "promo_max_redeemed" });
    expect(
      ctx.mocks.repos.promos.getRedemptionStats.mock.calls[0]?.[0],
    ).toMatchObject({ excludeOrderId: undefined });
  });

  it("releases the superseded cart's promo holds", async () => {
    // Otherwise a single-use code stays burned on an attempt that no longer
    // exists.
    const ctx = makeContext({ capacity: 5, pendingCartHolds: { [CART_ID]: 1 } });
    withCart(ctx);

    await createCheckout(ctx.deps, {
      ...ctx.input,
      items: [{ ticketTypeId: ctx.defaults.ticketTypeId, qty: 1 }],
      pendingOrderId: CART_ID,
    });

    expect(ctx.mocks.repos.promos.releaseHoldsForOrder).toHaveBeenCalledWith(
      CART_ID,
    );
  });

  it("returns the superseded cart's fee-waiver reservation", async () => {
    // The superseded cart reserved allowance at checkout (`ticketsUsed`
    // bumped). Cancelled orders are invisible to the expiry reaper, so unless
    // retirement releases it the buyer's retry pays the fee they were quoted
    // as waived.
    const ctx = makeContext({ capacity: 5, pendingCartHolds: { [CART_ID]: 1 } });
    withCart(ctx);

    await createCheckout(ctx.deps, {
      ...ctx.input,
      items: [{ ticketTypeId: ctx.defaults.ticketTypeId, qty: 1 }],
      pendingOrderId: CART_ID,
    });

    expect(ctx.mocks.repos.feeWaivers.release).toHaveBeenCalledWith(CART_ID);
  });

  it("gives the RETRY the allowance the declined cart was holding", async () => {
    // The headline decline-then-retry scenario. Waiver granted 1; cart A
    // reserved it, so the waiver is exhausted while A is PENDING; A's card
    // declines; the buyer retries carrying pendingOrderId=A. If A is retired
    // only AFTER this checkout looks up its waiver, the lookup sees nothing,
    // the full fee is baked into the new PaymentIntent, and the allowance
    // comes back for some later order — the buyer is charged the fee they
    // were told was waived. Retirement has to happen BEFORE the lookup.
    const ctx = makeContext({ capacity: 5, pendingCartHolds: { [CART_ID]: 1 } });
    withCart(ctx);

    const waiver = { id: "waiver-1" };
    let cartAHoldsTheAllowance = true;
    ctx.mocks.repos.feeWaivers.resolveApplicable.mockImplementation(async () =>
      cartAHoldsTheAllowance ? [] : [waiver],
    );
    ctx.mocks.repos.feeWaivers.release.mockImplementation(
      async (orderId: string) => {
        if (orderId === CART_ID) cartAHoldsTheAllowance = false;
        return { releasedTickets: 1 };
      },
    );
    ctx.mocks.repos.feeWaivers.reserve.mockResolvedValue({
      reservedTickets: 1,
      feeWaivedCents: 50,
      redemptionId: "redemption-2",
    });

    // Harness default: 2 × $10 tickets, 5% → 50¢ platform fee each = 100¢.
    const result = await createCheckout(ctx.deps, {
      ...ctx.input,
      pendingOrderId: CART_ID,
    });

    // One ticket's fee waived on THIS order, not a later one.
    expect(ctx.mocks.repos.feeWaivers.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ waiverId: "waiver-1" }),
    );
    expect(ctx.mocks.repos.feeWaivers.reserve).not.toHaveBeenCalledWith(
      expect.objectContaining({ orderId: CART_ID }),
    );
    expect(result.feesPlatformCents).toBe(50);
    expect(ctx.mocks.repos.orders.createPending).toHaveBeenCalledWith(
      expect.objectContaining({ feesPlatformCents: 50 }),
    );
  });

  it("gives the RETRY the credit the declined cart had spent", async () => {
    // Credit is SPENT at checkout, not held: `redeemConditional` on cart A
    // zeroed the $20 goodwill credit and pinned a redemption row to A. A's
    // card declines; the buyer retries carrying pendingOrderId=A. Unless
    // retirement gives the credit back BEFORE this checkout snapshots the
    // buyer's balance, the retry sees nothing to apply, the full amount is
    // baked into the new PaymentIntent, and the $20 is gone.
    const ctx = makeContext({
      capacity: 5,
      pendingCartHolds: { [CART_ID]: 1 },
      activeCredits: [{ id: "credit-1", balanceCents: 2000 }],
    });
    withCart(ctx);

    let cartAHoldsTheCredit = true;
    vi.mocked(ctx.mocks.repos.credits.listActiveForHuman).mockImplementation(
      async () =>
        cartAHoldsTheCredit
          ? []
          : Array.from(ctx.state.creditStore.values()).filter(
              (c) => c.status === "ACTIVE" && c.balanceCents > 0,
            ),
    );
    vi.mocked(ctx.mocks.repos.credits.releaseForOrder).mockImplementation(
      async (orderId: string) => {
        if (orderId === CART_ID) cartAHoldsTheCredit = false;
        return { releasedCents: 2000, creditIds: ["credit-1"] };
      },
    );

    // Harness default: 2 × $10 tickets → 2194¢ charged with no credit.
    const result = await createCheckout(ctx.deps, {
      ...ctx.input,
      pendingOrderId: CART_ID,
    });

    // `now` is forwarded unconditionally by the retire helper; createCheckout
    // passes none, and the adapter's `opts?.now ?? new Date()` covers it.
    expect(ctx.mocks.repos.credits.releaseForOrder).toHaveBeenCalledWith(
      CART_ID);
    expect(ctx.state.redeemConditionalMock).toHaveBeenCalledWith({
      creditId: "credit-1",
      requestedCents: 2000,
    });
    expect(result.creditAppliedCents).toBe(2000);
    expect(ctx.mocks.payments.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 2194 - 2000 }),
    );
  });

  it("releases the superseded cart's credit before the balance snapshot, and locks credit before capacity — as a plain checkout does", async () => {
    // Lock order, with the credit legs made visible. A PLAIN checkout by the
    // same buyer (another device, no local cart) takes the UserCredit lock in
    // `redeemConditional` and only THEN the capacity lock. The retry path has
    // to take UserCredit / UserCreditRedemption at the same relative position
    // — ahead of capacity — or the two paths deadlock on each other. It also
    // has to release BEFORE the snapshot, or the retry cannot spend what it
    // just got back (see the test above).
    //
    // `credit_snapshot` appears twice: once for the cap math and once inside
    // `applyAvailableCredits`. That is the real sequence, not a test artefact.
    const ctx = makeContext({
      capacity: 10,
      pendingCartHolds: { [CART_ID]: 1 },
      activeCredits: [{ id: "credit-1", balanceCents: 500 }],
    });
    withCart(ctx);
    const order: string[] = [];

    ctx.mocks.repos.orders.cancelPendingOrder.mockImplementation(
      async (id: string) => {
        order.push("retire");
        return ctx.state.pendingCartHolds.delete(id);
      },
    );
    vi.mocked(ctx.mocks.repos.credits.releaseForOrder).mockImplementation(
      async () => {
        order.push("release_credits");
        return { releasedCents: 0, creditIds: [] };
      },
    );
    ctx.mocks.repos.feeWaivers.resolveApplicable.mockImplementation(
      async () => {
        order.push("waiver_lookup");
        return [];
      },
    );
    const listActive = vi.mocked(ctx.mocks.repos.credits.listActiveForHuman);
    const originalListActive = listActive.getMockImplementation()!;
    listActive.mockImplementation(async (input) => {
      order.push("credit_snapshot");
      return originalListActive(input);
    });
    const originalRedeem =
      ctx.state.redeemConditionalMock.getMockImplementation()!;
    ctx.state.redeemConditionalMock.mockImplementation(async (input) => {
      order.push("credit_lock");
      return originalRedeem(input);
    });
    ctx.mocks.repos.tickets.lockAndCountCapacityForTicketType.mockImplementation(
      async () => {
        order.push("capacity");
        return { issued: 0, held: 0 };
      },
    );
    ctx.mocks.repos.seats.releaseExpiredHolds.mockImplementation(async () => {
      order.push("seats");
      return 0;
    });

    await createCheckout(ctx.deps, { ...ctx.input, pendingOrderId: CART_ID });

    expect(order).toEqual([
      "retire",
      "release_credits",
      "waiver_lookup",
      "credit_snapshot",
      "credit_snapshot",
      "credit_lock",
      "capacity",
      "seats",
    ]);
  });

  it("retires the cart before the waiver lookup, and still locks capacity before seats", async () => {
    // Two orderings in one: the hoist that makes the retry see its own
    // returned allowance, AND the deadlock rule (capacity lock ahead of any
    // Seat lock, matching startPosSale) that the hoist must not disturb.
    // Retirement touches Order / PromoHold / FeeWaiverRedemption rows only.
    const ctx = makeContext({ capacity: 10, pendingCartHolds: { [CART_ID]: 1 } });
    withCart(ctx);
    const order: string[] = [];

    ctx.mocks.repos.orders.cancelPendingOrder.mockImplementation(
      async (id: string) => {
        order.push("retire");
        return ctx.state.pendingCartHolds.delete(id);
      },
    );
    ctx.mocks.repos.feeWaivers.resolveApplicable.mockImplementation(
      async () => {
        order.push("waiver_lookup");
        return [];
      },
    );
    ctx.mocks.repos.tickets.lockAndCountCapacityForTicketType.mockImplementation(
      async () => {
        order.push("capacity");
        return { issued: 0, held: 0 };
      },
    );
    ctx.mocks.repos.seats.releaseExpiredHolds.mockImplementation(async () => {
      order.push("seats");
      return 0;
    });

    await createCheckout(ctx.deps, { ...ctx.input, pendingOrderId: CART_ID });

    expect(order).toEqual(["retire", "waiver_lookup", "capacity", "seats"]);
  });

  it("cancels the superseded cart's PaymentIntent BEFORE de-holding it", async () => {
    // A declined PI is not terminal — Stripe returns it to
    // `requires_payment_method`, still confirmable. Handing its inventory to
    // someone else while it can still be confirmed is the charge-with-no-
    // ticket bug all over again.
    const ctx = makeContext({ capacity: 5, pendingCartHolds: { [CART_ID]: 1 } });
    withCart(ctx, { stripePaymentIntentId: "pi_superseded" });

    const order: string[] = [];
    ctx.mocks.payments.cancelPaymentIntent.mockImplementation(async () => {
      order.push("cancel_pi");
      return { canceled: true };
    });
    ctx.mocks.repos.orders.cancelPendingOrder.mockImplementation(
      async (id: string) => {
        order.push("cancel_order");
        return ctx.state.pendingCartHolds.delete(id);
      },
    );

    await createCheckout(ctx.deps, {
      ...ctx.input,
      items: [{ ticketTypeId: ctx.defaults.ticketTypeId, qty: 1 }],
      pendingOrderId: CART_ID,
    });

    expect(ctx.mocks.payments.cancelPaymentIntent).toHaveBeenCalledWith({
      paymentIntentId: "pi_superseded",
    });
    expect(order).toEqual(["cancel_pi", "cancel_order"]);
  });

  it("KEEPS the hold when the PaymentIntent cannot be cancelled", async () => {
    // The asymmetry that matters: failing to retire costs a slightly
    // over-counted tier for <=15 minutes; retiring an order whose PI is still
    // live costs a real buyer a real charge for a ticket that no longer
    // exists. So a PI-cancel failure must NOT de-hold.
    const ctx = makeContext({ capacity: 5, pendingCartHolds: { [CART_ID]: 1 } });
    withCart(ctx, { stripePaymentIntentId: "pi_stuck" });
    ctx.mocks.payments.cancelPaymentIntent.mockRejectedValue(
      new Error("stripe down"),
    );

    // The buyer's own checkout still succeeds — they are excluded from their
    // own gate regardless.
    await expect(
      createCheckout(ctx.deps, {
        ...ctx.input,
        items: [{ ticketTypeId: ctx.defaults.ticketTypeId, qty: 1 }],
        pendingOrderId: CART_ID,
      }),
    ).resolves.toMatchObject({ orderId: DEFAULT_ORDER_ID });

    expect(ctx.mocks.repos.orders.cancelPendingOrder).not.toHaveBeenCalled();
    expect(ctx.state.pendingCartHolds.get(CART_ID)).toBe(1);
  });

  it("reports the PI-cancel failure to Sentry rather than swallowing it", async () => {
    const reportError = vi.fn();
    const ctx = makeContext({ capacity: 5, pendingCartHolds: { [CART_ID]: 1 } });
    withCart(ctx, { stripePaymentIntentId: "pi_stuck" });
    ctx.mocks.payments.cancelPaymentIntent.mockRejectedValue(
      new Error("stripe down"),
    );

    await createCheckout(
      { ...ctx.deps, reportError },
      {
        ...ctx.input,
        items: [{ ticketTypeId: ctx.defaults.ticketTypeId, qty: 1 }],
        pendingOrderId: CART_ID,
      },
    );

    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ step: "retireCarriedOverCart" }),
      }),
    );
  });

  // NOTE: the "a throwing reporter cannot change behaviour" guarantee is
  // asserted directly on `settleCarriedOverCartPaymentIntent` in its own
  // spec (`_shared/__tests__/retire-carried-over-cart.test.ts`), not here.
  // End-to-end it is currently unobservable through createCheckout because
  // `fee-waiver-checkout.ts` calls `reportError?.()` UNGUARDED inside its
  // swallow branch (line ~119) and runs earlier in the transaction, so a
  // throwing reporter fails the whole checkout before reaching this code.
  // That is a real pre-existing defect in a foreign file, deliberately not
  // fixed here.

  it("does not retire an order belonging to someone else", async () => {
    const ctx = makeContext({ capacity: 5, pendingCartHolds: { [CART_ID]: 1 } });
    ctx.mocks.repos.orders.getById.mockImplementation(async (id: string) =>
      id === CART_ID
        ? {
            id: CART_ID,
            buyerHumanId: "12121212-1212-4121-8121-121212121212",
            eventId: ctx.defaults.eventId,
            status: "PENDING",
            stripePaymentIntentId: null,
            items: [],
          }
        : { ...ctx.state.order },
    );

    await createCheckout(ctx.deps, {
      ...ctx.input,
      items: [{ ticketTypeId: ctx.defaults.ticketTypeId, qty: 1 }],
      pendingOrderId: CART_ID,
    });

    expect(ctx.mocks.repos.orders.cancelPendingOrder).not.toHaveBeenCalled();
    expect(ctx.state.pendingCartHolds.get(CART_ID)).toBe(1);
  });
});

// ── Superseded cart whose PaymentIntent already SUCCEEDED ───────────────────
//
// The cart-recovery path makes this ordinary, not exotic: buyer pays, closes
// the tab before confirmPayment fires, returns and hits Resume. The order is
// still PENDING with a live hold, so `get-active-cart-holds` offers it and the
// client sends it as `pendingOrderId`. Cancelling it here would strand a real
// charge — zero tickets, no splits, and the buyer paying twice.
describe("createCheckout — superseded cart with a SUCCEEDED PaymentIntent", () => {
  const PAID_CART_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const SEAT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  function withPaidCart(
    ctx: ReturnType<typeof makeContext>,
    opts: { status?: string; seatIds?: string[] } = {},
  ) {
    // Stripe's graceful no-op for an already-terminal PI: no throw.
    ctx.mocks.payments.cancelPaymentIntent.mockResolvedValue({
      canceled: false,
    });
    ctx.mocks.payments.retrievePaymentIntent.mockResolvedValue({
      id: "pi_paid",
      status: opts.status ?? "succeeded",
      amountReceived: 2000,
      currency: "usd",
      metadata: {},
    });
    ctx.mocks.repos.orders.getById.mockImplementation(async (id: string) =>
      id === PAID_CART_ID
        ? {
            id: PAID_CART_ID,
            buyerHumanId: ctx.defaults.buyerHumanId,
            eventId: ctx.defaults.eventId,
            status: "PENDING",
            stripePaymentIntentId: "pi_paid",
            items: opts.seatIds
              ? [
                  {
                    kind: "ticket",
                    ticketTypeId: ctx.defaults.ticketTypeId,
                    qty: 1,
                    meta: { seatIds: opts.seatIds },
                  },
                ]
              : [],
          }
        : { ...ctx.state.order },
    );
  }

  it("does NOT cancel the paid order, and leaves its hold in place", async () => {
    const ctx = makeContext({
      capacity: 10,
      pendingCartHolds: { [PAID_CART_ID]: 1 },
    });
    withPaidCart(ctx);

    await createCheckout(ctx.deps, {
      ...ctx.input,
      items: [{ ticketTypeId: ctx.defaults.ticketTypeId, qty: 1 }],
      pendingOrderId: PAID_CART_ID,
    });

    expect(ctx.mocks.repos.orders.cancelPendingOrder).not.toHaveBeenCalled();
    expect(ctx.state.pendingCartHolds.get(PAID_CART_ID)).toBe(1);
  });

  it("does NOT release the paid order's seats to the new order", async () => {
    // The live order still mints against these seat ids
    // (`mintTicketsForOrder` reads `meta.seatIds`), so handing them over would
    // double-assign the seat.
    const ctx = makeContext({
      capacity: 10,
      pendingCartHolds: { [PAID_CART_ID]: 1 },
    });
    withPaidCart(ctx, { seatIds: [SEAT_ID] });

    await createCheckout(ctx.deps, {
      ...ctx.input,
      items: [{ ticketTypeId: ctx.defaults.ticketTypeId, qty: 1 }],
      pendingOrderId: PAID_CART_ID,
    });

    expect(ctx.mocks.repos.seats.releaseSeats).not.toHaveBeenCalled();
  });

  it("counts the paid cart against the CAPACITY gate instead of excluding it", async () => {
    // The double-charge. `excludeOrderId` drops the named order's PENDING
    // ticket lines from `held` so a buyer is not refused their own cart — but
    // that is only sound once the cart is DEAD. Here retirement declined (PI
    // succeeded), so the cart is alive and will mint the last ticket when its
    // webhook lands. Excluding it anyway makes the gate see that ticket as
    // free and cuts a SECOND live PaymentIntent for it: the buyer is charged
    // twice and the tier oversells.
    //
    // GA tier (`seatSectionId: null`), so nothing downstream catches it:
    // `holdSeatsForCheckout` skips unseated types, and `mintTickets`'s
    // issued-only backstop cannot see a hold.
    const ctx = makeContext({
      capacity: 1,
      pendingCartHolds: { [PAID_CART_ID]: 1 },
    });
    withPaidCart(ctx);

    await expect(
      createCheckout(ctx.deps, {
        ...ctx.input,
        items: [{ ticketTypeId: ctx.defaults.ticketTypeId, qty: 1 }],
        pendingOrderId: PAID_CART_ID,
      }),
    ).rejects.toMatchObject({ code: "TICKET_TYPE_TEMPORARILY_HELD" });

    // Asked WITHOUT the exclusion, because retirement declined.
    expect(
      ctx.mocks.repos.tickets.lockAndCountCapacityForTicketType,
    ).toHaveBeenCalledWith(expect.objectContaining({ excludeOrderId: null }));
    // The two things that would have gone wrong.
    expect(ctx.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.mocks.repos.orders.createPending).not.toHaveBeenCalled();
    // And the paid cart keeps the unit it is about to mint.
    expect(ctx.state.pendingCartHolds.get(PAID_CART_ID)).toBe(1);
  });

  it("counts the cart when retirement declined on a Stripe blip", async () => {
    // `pi_settle_failed`: the PI's status is unknown, so the cart keeps its
    // reservation and the gate must keep counting it. Oversell rather than
    // double charge on this refusal, but the same under-count.
    const ctx = makeContext({
      capacity: 1,
      pendingCartHolds: { [PAID_CART_ID]: 1 },
    });
    withPaidCart(ctx);
    ctx.mocks.payments.cancelPaymentIntent.mockRejectedValue(
      new Error("stripe down"),
    );

    await expect(
      createCheckout(ctx.deps, {
        ...ctx.input,
        items: [{ ticketTypeId: ctx.defaults.ticketTypeId, qty: 1 }],
        pendingOrderId: PAID_CART_ID,
      }),
    ).rejects.toMatchObject({ code: "TICKET_TYPE_TEMPORARILY_HELD" });

    expect(
      ctx.mocks.repos.tickets.lockAndCountCapacityForTicketType,
    ).toHaveBeenCalledWith(expect.objectContaining({ excludeOrderId: null }));
    expect(ctx.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
  });

  it("still excludes the cart once retirement SUCCEEDS — the buyer keeps their own hold", async () => {
    // The other direction, and the reason the exclusion exists: a cart whose
    // PI cancelled cleanly is dead, so its unit belongs to this checkout. The
    // last ticket must stay buyable by the person already holding it.
    const ctx = makeContext({
      capacity: 1,
      pendingCartHolds: { [PAID_CART_ID]: 1 },
    });
    withPaidCart(ctx, { status: "canceled" });

    await expect(
      createCheckout(ctx.deps, {
        ...ctx.input,
        items: [{ ticketTypeId: ctx.defaults.ticketTypeId, qty: 1 }],
        pendingOrderId: PAID_CART_ID,
      }),
    ).resolves.toMatchObject({ orderId: DEFAULT_ORDER_ID });

    expect(
      ctx.mocks.repos.tickets.lockAndCountCapacityForTicketType,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ excludeOrderId: PAID_CART_ID }),
    );
  });

  it("still retires a cart whose PI was already CANCELED (idempotent replay)", async () => {
    const ctx = makeContext({
      capacity: 10,
      pendingCartHolds: { [PAID_CART_ID]: 1 },
    });
    withPaidCart(ctx, { status: "canceled" });

    await createCheckout(ctx.deps, {
      ...ctx.input,
      items: [{ ticketTypeId: ctx.defaults.ticketTypeId, qty: 1 }],
      pendingOrderId: PAID_CART_ID,
    });

    // The cancel CAS carries the PI that was settled before the transaction.
    expect(ctx.mocks.repos.orders.cancelPendingOrder).toHaveBeenCalledWith(
      PAID_CART_ID,
      { expectedPaymentIntentId: "pi_paid" },
    );
    expect(ctx.state.pendingCartHolds.has(PAID_CART_ID)).toBe(false);
  });
});

/**
 * Retiring the carried-over cart proves its ORDER is dead. It proves nothing
 * about who holds its SEATS.
 *
 * That cart can be up to the cart TTL (1200s) plus a cron period old while the
 * seat-hold TTL is only 900s, so the seat reaper may already have freed one of
 * its seats and another buyer may be holding — or paying for — it right now.
 * `Seat` has no holder column, so `status = "HELD"` cannot tell the two apart:
 * only the `heldBefore` stamp fence can.
 */
describe("createCheckout — the carried-over seat release is fenced", () => {
  const FENCED_CART_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const SEAT_MINE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const SEAT_THEIRS = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const ORDER_HOLD_TTL_SECONDS = 900;
  const FENCE_SLACK_SECONDS = 60;

  function withSeatedCart(
    ctx: ReturnType<typeof makeContext>,
    opts: { seatIds: string[]; occurredAt: Date; heldAt?: Date },
  ) {
    const heldAt = opts.heldAt ?? opts.occurredAt;
    ctx.mocks.repos.orders.getById.mockImplementation(async (id: string) =>
      id === FENCED_CART_ID
        ? {
            id: FENCED_CART_ID,
            buyerHumanId: ctx.defaults.buyerHumanId,
            eventId: ctx.defaults.eventId,
            status: "PENDING",
            stripePaymentIntentId: null,
            occurredAt: opts.occurredAt,
            items: [
              {
                kind: "ticket",
                ticketTypeId: ctx.defaults.ticketTypeId,
                qty: 1,
                meta: {
                  seatIds: opts.seatIds,
                  holdExpiresAt: new Date(
                    heldAt.getTime() + ORDER_HOLD_TTL_SECONDS * 1000,
                  ).toISOString(),
                },
              },
            ],
          }
        : { ...ctx.state.order },
    );
  }

  /**
   * Seat status AND `updatedAt` as real state, mirroring the Prisma adapter's
   * `where`: `status: "HELD"` plus, when passed, `updatedAt: { lte:
   * heldBefore }`.
   */
  function withSeatState(
    ctx: ReturnType<typeof makeContext>,
    updatedAt: Record<string, Date>,
  ) {
    const status = new Map<string, "AVAILABLE" | "HELD">();
    const stamps = new Map<string, Date>();
    for (const [id, when] of Object.entries(updatedAt)) {
      status.set(id, "HELD");
      stamps.set(id, when);
    }
    ctx.mocks.repos.seats.releaseSeats.mockImplementation(
      async (input: {
        seatIds: string[];
        releasedAt: Date;
        heldBefore?: Date;
      }) => {
        for (const id of input.seatIds) {
          if (status.get(id) !== "HELD") continue;
          const stamp = stamps.get(id);
          if (
            input.heldBefore &&
            stamp &&
            stamp.getTime() > input.heldBefore.getTime()
          ) {
            continue;
          }
          status.set(id, "AVAILABLE");
          stamps.set(id, input.releasedAt);
        }
      },
    );
    return status;
  }

  it("fences the release to the superseded cart's own hold", async () => {
    const ctx = makeContext({
      capacity: 5,
      pendingCartHolds: { [FENCED_CART_ID]: 1 },
    });
    const occurredAt = new Date(ctx.defaults.now.getTime() - 1000 * 1000);
    withSeatedCart(ctx, { seatIds: [SEAT_MINE], occurredAt });

    await createCheckout(ctx.deps, {
      ...ctx.input,
      items: [{ ticketTypeId: ctx.defaults.ticketTypeId, qty: 1 }],
      pendingOrderId: FENCED_CART_ID,
    });

    expect(ctx.mocks.repos.seats.releaseSeats).toHaveBeenCalledWith({
      seatIds: [SEAT_MINE],
      releasedAt: ctx.defaults.now,
      heldBefore: new Date(
        occurredAt.getTime() + FENCE_SLACK_SECONDS * 1000,
      ),
    });
  });

  it("does NOT free a seat re-held by a different, live order", async () => {
    const ctx = makeContext({
      capacity: 5,
      pendingCartHolds: { [FENCED_CART_ID]: 1 },
    });
    const occurredAt = new Date(ctx.defaults.now.getTime() - 1000 * 1000);
    withSeatedCart(ctx, {
      seatIds: [SEAT_MINE, SEAT_THEIRS],
      occurredAt,
    });
    const status = withSeatState(ctx, {
      [SEAT_MINE]: occurredAt,
      // The seat reaper freed this one at occurredAt+900; somebody else took
      // it at occurredAt+960 and their PaymentIntent is live.
      [SEAT_THEIRS]: new Date(occurredAt.getTime() + 960 * 1000),
    });

    await createCheckout(ctx.deps, {
      ...ctx.input,
      items: [{ ticketTypeId: ctx.defaults.ticketTypeId, qty: 1 }],
      pendingOrderId: FENCED_CART_ID,
    });

    expect(status.get(SEAT_MINE)).toBe("AVAILABLE");
    expect(status.get(SEAT_THEIRS)).toBe("HELD");
  });

  it("follows the cart's LAST hold when the buyer had edited it", async () => {
    // `updateOrderItems` re-holds without rewriting `occurredAt`, so an
    // `occurredAt`-only fence would leak an edited cart's seats until the
    // seat reaper's own TTL.
    const ctx = makeContext({
      capacity: 5,
      pendingCartHolds: { [FENCED_CART_ID]: 1 },
    });
    const occurredAt = new Date(ctx.defaults.now.getTime() - 1000 * 1000);
    const editedAt = new Date(occurredAt.getTime() + 300 * 1000);
    withSeatedCart(ctx, {
      seatIds: [SEAT_MINE],
      occurredAt,
      heldAt: editedAt,
    });
    const status = withSeatState(ctx, { [SEAT_MINE]: editedAt });

    await createCheckout(ctx.deps, {
      ...ctx.input,
      items: [{ ticketTypeId: ctx.defaults.ticketTypeId, qty: 1 }],
      pendingOrderId: FENCED_CART_ID,
    });

    expect(status.get(SEAT_MINE)).toBe("AVAILABLE");
    expect(ctx.mocks.repos.seats.releaseSeats).toHaveBeenCalledWith(
      expect.objectContaining({
        heldBefore: new Date(
          editedAt.getTime() + FENCE_SLACK_SECONDS * 1000,
        ),
      }),
    );
  });

  it("releases NOTHING and reports when no fence can be computed", async () => {
    const ctx = makeContext({
      capacity: 5,
      pendingCartHolds: { [FENCED_CART_ID]: 1 },
    });
    const reportError = vi.fn();
    ctx.deps.reportError = reportError;
    ctx.mocks.repos.orders.getById.mockImplementation(async (id: string) =>
      id === FENCED_CART_ID
        ? {
            id: FENCED_CART_ID,
            buyerHumanId: ctx.defaults.buyerHumanId,
            eventId: ctx.defaults.eventId,
            status: "PENDING",
            stripePaymentIntentId: null,
            // No `occurredAt`, no `holdExpiresAt` — unreachable through
            // Prisma, but an unfenced release here is the double-sell.
            items: [
              {
                kind: "ticket",
                ticketTypeId: ctx.defaults.ticketTypeId,
                qty: 1,
                meta: { seatIds: [SEAT_MINE] },
              },
            ],
          }
        : { ...ctx.state.order },
    );

    await createCheckout(ctx.deps, {
      ...ctx.input,
      items: [{ ticketTypeId: ctx.defaults.ticketTypeId, qty: 1 }],
      pendingOrderId: FENCED_CART_ID,
    });

    expect(ctx.mocks.repos.seats.releaseSeats).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "create_checkout_seat_fence_missing",
      }),
      expect.objectContaining({
        tags: expect.objectContaining({ useCase: "createCheckout" }),
      }),
    );
  });
});

describe("createCheckout — only ACTIVE ticket types are sellable (money audit 2026-09-08 #14)", () => {
  // `listTicketTypes` returns EVERY status (admin needs the unpublished ones),
  // so the sellable map has to be narrowed here — to the same
  // `status === "ACTIVE"` rule the public page (`listEventTicketTypes`), the
  // card tiers and the POS listing display. At the port the non-sellable
  // statuses are ONE value: the adapter folds the DB's INACTIVE and ARCHIVED
  // to "DRAFT" (`TicketTypeStatus = "DRAFT" | "ACTIVE"`), so "DRAFT" is the
  // only non-sellable value a use case can ever see, and the only one worth
  // feeding it. An archived or unpublished tier must not remain purchasable
  // by id.
  const HIDDEN_TICKET_TYPE_ID = "aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa";

  function twoTiers(ctx: ReturnType<typeof makeContext>) {
    ctx.mocks.repos.events.listTicketTypes.mockResolvedValue([
      {
        id: ctx.defaults.ticketTypeId,
        priceCents: 1000,
        status: "ACTIVE" as const,
        capacity: 1000,
        seatSectionId: null,
        resaleAllowed: false,
        resaleCapCents: null,
        transferAllowed: true,
      },
      {
        id: HIDDEN_TICKET_TYPE_ID,
        priceCents: 1000,
        status: "DRAFT" as const,
        capacity: 1000,
        seatSectionId: null,
        resaleAllowed: false,
        resaleCapCents: null,
        transferAllowed: true,
      },
    ]);
  }

  {
    it("refuses an archived or unpublished (DRAFT) tier named by id — no PaymentIntent, no order", async () => {
      const ctx = makeContext();
      twoTiers(ctx);

      await expect(
        createCheckout(ctx.deps, {
          ...ctx.input,
          items: [{ ticketTypeId: HIDDEN_TICKET_TYPE_ID, qty: 1 }],
        }),
      ).rejects.toMatchObject({
        code: "not_found",
        message: "ticket_type_not_found",
      });

      expect(ctx.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
      expect(ctx.state.lastCreatePendingInput).toBeNull();
    });
  }

  it("still sells the ACTIVE type listed alongside a DRAFT one", async () => {
    const ctx = makeContext();
    twoTiers(ctx);

    const result = await createCheckout(ctx.deps, ctx.input);

    expect(result.orderId).toBe(DEFAULT_ORDER_ID);
    expect(ctx.mocks.payments.createPaymentIntent).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Jurisdictional taxable base (lib/pricing/taxable-base.ts)
//
// Tennessee taxes the FULL amount the buyer pays — a 2019 TN ruling puts
// platform and processing fees passed through to the buyer inside the taxable
// admission charge whether or not they are separately stated. Every other
// jurisdiction we have a ruling for taxes the ticket face, which is what every
// call site did unconditionally before the base table existed.
//
// The BEFORE numbers below were captured from HEAD (pre-change) and pinned as
// literals: for any situs that is not US/TN, every cent must be byte-identical.
// ─────────────────────────────────────────────────────────────────────────────
describe("createCheckout — jurisdictional taxable base", () => {
  // Flat $0.50/ticket platform fee, PASS_THROUGH, Stripe card rate 2.9% + 30¢.
  const flatFeeOptions = {
    feeMode: "PASS_THROUGH" as const,
    buyerFeePct: 0,
    platformFixedCents: 50,
  };

  /** The $25 Nashville ticket from the research note, at the seeded 9.75%. */
  const NASHVILLE = {
    ...flatFeeOptions,
    ticketPriceCents: 2500,
    admissionTaxRateBps: 975,
  };

  const piAmount = (ctx: ReturnType<typeof makeContext>): number => {
    const calls = ctx.mocks.payments.createPaymentIntent.mock.calls;
    const last = calls[calls.length - 1] as
      | [{ amountCents: number }]
      | undefined;
    return last![0].amountCents;
  };

  const buyOne = async (ctx: ReturnType<typeof makeContext>) =>
    createCheckout(ctx.deps, {
      ...ctx.input,
      items: [{ ticketTypeId: ctx.defaults.ticketTypeId, qty: 1 }],
    });

  it("US/TN PASS_THROUGH taxes face + platform + processor, not the face alone", async () => {
    const ctx = makeContext({
      ...NASHVILLE,
      taxSitus: { countryCode: "US", region: "TN", postalCode: "37203" },
    });

    const result = await buyOne(ctx);

    // Pre-change (face-only): tax 244, processor 115, charge 2909.
    // TN base = 2500 face + 50 platform + 115 processor = 2665.
    //   tax = round(2665 × 9.75%) = 260 — 16¢ more than the face-only 244.
    expect(result.taxAmountCents).toBe(260);
    expect(result.processorFeeCents).toBe(115);
    expect(piAmount(ctx)).toBe(2500 + 50 + 260 + 115);
    expect(piAmount(ctx)).toBe(2925);

    // The tax really is one rounding over what the buyer pays for admission.
    expect(result.taxAmountCents).toBe(Math.round((2665 * 975) / 10_000));
    // …and the processor fee still funds Stripe's deduction over the POST-tax
    // base, so the gross-up contract is intact at the new tax.
    expect(result.processorFeeCents).toBe(
      solveProcessingFeeGrossUp(2500 + 50 + 260, 0.029, 30),
    );

    // Persisted on the order, so settlement/refunds see the collected amount.
    expect(ctx.state.lastCreatePendingInput!.taxAmountCents).toBe(260);
    expect(ctx.state.lastCreatePendingInput).toMatchObject({
      taxSitusCountry: "US",
      taxSitusState: "TN",
    });
  });

  it("US/TN: a fee policy still saying ABSORB is taxed on the buyer total like any sale", async () => {
    // ABSORB is removed (docs/decisions/absorb-removed.md). It used to tax the
    // face alone (244, charge 2744); the legacy row now prices exactly like
    // the PASS_THROUGH case above.
    const ctx = makeContext({
      ...NASHVILLE,
      feeMode: "ABSORB",
      taxSitus: { countryCode: "US", region: "TN", postalCode: "37203" },
    });

    const result = await buyOne(ctx);

    expect(result.taxAmountCents).toBe(260);
    expect(result.processorFeeCents).toBe(115);
    expect(piAmount(ctx)).toBe(2925);
  });

  it("the TN widening does NOT touch the organiser's settlement basis", async () => {
    const ctx = makeContext({
      ...NASHVILLE,
      taxSitus: { countryCode: "US", region: "TN", postalCode: "37203" },
    });

    await buyOne(ctx);

    const pending = ctx.state.lastCreatePendingInput!;
    // Tax is buyer money held for the state — it must never widen the gross the
    // organiser is paid on.
    expect(pending.amountGrossCents).toBe(2500);
    expect(pending.feesPlatformCents).toBe(50);
  });

  it("keeps the finalize AMOUNT_MISMATCH invariant in TN", async () => {
    const ctx = makeContext({
      ...NASHVILLE,
      taxSitus: { countryCode: "US", region: "TN", postalCode: "37203" },
    });

    await createCheckout(ctx.deps, {
      ...ctx.input,
      items: [{ ticketTypeId: ctx.defaults.ticketTypeId, qty: 2 }],
    });

    const pending = ctx.state.lastCreatePendingInput!;
    const expected = computeExpectedPaymentAmount({
      amountGrossCents: pending.amountGrossCents,
      feesPlatformCents: pending.feesPlatformCents,
      taxAmountCents: pending.taxAmountCents ?? 0,
      items: pending.items.map((item) => ({
        amountCents: item.amountCents,
        meta: item.meta ?? {},
        kind: item.kind,
      })),
    });

    expect(expected).toBe(piAmount(ctx));
  });

  it("US/MN PASS_THROUGH taxes face + platform + processor (BUYER_TOTAL) and keeps the AMOUNT_MISMATCH invariant", async () => {
    // Minnesota situs at 903 bps (6.875% state + 2.15% local general sales
    // tax). 55420 is Bloomington, outside Minneapolis, so no entertainment-tax
    // line applies; the Minneapolis case lives in
    // minneapolis-entertainment-tax.test.ts.
    const ctx = makeContext({
      ...flatFeeOptions,
      ticketPriceCents: 2500,
      admissionTaxRateBps: 903,
      taxSitus: { countryCode: "US", region: "MN", postalCode: "55420" },
    });

    const result = await buyOne(ctx);

    // Joint solve: base = 2500 face + 50 platform + 115 processor = 2665.
    //   tax = round(2665 × 9.03%) = round(240.65) = 241
    //   processor = gross-up over face + platform + tax = 2791 → 115
    //   charge = 2500 + 50 + 241 + 115 = 2906
    // Face-only would be round(2500 × 9.03%) = 226, i.e. 15¢ under-collected.
    expect(result.taxAmountCents).toBe(241);
    expect(result.processorFeeCents).toBe(115);
    expect(piAmount(ctx)).toBe(2500 + 50 + 241 + 115);
    expect(piAmount(ctx)).toBe(2906);
    expect(result.taxAmountCents).toBe(Math.round((2665 * 903) / 10_000));
    expect(result.taxAmountCents).toBeGreaterThan(
      Math.round((2500 * 903) / 10_000),
    );
    expect(result.processorFeeCents).toBe(
      solveProcessingFeeGrossUp(2500 + 50 + 241, 0.029, 30),
    );

    const pending = ctx.state.lastCreatePendingInput!;
    expect(pending.taxAmountCents).toBe(241);
    expect(pending).toMatchObject({
      taxSitusCountry: "US",
      taxSitusState: "MN",
    });
    // Settlement basis is untouched by the wider tax base.
    expect(pending.amountGrossCents).toBe(2500);
    expect(pending.feesPlatformCents).toBe(50);

    const expected = computeExpectedPaymentAmount({
      amountGrossCents: pending.amountGrossCents,
      feesPlatformCents: pending.feesPlatformCents,
      taxAmountCents: pending.taxAmountCents ?? 0,
      items: pending.items.map((item) => ({
        amountCents: item.amountCents,
        meta: item.meta ?? {},
        kind: item.kind,
      })),
    });
    expect(expected).toBe(piAmount(ctx));
  });

  // ── BYTE-IDENTICAL REGRESSION ────────────────────────────────────────────
  // Every non-TN situs must produce exactly the numbers HEAD produced. The
  // literals are the pre-change values, not a re-derivation.
  const FACE_ONLY_EXPECTED = {
    taxAmountCents: 244,
    processorFeeCents: 115,
    chargeCents: 2909,
  };

  it.each([
    [
      "US/FL (separately-stated fee is excluded — ruled TICKET_FACE)",
      { countryCode: "US", region: "FL", postalCode: "33139" },
    ],
    [
      "US/CA (no base ruling: falls back to TICKET_FACE)",
      { countryCode: "US", region: "CA", postalCode: "94103" },
    ],
    [
      "no situs at all (event with no resolvable location)",
      { countryCode: null, region: null, postalCode: null },
    ],
  ])("%s charges exactly what HEAD charged", async (_label, taxSitus) => {
    const ctx = makeContext({ ...NASHVILLE, taxSitus });

    const result = await buyOne(ctx);

    expect(result.taxAmountCents).toBe(FACE_ONLY_EXPECTED.taxAmountCents);
    expect(result.processorFeeCents).toBe(
      FACE_ONLY_EXPECTED.processorFeeCents,
    );
    expect(piAmount(ctx)).toBe(FACE_ONLY_EXPECTED.chargeCents);
    // Same arithmetic HEAD ran, spelled out.
    expect(result.taxAmountCents).toBe(Math.round((2500 * 975) / 10_000));
    expect(result.processorFeeCents).toBe(
      solveProcessingFeeGrossUp(2500 + 50 + 244, 0.029, 30),
    );
  });

  it("CA/AB (Canada) keeps the face base — our fee is a separate supply", async () => {
    const ctx = makeContext({
      ...flatFeeOptions,
      ticketPriceCents: 2500,
      admissionTaxRateBps: 500,
      taxSitus: { countryCode: "CA", region: "AB", postalCode: "T5J 3N9" },
    });

    const result = await buyOne(ctx);

    expect(result.taxAmountCents).toBe(Math.round((2500 * 500) / 10_000));
    expect(result.taxAmountCents).toBe(125);
    expect(piAmount(ctx)).toBe(
      2500 + 50 + 125 + solveProcessingFeeGrossUp(2675, 0.029, 30),
    );
  });

  it("an UNRULED taxing situs (US/TX) falls back to the face AND reports exactly once", async () => {
    const reportError = vi.fn();
    const ctx = makeContext({
      ...flatFeeOptions,
      ticketPriceCents: 2500,
      // Texas is deliberately absent from the base table — there is no ruling
      // yet, so it must shout rather than inherit a guess.
      admissionTaxRateBps: 825,
      taxSitus: { countryCode: "US", region: "TX", postalCode: "78701" },
    });

    const result = await createCheckout(
      { ...ctx.deps, reportError },
      { ...ctx.input, items: [{ ticketTypeId: ctx.defaults.ticketTypeId, qty: 1 }] },
    );

    // Unchanged behaviour: the face base.
    expect(result.taxAmountCents).toBe(Math.round((2500 * 825) / 10_000));
    expect(result.taxAmountCents).toBe(206);

    // ONCE per order, not once per ticket line, with the situs in the message
    // so Sentry groups one issue per jurisdiction.
    const baseReports = reportError.mock.calls.filter(
      ([, context]) =>
        (context as { tags?: Record<string, string> } | undefined)?.tags
          ?.step === "resolveTaxableBase",
    );
    expect(baseReports).toHaveLength(1);
    expect((baseReports[0]![0] as Error).message).toBe(
      "unknown_taxable_base_situs US/TX",
    );
    expect(baseReports[0]![1]).toMatchObject({
      tags: { area: "tax", step: "resolveTaxableBase" },
      extra: { rateBps: 825, useCase: "resolveCheckoutTax" },
    });
  });

  it("does NOT report for a taxing situs we HAVE ruled on, or for a zero rate", async () => {
    for (const [taxSitus, admissionTaxRateBps] of [
      [{ countryCode: "US", region: "TN", postalCode: "37203" }, 975],
      [{ countryCode: "US", region: "FL", postalCode: "33139" }, 650],
      // Unruled, but collecting nothing — no liability, no noise.
      [{ countryCode: "US", region: "TX", postalCode: "78701" }, 0],
    ] as const) {
      const reportError = vi.fn();
      const ctx = makeContext({
        ...flatFeeOptions,
        ticketPriceCents: 2500,
        admissionTaxRateBps,
        taxSitus,
      });

      await createCheckout(
        { ...ctx.deps, reportError },
        {
          ...ctx.input,
          items: [{ ticketTypeId: ctx.defaults.ticketTypeId, qty: 1 }],
        },
      );

      expect(
        reportError.mock.calls.filter(
          ([, context]) =>
            (context as { tags?: Record<string, string> } | undefined)?.tags
              ?.step === "resolveTaxableBase",
        ),
      ).toHaveLength(0);
    }
  });
});

describe("createCheckout — per-imposition tax lines (OrderTaxLine)", () => {
  const flatFeeOptions = {
    feeMode: "PASS_THROUGH" as const,
    buyerFeePct: 0,
    platformFixedCents: 50,
    ticketPriceCents: 2500,
  };
  const TN = { countryCode: "US", region: "TN", postalCode: "37203" };
  const CHICAGO = { countryCode: "US", region: "IL", postalCode: "60614" };

  const CITY_PLATFORM: LocalTaxImpositionRule = {
    code: "CHI_AMUSEMENT",
    label: "Chicago amusement tax",
    jurisdiction: "US/IL/Chicago",
    countryCode: "US",
    region: "IL",
    postalCodes: ["60614"],
    rateBps: 900,
    base: "BUYER_TOTAL",
    collector: "PLATFORM",
    source: "TEST FIXTURE — not a real citation",
  };
  const CITY_ORGANISER: LocalTaxImpositionRule = {
    ...CITY_PLATFORM,
    code: "VENUE_SEAT",
    label: "Venue seat tax",
    base: "TICKET_FACE",
    collector: "ORGANISER",
  };

  const piAmount = (ctx: ReturnType<typeof makeContext>): number => {
    const calls = ctx.mocks.payments.createPaymentIntent.mock.calls;
    const last = calls[calls.length - 1] as
      | [{ amountCents: number }]
      | undefined;
    return last![0].amountCents;
  };

  const buy = async (ctx: ReturnType<typeof makeContext>, qty = 1) =>
    createCheckout(ctx.deps, {
      ...ctx.input,
      items: [{ ticketTypeId: ctx.defaults.ticketTypeId, qty }],
    });

  const platformSum = (ctx: ReturnType<typeof makeContext>) =>
    (ctx.state.lastCreateTaxLinesInput?.lines ?? [])
      .filter((line) => line.collector === "PLATFORM")
      .reduce((sum, line) => sum + line.amountCents, 0);

  const finalizeExpected = (ctx: ReturnType<typeof makeContext>) => {
    const pending = ctx.state.lastCreatePendingInput!;
    return computeExpectedPaymentAmount({
      amountGrossCents: pending.amountGrossCents,
      feesPlatformCents: pending.feesPlatformCents,
      taxAmountCents: pending.taxAmountCents ?? 0,
      items: pending.items.map((item) => ({
        amountCents: item.amountCents,
        meta: item.meta ?? {},
        kind: item.kind,
      })),
    });
  };

  const withLocalRules = async <T,>(
    rules: LocalTaxImpositionRule[],
    fn: () => Promise<T>,
  ): Promise<T> => {
    localTaxRules.rules = rules;
    try {
      return await fn();
    } finally {
      localTaxRules.rules = null;
    }
  };

  it("TN PASS_THROUGH persists ONE SALES line whose amount IS taxAmountCents (pinned 260)", async () => {
    const ctx = makeContext({
      ...flatFeeOptions,
      admissionTaxRateBps: 975,
      taxSitus: TN,
    });

    const result = await buy(ctx);

    // Same pinned numbers as the jurisdictional-base suite — nothing moved.
    expect(result.taxAmountCents).toBe(260);
    expect(piAmount(ctx)).toBe(2925);

    expect(ctx.mocks.repos.orders.createTaxLines).toHaveBeenCalledTimes(1);
    expect(ctx.state.lastCreateTaxLinesInput).toEqual({
      orderId: DEFAULT_ORDER_ID,
      lines: [
        {
          code: "SALES",
          label: "Sales tax",
          jurisdiction: "US/TN",
          rateBps: 975,
          base: "BUYER_TOTAL",
          collector: "PLATFORM",
          taxableAmountCents: 2665,
          amountCents: 260,
        },
      ],
    });
    expect(platformSum(ctx)).toBe(
      ctx.state.lastCreatePendingInput!.taxAmountCents,
    );
  });

  it("writes the lines AFTER the order row, in the same transaction", async () => {
    const ctx = makeContext({
      ...flatFeeOptions,
      admissionTaxRateBps: 975,
      taxSitus: TN,
    });
    await buy(ctx);
    const pendingOrder =
      ctx.mocks.repos.orders.createPending.mock.invocationCallOrder[0]!;
    const linesOrder =
      ctx.mocks.repos.orders.createTaxLines.mock.invocationCallOrder[0]!;
    expect(linesOrder).toBeGreaterThan(pendingOrder);
    // Keyed by the id the order row was created with (the fake returns a fixed
    // id; the adapter returns the pre-minted one).
    const created = await ctx.mocks.repos.orders.createPending.mock.results[0]!
      .value;
    expect(ctx.state.lastCreateTaxLinesInput!.orderId).toBe(created.id);
  });

  it("zero rate and no local rule → no tax lines are written", async () => {
    const ctx = makeContext({ ...flatFeeOptions, admissionTaxRateBps: 0, taxSitus: TN });
    const result = await buy(ctx);
    expect(result.taxAmountCents).toBe(0);
    expect(ctx.mocks.repos.orders.createTaxLines).not.toHaveBeenCalled();
  });

  it("SALES + a local PLATFORM line: both charged, both persisted, fee grossed up over ALL tax", async () => {
    const ctx = makeContext({
      ...flatFeeOptions,
      admissionTaxRateBps: 1025,
      taxSitus: CHICAGO,
    });

    const result = await withLocalRules([CITY_PLATFORM], () => buy(ctx, 2));

    const lines = ctx.state.lastCreateTaxLinesInput!.lines;
    expect(lines.map((line) => line.code)).toEqual(["SALES", "CHI_AMUSEMENT"]);
    const [salesLine, cityLine] = lines;
    // SALES (IL: face base) on the 5000¢ gross; the city line on the buyer total.
    expect(salesLine).toMatchObject({
      base: "TICKET_FACE",
      taxableAmountCents: 5000,
      amountCents: Math.round((5000 * 1025) / 10_000),
    });
    expect(cityLine).toMatchObject({
      base: "BUYER_TOTAL",
      collector: "PLATFORM",
      taxableAmountCents: 5000 + 100 + result.processorFeeCents,
    });
    expect(cityLine!.amountCents).toBe(
      Math.round(((5000 + 100 + result.processorFeeCents) * 900) / 10_000),
    );

    // THE invariant.
    expect(result.taxAmountCents).toBe(salesLine!.amountCents + cityLine!.amountCents);
    expect(ctx.state.lastCreatePendingInput!.taxAmountCents).toBe(platformSum(ctx));
    // Gross-up over everything the charge must net, including BOTH taxes.
    expect(result.processorFeeCents).toBe(
      solveProcessingFeeGrossUp(5000 + 100 + result.taxAmountCents, 0.029, 30),
    );
    expect(piAmount(ctx)).toBe(
      5000 + 100 + result.taxAmountCents + result.processorFeeCents,
    );
    // Finalize would accept this PaymentIntent (AMOUNT_MISMATCH invariant).
    expect(finalizeExpected(ctx)).toBe(piAmount(ctx));
  });

  it("an ORGANISER line is persisted for disclosure but NOT charged", async () => {
    const baseline = makeContext({
      ...flatFeeOptions,
      admissionTaxRateBps: 1025,
      taxSitus: CHICAGO,
    });
    const baselineResult = await buy(baseline);

    const ctx = makeContext({
      ...flatFeeOptions,
      admissionTaxRateBps: 1025,
      taxSitus: CHICAGO,
    });
    const result = await withLocalRules([CITY_ORGANISER], () => buy(ctx));

    // The buyer's charge is exactly the no-organiser-tax charge.
    expect(result.taxAmountCents).toBe(baselineResult.taxAmountCents);
    expect(result.processorFeeCents).toBe(baselineResult.processorFeeCents);
    expect(piAmount(ctx)).toBe(piAmount(baseline));

    const lines = ctx.state.lastCreateTaxLinesInput!.lines;
    expect(lines).toEqual([
      expect.objectContaining({ code: "SALES", collector: "PLATFORM" }),
      expect.objectContaining({
        code: "VENUE_SEAT",
        collector: "ORGANISER",
        taxableAmountCents: 2500,
        amountCents: 225,
      }),
    ]);
    expect(platformSum(ctx)).toBe(result.taxAmountCents);
    expect(finalizeExpected(ctx)).toBe(piAmount(ctx));
  });
});

describe("createCheckout — a failed fee-waiver statement is not swallowed on the transaction", () => {
  // The reservation runs on the checkout transaction. It used to be wrapped
  // in a catch that "degraded to full price": on Postgres the failed
  // statement had already aborted the transaction, so the next statement
  // raised 25P02 and the checkout failed anyway — blamed on the wrong line.
  // Now the real error propagates and nothing is written or charged.
  it("regression: a failed reservation fails the checkout, caused by ITS error — no order, no PaymentIntent", async () => {
    const ctx = makeContext();
    const boom = new Error("deadlock detected");
    ctx.mocks.repos.feeWaivers.resolveApplicable.mockResolvedValue([
      { id: "waiver-1" },
    ] as never);
    ctx.mocks.repos.feeWaivers.reserve.mockRejectedValue(boom);

    // createCheckout's outer wrapper maps it to `dependency_failed`, with
    // the real error as its cause (what Sentry gets).
    await expect(createCheckout(ctx.deps, ctx.input)).rejects.toMatchObject({
      code: "dependency_failed",
      cause: boom,
    });
    expect(ctx.mocks.repos.orders.createPending).not.toHaveBeenCalled();
    expect(ctx.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
  });

  it("regression: a failed lookup fails it the same way", async () => {
    const ctx = makeContext();
    const boom = new Error("statement timeout");
    ctx.mocks.repos.feeWaivers.resolveApplicable.mockRejectedValue(boom);

    // createCheckout's outer wrapper maps it to `dependency_failed`, with
    // the real error as its cause (what Sentry gets).
    await expect(createCheckout(ctx.deps, ctx.input)).rejects.toMatchObject({
      code: "dependency_failed",
      cause: boom,
    });
    expect(ctx.mocks.repos.orders.createPending).not.toHaveBeenCalled();
    expect(ctx.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
  });
});

describe("createCheckout — returns what the waiver reservation actually got", () => {
  it("regression: feeWaivedCents is the platform fee forgone on THIS order (the page explains the fee with it, not the hold's lines)", async () => {
    const ctx = makeContext();
    ctx.mocks.repos.feeWaivers.resolveApplicable.mockResolvedValue([
      { id: "waiver-1" },
    ] as never);
    ctx.mocks.repos.feeWaivers.reserve.mockResolvedValue({
      reservedTickets: 1,
      feeWaivedCents: 50,
      redemptionId: "redemption-1",
    });

    // Harness default: 2 × $10 at 5% → 50¢ each; one waived.
    const result = await createCheckout(ctx.deps, ctx.input);
    expect(result.feeWaivedCents).toBe(50);
    expect(result.feesPlatformCents).toBe(50);
  });

  it("lost the race (nothing reserved) → 0, with the full fee", async () => {
    const ctx = makeContext();
    ctx.mocks.repos.feeWaivers.resolveApplicable.mockResolvedValue([
      { id: "waiver-1" },
    ] as never);
    ctx.mocks.repos.feeWaivers.reserve.mockResolvedValue({
      reservedTickets: 0,
      feeWaivedCents: 0,
      redemptionId: null,
    });

    const result = await createCheckout(ctx.deps, ctx.input);
    expect(result.feeWaivedCents).toBe(0);
    expect(result.feesPlatformCents).toBe(100);
  });
});

describe("createCheckout — the tax self-heal stamp is written after the commit", () => {
  // Never stamped, inline Edmonton address: the static CA map resolves 5%
  // GST, so the checkout has a stamp to self-heal.
  const EVENT_VERSION = new Date("2024-12-31T08:00:00.000Z");
  const unstamped = (ctx: ReturnType<typeof makeContext>) => {
    const original = ctx.mocks.repos.events.getById.getMockImplementation()!;
    ctx.mocks.repos.events.getById.mockImplementation(async (...args: unknown[]) => {
      const event = await (original as (...a: unknown[]) => Promise<unknown>)(...args);
      return event
        ? {
            ...(event as object),
            admissionTaxRateBps: null,
            postalCode: "T5J 3N9",
            countryCode: "CA",
            region: "AB",
            updatedAt: EVENT_VERSION,
          }
        : null;
    });
  };

  it("regression: written on the NON-transaction repos after the charge commits — never on its transaction", async () => {
    const ctx = makeContext();
    unstamped(ctx);
    await createCheckout(ctx.deps, ctx.input);
    expect(ctx.mocks.txEventsTaxWrite).not.toHaveBeenCalled();
    expect(ctx.mocks.nonTxFillTaxRateIfUnset).toHaveBeenCalledWith({
      eventId: DEFAULT_EVENT_ID,
      admissionTaxRateBps: 500,
      taxRateSource: "ca_gst_hst",
      // Compare-and-set on the event row's version as the checkout read it.
      expectedUpdatedAt: EVENT_VERSION,
    });
  });

  it("regression: a ROLLED-BACK checkout (the PaymentIntent refused, after tax resolved) writes no stamp", async () => {
    const ctx = makeContext();
    unstamped(ctx);
    ctx.mocks.payments.createPaymentIntent.mockRejectedValue(
      new Error("card_declined"),
    );
    await expect(createCheckout(ctx.deps, ctx.input)).rejects.toBeTruthy();
    expect(ctx.mocks.txEventsTaxWrite).not.toHaveBeenCalled();
    expect(ctx.mocks.nonTxFillTaxRateIfUnset).not.toHaveBeenCalled();
  });
});


// ── Pay-what-you-want through the embed guest checkout ──────────────────────
// The embed's item schema had no `donationAmountCents`, so zod stripped it and
// every PWYW line died in `computeOrderAmounts` with `donation_amount_required`.
// The embed delegates to `createCheckout`; these run BOTH real use cases over
// the same harness so "the embed charges what the main checkout charges" is
// measured, not assumed. Rule under test: the buyer's amount IS the ticket
// price; the platform fee, processing and tax go on top.
describe("pay-what-you-want — embed guest checkout prices exactly like createCheckout", () => {
  const MINIMUM_CENTS = 500;
  const EMBED_ID = "88888888-8888-4888-8888-888888888888";

  const makePwywContext = () => {
    const ctx = makeContext({ admissionTaxRateBps: 925 });
    const original = ctx.mocks.repos.events.listTicketTypes.getMockImplementation()!;
    ctx.mocks.repos.events.listTicketTypes.mockImplementation(
      async (eventId: string) =>
        (await original(eventId)).map((tt) => ({
          ...tt,
          priceCents: 0,
          pricingMode: "ADJUSTABLE" as const,
          minimumCents: MINIMUM_CENTS,
        })),
    );
    // What the embed needs on top of the checkout harness: an active
    // organisation embed for the event's org, and the guest resolving to the
    // harness buyer (so both paths price for the same human).
    const repos = ctx.deps.repos as unknown as Record<string, unknown>;
    repos.embeds = {
      getById: vi.fn(async () => ({
        id: EMBED_ID,
        subjectType: "organization",
        subjectId: ctx.defaults.orgId,
        domain: "shop.example.com",
        status: "ACTIVE",
        requireAuth: false,
        linkOut: false,
        defaultView: "list",
        viewToggle: false,
        createdBy: "someone",
        createdAt: new Date("2025-01-01"),
      })),
    };
    Object.assign(ctx.mocks.repos.humans, {
      ensureGuestHuman: vi.fn(async () => ({
        humanId: ctx.defaults.buyerHumanId,
        created: false,
      })),
      update: vi.fn(),
    });
    return ctx;
  };

  const embedInput = (
    ctx: ReturnType<typeof makeContext>,
    donationAmountCents: number | undefined,
  ) => ({
    embedId: EMBED_ID,
    eventId: ctx.defaults.eventId,
    hostOrigin: "https://shop.example.com",
    guestName: "Guest Buyer",
    guestEmail: "guest@example.com",
    clientKey: EMBED_CLIENT_KEY,
    termsAccepted: true,
    refundPolicyAccepted: true,
    items: [
      {
        ticketTypeId: ctx.defaults.ticketTypeId,
        qty: 2,
        ...(donationAmountCents !== undefined ? { donationAmountCents } : {}),
      },
    ],
  });

  const loadEmbed = async () =>
    (await import("../../embeds/create-embed-guest-checkout"))
      .createEmbedGuestCheckout;

  it("regression: an embed PWYW line is priced at the buyer's amount, and charges the same as createCheckout for the same cart", async () => {
    const createEmbedGuestCheckout = await loadEmbed();

    const main = makePwywContext();
    const mainResult = await createCheckout(main.deps, {
      ...main.input,
      items: [
        { ticketTypeId: main.defaults.ticketTypeId, qty: 2, donationAmountCents: 1500 },
      ],
    });

    const embed = makePwywContext();
    const embedResult = await createEmbedGuestCheckout(
      embed.deps,
      embedInput(embed, 1500),
    );

    // The chosen amount IS the ticket price.
    const ticketLine = embed.state.lastCreatePendingInput!.items.find(
      (i) => i.kind === "ticket",
    )!;
    expect(ticketLine.unitPriceCents).toBe(1500);
    expect(embedResult.amountGrossCents).toBe(3000);
    // Fees and tax go on top: the charge is more than the face.
    const embedCharge = (
      embed.mocks.payments.createPaymentIntent.mock.calls[0] as unknown as [
        { amountCents: number },
      ]
    )[0].amountCents;
    expect(embedCharge).toBeGreaterThan(3000);
    expect(embedResult.feesPlatformCents).toBeGreaterThan(0);
    expect(embedResult.taxAmountCents).toBeGreaterThan(0);
    expect(embedCharge).toBe(
      3000 +
        embedResult.buyerFeesCents +
        embedResult.processorFeeCents +
        embedResult.taxAmountCents,
    );

    // Parity: every money field and the PaymentIntent amount are identical.
    const mainCharge = (
      main.mocks.payments.createPaymentIntent.mock.calls[0] as unknown as [
        { amountCents: number },
      ]
    )[0].amountCents;
    expect(embedCharge).toBe(mainCharge);
    for (const field of [
      "amountGrossCents",
      "feesPlatformCents",
      "buyerFeesCents",
      "processorFeeCents",
      "taxAmountCents",
      "feeMode",
    ] as const) {
      expect(embedResult[field]).toBe(mainResult[field]);
    }
    expect(embed.state.lastCreatePendingInput!.items).toEqual(
      main.state.lastCreatePendingInput!.items,
    );

    // The embed's PaymentIntent names its embed (what `releaseEmbedGuestOrder`
    // requires); the main checkout's names none.
    const metadataOf = (ctx: typeof embed) =>
      (
        ctx.mocks.payments.createPaymentIntent.mock.calls[0] as unknown as [
          { metadata: Record<string, string> },
        ]
      )[0].metadata;
    expect(metadataOf(embed).embedId).toBe(EMBED_ID);
    expect(metadataOf(main)).not.toHaveProperty("embedId");
  });

  it("refuses an amount below the tier's minimum, as createCheckout does", async () => {
    const createEmbedGuestCheckout = await loadEmbed();
    const embed = makePwywContext();
    await expect(
      createEmbedGuestCheckout(embed.deps, embedInput(embed, MINIMUM_CENTS - 1)),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: "donation_below_minimum",
    });
    expect(embed.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
  });

  it("refuses an amount above the $10,000 cap at the embed's own boundary", async () => {
    const createEmbedGuestCheckout = await loadEmbed();
    const embed = makePwywContext();
    await expect(
      createEmbedGuestCheckout(embed.deps, embedInput(embed, 1_000_001)),
    ).rejects.toMatchObject({ code: "invalid_input", message: "invalid_input" });
    // Refused before any guest account or Stripe work.
    expect(embed.mocks.repos.humans.ensureGuestHuman).not.toHaveBeenCalled();
    expect(embed.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
  });

  it("still refuses a PWYW line with no amount (donation_amount_required)", async () => {
    const createEmbedGuestCheckout = await loadEmbed();
    const embed = makePwywContext();
    await expect(
      createEmbedGuestCheckout(embed.deps, embedInput(embed, undefined)),
    ).rejects.toMatchObject({ message: "donation_amount_required" });
  });

  // ── One tier named twice at different amounts ────────────────────────────
  // `aggregateItems` merges same-tier lines and keeps one amount, so it used to
  // charge the FIRST line's amount for every ticket (2500 + 1000 billed as
  // 2 x 2500 = 5000). Such a cart is now refused before anything is written.
  it("refuses a cart naming one PWYW tier twice at different amounts, and persists nothing", async () => {
    const ctx = makePwywContext();
    await expect(
      createCheckout(ctx.deps, {
        ...ctx.input,
        items: [
          { ticketTypeId: ctx.defaults.ticketTypeId, qty: 1, donationAmountCents: 2500 },
          { ticketTypeId: ctx.defaults.ticketTypeId, qty: 1, donationAmountCents: 1000 },
        ],
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      meta: { ticketTypeId: ctx.defaults.ticketTypeId },
    });

    expect(ctx.mocks.repos.orders.createPending).not.toHaveBeenCalled();
    expect(ctx.mocks.repos.seats.reserveForHold).not.toHaveBeenCalled();
    expect(ctx.mocks.repos.seats.updateStatuses).not.toHaveBeenCalled();
    expect(ctx.mocks.repos.audit.log).not.toHaveBeenCalled();
    expect(ctx.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
    // The claim is released (not `fail`ed), so the corrected cart can go
    // through; nothing was committed to replay.
    expect(ctx.mocks.idempotency.commit).not.toHaveBeenCalled();
    expect(ctx.mocks.idempotency.release).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.idempotency.fail).not.toHaveBeenCalled();
  });

  it("refuses one tier named with an amount on one line and none on another", async () => {
    const ctx = makePwywContext();
    await expect(
      createCheckout(ctx.deps, {
        ...ctx.input,
        items: [
          { ticketTypeId: ctx.defaults.ticketTypeId, qty: 1, donationAmountCents: 2500 },
          { ticketTypeId: ctx.defaults.ticketTypeId, qty: 1 },
        ],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(ctx.mocks.repos.orders.createPending).not.toHaveBeenCalled();
    expect(ctx.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
  });

  it("still merges one PWYW tier named twice at the SAME amount, priced as one line", async () => {
    const split = makePwywContext();
    const splitResult = await createCheckout(split.deps, {
      ...split.input,
      items: [
        { ticketTypeId: split.defaults.ticketTypeId, qty: 1, donationAmountCents: 2500 },
        { ticketTypeId: split.defaults.ticketTypeId, qty: 1, donationAmountCents: 2500 },
      ],
    });
    const single = makePwywContext();
    const singleResult = await createCheckout(single.deps, {
      ...single.input,
      items: [
        { ticketTypeId: single.defaults.ticketTypeId, qty: 2, donationAmountCents: 2500 },
      ],
    });

    expect(splitResult.amountGrossCents).toBe(5000);
    expect(splitResult.amountGrossCents).toBe(singleResult.amountGrossCents);
    expect(split.state.lastCreatePendingInput!.items).toEqual(
      single.state.lastCreatePendingInput!.items,
    );
  });

  it("the embed refuses the two-amount cart before creating a guest account", async () => {
    const createEmbedGuestCheckout = await loadEmbed();
    const embed = makePwywContext();
    await expect(
      createEmbedGuestCheckout(embed.deps, {
        ...embedInput(embed, undefined),
        items: [
          { ticketTypeId: embed.defaults.ticketTypeId, qty: 1, donationAmountCents: 2500 },
          { ticketTypeId: embed.defaults.ticketTypeId, qty: 1, donationAmountCents: 1000 },
        ],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(embed.mocks.repos.humans.ensureGuestHuman).not.toHaveBeenCalled();
    expect(embed.mocks.repos.orders.createPending).not.toHaveBeenCalled();
    expect(embed.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
  });
});

// ── The embed confirmation's lines come from the PERSISTED order ────────────
// The embed widget's post-purchase summary used to rebuild its ticket lines
// from the client cart. `createEmbedGuestCheckout` now returns `lineItems`
// read back from the order `createCheckout` persisted; these run both real
// use cases over the checkout harness so the lines are the server's pricing,
// and Σ lineCents − discount = amountGrossCents is measured, not assumed.
describe("embed guest checkout — lineItems are the persisted order's lines", () => {
  const EMBED_ID = "99999999-9999-4999-8999-999999999999";
  const TIER_NAME = "General Admission";

  const makeEmbedContext = (options: MakeContextOptions = {}) => {
    const ctx = makeContext(options);
    const original = ctx.mocks.repos.events.listTicketTypes.getMockImplementation()!;
    ctx.mocks.repos.events.listTicketTypes.mockImplementation(
      async (eventId: string) =>
        (await original(eventId)).map((tt) => ({ ...tt, name: TIER_NAME })),
    );
    const repos = ctx.deps.repos as unknown as Record<string, unknown>;
    repos.embeds = {
      getById: vi.fn(async () => ({
        id: EMBED_ID,
        subjectType: "organization",
        subjectId: ctx.defaults.orgId,
        domain: "shop.example.com",
        status: "ACTIVE",
        requireAuth: false,
        linkOut: false,
        defaultView: "list",
        viewToggle: false,
        createdBy: "someone",
        createdAt: new Date("2025-01-01"),
      })),
    };
    Object.assign(ctx.mocks.repos.humans, {
      ensureGuestHuman: vi.fn(async () => ({
        humanId: ctx.defaults.buyerHumanId,
        created: false,
      })),
      update: vi.fn(),
    });
    return ctx;
  };

  const embedInput = (
    ctx: ReturnType<typeof makeContext>,
    items: Array<Record<string, unknown>>,
    extra: Record<string, unknown> = {},
  ) => ({
    embedId: EMBED_ID,
    eventId: ctx.defaults.eventId,
    hostOrigin: "https://shop.example.com",
    guestName: "Guest Buyer",
    guestEmail: "guest@example.com",
    clientKey: EMBED_CLIENT_KEY,
    termsAccepted: true,
    refundPolicyAccepted: true,
    items,
    ...extra,
  });

  const loadEmbed = async () =>
    (await import("../../embeds/create-embed-guest-checkout"))
      .createEmbedGuestCheckout;

  const sumLines = (lines: Array<{ lineCents: number }>) =>
    lines.reduce((sum, line) => sum + line.lineCents, 0);

  it("a fixed tier at qty 2: one line at face × qty, summing to amountGrossCents", async () => {
    const createEmbedGuestCheckout = await loadEmbed();
    const ctx = makeEmbedContext({ ticketPriceCents: 1000 });
    const result = await createEmbedGuestCheckout(
      ctx.deps,
      embedInput(ctx, [{ ticketTypeId: ctx.defaults.ticketTypeId, qty: 2 }]),
    );

    expect(result.lineItems).toEqual([
      {
        ticketTypeId: ctx.defaults.ticketTypeId,
        name: TIER_NAME,
        qty: 2,
        unitPriceCents: 1000,
        lineCents: 2000,
      },
    ]);
    // No promo: the lines ARE the gross.
    expect(sumLines(result.lineItems)).toBe(result.amountGrossCents);
    // The persisted order carries one qty-1 item per ticket; the line folds them.
    expect(
      ctx.state.lastCreatePendingInput!.items.filter((i) => i.kind === "ticket"),
    ).toHaveLength(2);
  });

  it("a pay-what-you-want tier: the line is at the buyer's chosen amount, as createCheckout priced it", async () => {
    const createEmbedGuestCheckout = await loadEmbed();
    const ctx = makeEmbedContext({ admissionTaxRateBps: 925 });
    const original = ctx.mocks.repos.events.listTicketTypes.getMockImplementation()!;
    ctx.mocks.repos.events.listTicketTypes.mockImplementation(
      async (eventId: string) =>
        (await original(eventId)).map((tt) => ({
          ...tt,
          priceCents: 0,
          pricingMode: "ADJUSTABLE" as const,
          minimumCents: 500,
        })),
    );

    const result = await createEmbedGuestCheckout(
      ctx.deps,
      embedInput(ctx, [
        {
          ticketTypeId: ctx.defaults.ticketTypeId,
          qty: 3,
          donationAmountCents: 1500,
        },
      ]),
    );

    expect(result.lineItems).toEqual([
      {
        ticketTypeId: ctx.defaults.ticketTypeId,
        name: TIER_NAME,
        qty: 3,
        unitPriceCents: 1500,
        lineCents: 4500,
      },
    ]);
    expect(result.amountGrossCents).toBe(4500);
    expect(sumLines(result.lineItems)).toBe(result.amountGrossCents);
  });

  it("a cart naming one PWYW tier twice at the same amount prints one merged line", async () => {
    // Two DIFFERENT amounts for one tier are refused (see the pay-what-you-want
    // describe above); the same amount repeated merges into one line.
    const createEmbedGuestCheckout = await loadEmbed();
    const ctx = makeEmbedContext();
    const original = ctx.mocks.repos.events.listTicketTypes.getMockImplementation()!;
    ctx.mocks.repos.events.listTicketTypes.mockImplementation(
      async (eventId: string) =>
        (await original(eventId)).map((tt) => ({
          ...tt,
          priceCents: 0,
          pricingMode: "ADJUSTABLE" as const,
          minimumCents: 500,
        })),
    );

    const result = await createEmbedGuestCheckout(
      ctx.deps,
      embedInput(ctx, [
        { ticketTypeId: ctx.defaults.ticketTypeId, qty: 1, donationAmountCents: 2500 },
        { ticketTypeId: ctx.defaults.ticketTypeId, qty: 1, donationAmountCents: 2500 },
      ]),
    );

    expect(result.amountGrossCents).toBe(5000);
    expect(result.lineItems).toEqual([
      {
        ticketTypeId: ctx.defaults.ticketTypeId,
        name: TIER_NAME,
        qty: 2,
        unitPriceCents: 2500,
        lineCents: 5000,
      },
    ]);
    expect(sumLines(result.lineItems)).toBe(result.amountGrossCents);
  });

  it("with a promo: lines stay at the pre-discount face; Σ lines − amountGrossCents = the discount", async () => {
    const createEmbedGuestCheckout = await loadEmbed();
    const ctx = makeEmbedContext({ ticketPriceCents: 1000 });
    const promo: PromoRecord = {
      id: "promo-embed-lines",
      code: "SAVE5",
      codeNormalized: "SAVE5",
      status: "ACTIVE",
      kind: "AMOUNT",
      scope: "EVENT",
      scopeId: ctx.defaults.eventId,
      value: 500,
      currency: "usd",
      minOrderCents: 0,
      maxRedemptions: undefined,
      maxRedemptionsPerHuman: undefined,
      maxDiscountCents: undefined,
      stackable: false,
      isPublic: false,
      startsAt: undefined,
      endsAt: undefined,
      createdAt: ctx.defaults.now,
      updatedAt: ctx.defaults.now,
    };
    ctx.mocks.repos.promos.findActiveByCodes.mockResolvedValue([promo]);
    ctx.mocks.repos.promos.getRedemptionStats.mockResolvedValue({
      totalRedemptions: 0,
      redemptionsForHuman: 0,
    });

    const result = await createEmbedGuestCheckout(
      ctx.deps,
      embedInput(
        ctx,
        [{ ticketTypeId: ctx.defaults.ticketTypeId, qty: 2 }],
        { promoCodes: ["save5"] },
      ),
    );

    expect(result.amountGrossCents).toBe(1500);
    expect(result.lineItems).toEqual([
      {
        ticketTypeId: ctx.defaults.ticketTypeId,
        name: TIER_NAME,
        qty: 2,
        unitPriceCents: 1000,
        lineCents: 2000,
      },
    ]);
    expect(sumLines(result.lineItems) - result.amountGrossCents).toBe(500);
  });

  it("a seated order: the per-seat items collapse into one line per ticket type and price", async () => {
    const createEmbedGuestCheckout = await loadEmbed();
    const ctx = makeEmbedContext();
    const seatSectionId = "section-embed-lines";
    const original = ctx.mocks.repos.events.listTicketTypes.getMockImplementation()!;
    ctx.mocks.repos.events.listTicketTypes.mockImplementation(
      async (eventId: string) =>
        (await original(eventId)).map((tt) => ({ ...tt, seatSectionId })),
    );
    const seatA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const seatB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    for (const [i, seatId] of [seatA, seatB].entries()) {
      ctx.state.seats.set(seatId, {
        eventId: ctx.defaults.eventId,
        seatSectionId,
        status: "AVAILABLE",
        label: `A${i + 1}`,
        row: "A",
        number: i + 1,
      });
    }

    const result = await createEmbedGuestCheckout(
      ctx.deps,
      embedInput(ctx, [
        {
          ticketTypeId: ctx.defaults.ticketTypeId,
          qty: 2,
          seatIds: [seatA, seatB],
        },
      ]),
    );

    expect(result.lineItems).toEqual([
      {
        ticketTypeId: ctx.defaults.ticketTypeId,
        name: TIER_NAME,
        qty: 2,
        unitPriceCents: 1000,
        lineCents: 2000,
      },
    ]);
    expect(sumLines(result.lineItems)).toBe(result.amountGrossCents);
  });

  it("an idempotent replay (createCheckout serves its stored result) returns the same lines, read from the order", async () => {
    const createEmbedGuestCheckout = await loadEmbed();
    const ctx = makeEmbedContext({ ticketPriceCents: 1000 });
    const input = embedInput(ctx, [
      { ticketTypeId: ctx.defaults.ticketTypeId, qty: 2 },
    ]);

    const first = await createEmbedGuestCheckout(ctx.deps, input);
    const replay = await createEmbedGuestCheckout(ctx.deps, input);

    // The second call never re-prices: one order, one PaymentIntent.
    expect(ctx.mocks.repos.orders.createPending).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.payments.createPaymentIntent).toHaveBeenCalledTimes(1);
    expect(replay.orderId).toBe(first.orderId);
    expect(replay.lineItems).toEqual(first.lineItems);
    expect(sumLines(replay.lineItems)).toBe(replay.amountGrossCents);
  });

  it("a 100%-off promo (the FREE path, claimFreeTickets): lines at face, Σ lines − amountGrossCents = the discount", async () => {
    const createEmbedGuestCheckout = await loadEmbed();
    const ctx = makeEmbedContext({ ticketPriceCents: 1000 });
    ctx.mocks.repos.promos.findActiveByCodes.mockResolvedValue([
      {
        id: "promo-embed-free",
        code: "FREE",
        codeNormalized: "FREE",
        status: "ACTIVE",
        kind: "AMOUNT",
        scope: "EVENT",
        scopeId: ctx.defaults.eventId,
        value: 100_000,
        currency: "usd",
        minOrderCents: 0,
        maxRedemptions: undefined,
        maxRedemptionsPerHuman: undefined,
        maxDiscountCents: undefined,
        stackable: false,
        isPublic: false,
        startsAt: undefined,
        endsAt: undefined,
        createdAt: ctx.defaults.now,
        updatedAt: ctx.defaults.now,
      } satisfies PromoRecord,
    ]);
    ctx.mocks.repos.promos.getRedemptionStats.mockResolvedValue({
      totalRedemptions: 0,
      redemptionsForHuman: 0,
    });
    const reportError = vi.fn();
    (ctx.deps as { reportError?: unknown }).reportError = reportError;
    // The harness has no ticket store: answer the order's tickets from what
    // mint actually created through `tickets.create`.
    const ticketsRepo = ctx.mocks.repos.tickets as unknown as {
      create: { mock: { results: Array<{ value: Promise<{ orderId: string | null; code: string }> }> } };
      listByOrderId?: unknown;
    };
    ticketsRepo.listByOrderId = vi.fn(async (orderId: string) =>
      (
        await Promise.all(ticketsRepo.create.mock.results.map((r) => r.value))
      ).filter((t) => t.orderId === orderId),
    );

    const result = await createEmbedGuestCheckout(
      ctx.deps,
      embedInput(
        ctx,
        [{ ticketTypeId: ctx.defaults.ticketTypeId, qty: 2 }],
        // Codes ride a free claim's answer only for the current widget's
        // `crypto.randomUUID()` key.
        { promoCodes: ["free"], clientKey: "3f2b8c1e-7a4d-4e9b-9c1f-2d6a5b8e7f10" },
      ),
    );

    // A free claim mints inside its own transaction, so both tickets exist
    // when the call returns and the answer carries their codes.
    const mintedCodes = (
      await Promise.all(ticketsRepo.create.mock.results.map((r) => r.value))
    ).map((t) => t.code);
    expect(mintedCodes).toHaveLength(2);
    expect(result.tickets.map((t) => t.code).sort()).toEqual(
      [...mintedCodes].sort(),
    );
    expect(result.tickets.every((t) => t.ticketTypeName === TIER_NAME)).toBe(
      true,
    );

    // Completed inline: no PaymentIntent.
    expect(result.clientSecret).toBeNull();
    expect(ctx.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
    expect(result.amountGrossCents).toBe(0);
    expect(result.lineItems).toEqual([
      {
        ticketTypeId: ctx.defaults.ticketTypeId,
        name: TIER_NAME,
        qty: 2,
        unitPriceCents: 1000,
        lineCents: 2000,
      },
    ]);
    expect(sumLines(result.lineItems) - result.amountGrossCents).toBe(2000);
    // The read-back succeeded: nothing degraded, nothing reported.
    expect(reportError).not.toHaveBeenCalled();
  });

  // Owner ruling 2026-10-03: an embed guest NEVER spends the account's
  // platform credit — it pays full price; credit is for the signed-in main
  // checkout. `createEmbedGuestCheckout` passes `applyPlatformCredit: false`.
  it.each([
    ["a partial credit", {}, 500],
    ["a credit that would cover the whole charge", ZERO_FEE_POLICY, 2000],
  ] as const)(
    "regression: with %s on the guest's account, the embed applies NONE of it — full charge, no platform_credit item",
    async (_label, policy, creditCents) => {
      const createEmbedGuestCheckout = await loadEmbed();
      const ctx = makeEmbedContext({
        ...policy,
        ticketPriceCents: 1000,
        activeCredits: [{ id: "credit-embed", balanceCents: creditCents }],
      });

      const result = await createEmbedGuestCheckout(
        ctx.deps,
        embedInput(ctx, [{ ticketTypeId: ctx.defaults.ticketTypeId, qty: 2 }]),
      );

      // No credit item persisted, none redeemed, the balance untouched.
      expect(
        ctx.state.lastCreatePendingInput!.items.some(
          (i) => i.kind === "platform_credit",
        ),
      ).toBe(false);
      expect(ctx.state.redeemConditionalMock).not.toHaveBeenCalled();
      expect(ctx.state.creditStore.get("credit-embed")?.balanceCents).toBe(
        creditCents,
      );
      // On the wire (createCheckout's result is spread through), though the
      // embed's declared output type does not name it.
      expect((result as { creditAppliedCents?: number }).creditAppliedCents).toBe(0);
      // A real PaymentIntent for the FULL chargeable amount — never
      // credit-covered.
      expect(result.clientSecret).not.toBeNull();
      expect(ctx.mocks.payments.createPaymentIntent).toHaveBeenCalledTimes(1);
      const charged = (
        ctx.mocks.payments.createPaymentIntent.mock.calls[0] as unknown as [
          { amountCents: number },
        ]
      )[0].amountCents;
      expect(charged).toBe(
        result.amountGrossCents +
          result.buyerFeesCents +
          result.processorFeeCents +
          result.taxAmountCents,
      );
      // The lines are the full face and sum to the gross.
      expect(result.amountGrossCents).toBe(2000);
      expect(result.lineItems).toEqual([
        {
          ticketTypeId: ctx.defaults.ticketTypeId,
          name: TIER_NAME,
          qty: 2,
          unitPriceCents: 1000,
          lineCents: 2000,
        },
      ]);
    },
  );

  it("the main checkout (applyPlatformCredit defaulted) still applies the same credit", async () => {
    const ctx = makeContext({
      ticketPriceCents: 1000,
      activeCredits: [{ id: "credit-main", balanceCents: 500 }],
    });

    const result = await createCheckout(ctx.deps, ctx.input);

    expect(result.creditAppliedCents).toBe(500);
    expect(
      ctx.state.lastCreatePendingInput!.items.find(
        (i) => i.kind === "platform_credit",
      ),
    ).toMatchObject({ amountCents: -500 });
    expect(ctx.state.creditStore.get("credit-main")?.balanceCents).toBe(0);
    const charged = (
      ctx.mocks.payments.createPaymentIntent.mock.calls[0] as unknown as [
        { amountCents: number },
      ]
    )[0].amountCents;
    expect(charged).toBe(
      result.amountGrossCents +
        result.buyerFeesCents +
        result.processorFeeCents +
        result.taxAmountCents -
        500,
    );
  });

  it("refuses (INTERNAL) when the persisted items cannot reproduce amountGrossCents — never a guessed line", async () => {
    const createEmbedGuestCheckout = await loadEmbed();
    const ctx = makeEmbedContext({ ticketPriceCents: 1000 });
    const original = ctx.mocks.repos.orders.getById.getMockImplementation()!;
    ctx.mocks.repos.orders.getById.mockImplementation(async (id: string) => {
      const order = await original(id);
      // A ticket item drifted from what the order's gross was stamped from.
      return order
        ? {
            ...order,
            items: order.items.map((item, i) =>
              i === 0 ? { ...item, unitPriceCents: 900, amountCents: 900 } : item,
            ),
          }
        : null;
    });

    await expect(
      createEmbedGuestCheckout(
        ctx.deps,
        embedInput(ctx, [{ ticketTypeId: ctx.defaults.ticketTypeId, qty: 2 }]),
      ),
    ).rejects.toMatchObject({ code: "INTERNAL" });
  });
});

// ── The tax-provider lookup runs BEFORE the charge transaction ──────────────
// `prepareCheckoutTax` does the ZipTax round trip (live HTTP, up to 5s on a
// cache miss) before `repos.tx` opens; inside, only the prepared result is
// used. It used to run inside, holding the charge's row locks.
describe("createCheckout — the tax-provider lookup is outside the transaction", () => {
  // Measured on the pre-change code (lookup inside the transaction). The
  // same rate on the same cart must charge the same cents.
  // 2 × $40 face + 2 × 200¢ platform fee + 308¢ processing gross-up + 849¢
  // tax (9.75% on the TN buyer total, 8708¢) = 9557¢.
  const PINNED_CHARGE = {
    piAmountCents: 9557,
    amountGrossCents: 8000,
    feesPlatformCents: 400,
    buyerFeesCents: 400,
    processorFeeCents: 308,
    taxAmountCents: 849,
    pendingTaxAmountCents: 849,
    taxLines: {
      orderId: DEFAULT_ORDER_ID,
      lines: [
        {
          amountCents: 849,
          base: "BUYER_TOTAL",
          code: "SALES",
          collector: "PLATFORM",
          jurisdiction: "US/TN",
          label: "Sales tax",
          rateBps: 975,
          taxableAmountCents: 8708,
        },
      ],
    },
  };

  // Never stamped, inline Nashville: only the provider can price it.
  const unstampedNashville = (ctx: ReturnType<typeof makeContext>) => {
    const original = ctx.mocks.repos.events.getById.getMockImplementation()!;
    ctx.mocks.repos.events.getById.mockImplementation(
      async (...args: unknown[]) => {
        const event = await (original as (...a: unknown[]) => Promise<unknown>)(
          ...args,
        );
        return event
          ? {
              ...(event as object),
              admissionTaxRateBps: null,
              postalCode: "37203",
              countryCode: "US",
              region: "TN",
              updatedAt: new Date("2024-12-31T08:00:00.000Z"),
            }
          : null;
      },
    );
  };

  const trackTx = (ctx: ReturnType<typeof makeContext>) => {
    const state = { inTx: false };
    const repos = ctx.deps.repos as unknown as {
      tx: (fn: unknown, opts?: unknown) => Promise<unknown>;
    };
    const original = repos.tx;
    repos.tx = async (fn, opts) => {
      state.inTx = true;
      try {
        return await original(fn, opts);
      } finally {
        state.inTx = false;
      }
    };
    return state;
  };

  it("regression: the provider is called once, BEFORE the charge transaction opens — never inside it", async () => {
    const ctx = makeContext({ ticketPriceCents: 4000 });
    unstampedNashville(ctx);
    const tx = trackTx(ctx);
    const calledInsideTx: boolean[] = [];
    const lookupByPostalCode = vi.fn(async () => {
      calledInsideTx.push(tx.inTx);
      if (tx.inTx) throw new Error("tax provider called INSIDE the transaction");
      return { rateBps: 975, source: "ziptax" };
    });

    const result = await createCheckout(
      { ...ctx.deps, taxRateLookup: { lookupByPostalCode } },
      ctx.input,
    );

    expect(lookupByPostalCode).toHaveBeenCalledTimes(1);
    expect(calledInsideTx).toEqual([false]);
    // The prepared rate was the one charged — not a swallowed provider
    // failure priced at 0.
    expect(result.taxAmountCents).toBeGreaterThan(0);
  });

  it("parity: the charge from a provider-priced (unstamped) event is byte-identical to before the move", async () => {
    const ctx = makeContext({ ticketPriceCents: 4000 });
    unstampedNashville(ctx);
    const lookupByPostalCode = vi.fn(async () => ({
      rateBps: 975,
      source: "ziptax",
    }));

    const result = await createCheckout(
      { ...ctx.deps, taxRateLookup: { lookupByPostalCode } },
      ctx.input,
    );
    const pi = (
      ctx.mocks.payments.createPaymentIntent.mock.calls[0] as unknown as [
        { amountCents: number },
      ]
    )[0];

    expect({
      piAmountCents: pi.amountCents,
      amountGrossCents: result.amountGrossCents,
      feesPlatformCents: result.feesPlatformCents,
      buyerFeesCents: result.buyerFeesCents,
      processorFeeCents: result.processorFeeCents,
      taxAmountCents: result.taxAmountCents,
      pendingTaxAmountCents: ctx.state.lastCreatePendingInput!.taxAmountCents,
      taxLines: ctx.state.lastCreateTaxLinesInput,
    }).toEqual(PINNED_CHARGE);
  });
});

// ── The embed guest checkout charges the provider's tax, like createCheckout ─
// `createEmbedGuestCheckout` hands its deps whole to `createCheckout`, but its
// deps type (and the embeds router) never carried `taxRateLookup`, so on an
// event never stamped at publish time with no cached place rate the embed buyer
// was charged $0 tax where the main checkout charged the provider's rate. The
// router wiring is pinned in routers/__tests__/embeds.test.ts; this pins that
// the same cart on the same unstamped, uncached place charges the same cents.
describe("createEmbedGuestCheckout — tax parity with createCheckout on an unstamped event at an uncached place", () => {
  const EMBED_ID = "88888888-8888-4888-8888-888888888888";
  const PLACE_ID = "99999999-9999-4999-8999-999999999999";

  const makeUnstampedPlaceContext = () => {
    const ctx = makeContext({ ticketPriceCents: 4000 });
    // Never stamped; its location is a Place with NO cached rate.
    const original = ctx.mocks.repos.events.getById.getMockImplementation()!;
    ctx.mocks.repos.events.getById.mockImplementation(
      async (...args: unknown[]) => {
        const event = await (original as (...a: unknown[]) => Promise<unknown>)(
          ...args,
        );
        return event
          ? {
              ...(event as object),
              admissionTaxRateBps: null,
              taxRateSource: null,
              placeId: PLACE_ID,
              savedLocationId: null,
              postalCode: null,
              countryCode: null,
              region: null,
              updatedAt: new Date("2024-12-31T08:00:00.000Z"),
            }
          : null;
      },
    );
    const places = {
      getById: vi.fn(async () => ({
        id: PLACE_ID,
        admissionTaxRateBps: null,
        taxRateSource: null,
        postalCode: "37203",
        countryCode: "US",
        region: "TN",
      })),
      fillTaxRateIfUnset: vi.fn(async () => true),
    };
    const repos = ctx.deps.repos as unknown as {
      places: unknown;
      embeds: unknown;
      tx: (fn: (tx: Record<string, unknown>) => unknown, o?: unknown) => unknown;
    };
    repos.places = places;
    const originalTx = repos.tx;
    repos.tx = (fn, opts) =>
      originalTx((tx: Record<string, unknown>) => fn({ ...tx, places }), opts);
    repos.embeds = {
      getById: vi.fn(async () => ({
        id: EMBED_ID,
        subjectType: "organization",
        subjectId: ctx.defaults.orgId,
        domain: "shop.example.com",
        status: "ACTIVE",
        requireAuth: false,
        linkOut: false,
        defaultView: "list",
        viewToggle: false,
        createdBy: "someone",
        createdAt: new Date("2025-01-01"),
      })),
    };
    Object.assign(ctx.mocks.repos.humans, {
      ensureGuestHuman: vi.fn(async () => ({
        humanId: ctx.defaults.buyerHumanId,
        created: false,
      })),
      update: vi.fn(),
    });
    return ctx;
  };

  const piAmount = (ctx: ReturnType<typeof makeContext>) =>
    (
      ctx.mocks.payments.createPaymentIntent.mock.calls[0] as unknown as [
        { amountCents: number },
      ]
    )[0].amountCents;

  it("regression: the embed charges the same provider-priced tax as the main checkout for the same cart", async () => {
    const { createEmbedGuestCheckout } = await import(
      "../../embeds/create-embed-guest-checkout"
    );
    const lookup = () => ({
      lookupByPostalCode: vi.fn(async () => ({
        rateBps: 975,
        source: "ziptax",
      })),
    });

    const main = makeUnstampedPlaceContext();
    const mainLookup = lookup();
    const mainResult = await createCheckout(
      { ...main.deps, taxRateLookup: mainLookup },
      main.input,
    );

    const embed = makeUnstampedPlaceContext();
    const embedLookup = lookup();
    const embedResult = await createEmbedGuestCheckout(
      { ...embed.deps, taxRateLookup: embedLookup },
      {
        embedId: EMBED_ID,
        eventId: embed.defaults.eventId,
        hostOrigin: "https://shop.example.com",
        guestName: "Guest Buyer",
        guestEmail: "guest@example.com",
        clientKey: EMBED_CLIENT_KEY,
        termsAccepted: true,
        refundPolicyAccepted: true,
        items: [{ ticketTypeId: embed.defaults.ticketTypeId, qty: 2 }],
      },
    );

    // The provider priced both; neither fell back to $0.
    expect(mainLookup.lookupByPostalCode).toHaveBeenCalledTimes(1);
    expect(embedLookup.lookupByPostalCode).toHaveBeenCalledTimes(1);
    expect(mainResult.taxAmountCents).toBe(849);
    expect(embedResult.taxAmountCents).toBe(mainResult.taxAmountCents);
    expect(piAmount(embed)).toBe(piAmount(main));
    expect(piAmount(embed)).toBe(9557);
  });
});

// ── A refused checkout does not pay for a tax-provider lookup ───────────────
describe("createCheckout — refused attempts make no tax-provider call", () => {
  const unstampedNashvilleWith = (
    ctx: ReturnType<typeof makeContext>,
    extra: Record<string, unknown> = {},
  ) => {
    const original = ctx.mocks.repos.events.getById.getMockImplementation()!;
    ctx.mocks.repos.events.getById.mockImplementation(
      async (...args: unknown[]) => {
        const event = await (original as (...a: unknown[]) => Promise<unknown>)(
          ...args,
        );
        return event
          ? {
              ...(event as object),
              admissionTaxRateBps: null,
              postalCode: "37203",
              countryCode: "US",
              region: "TN",
              updatedAt: new Date("2024-12-31T08:00:00.000Z"),
              ...extra,
            }
          : null;
      },
    );
  };
  const provider = () =>
    vi.fn(async () => ({ rateBps: 975, source: "ziptax" }));

  it("an event whose sales have closed is refused (EVENT_SALES_CLOSED) with NO provider call", async () => {
    const ctx = makeContext({ ticketPriceCents: 4000 });
    unstampedNashvilleWith(ctx, {
      startsAt: new Date("2024-12-30T19:00:00.000Z"),
      endsAt: new Date("2024-12-30T23:00:00.000Z"),
    });
    const lookupByPostalCode = provider();
    await expect(
      createCheckout(
        { ...ctx.deps, taxRateLookup: { lookupByPostalCode } },
        ctx.input,
      ),
    ).rejects.toMatchObject({ code: "EVENT_SALES_CLOSED" });
    expect(lookupByPostalCode).not.toHaveBeenCalled();
  });
});

// ── A read without a row version disables the self-heal LOUDLY ──────────────
// The stamp is a compare-and-set on `Event.updatedAt`; with no version there is
// no safe write, so no stamp, and every later checkout pays for the provider
// again. That used to be an `info` line nothing captures.
describe("createCheckout — a missing Event.updatedAt reports instead of silently disabling the self-heal", () => {
  const unstampedWithoutVersion = (ctx: ReturnType<typeof makeContext>) => {
    const original = ctx.mocks.repos.events.getById.getMockImplementation()!;
    ctx.mocks.repos.events.getById.mockImplementation(
      async (...args: unknown[]) => {
        const event = await (original as (...a: unknown[]) => Promise<unknown>)(
          ...args,
        );
        return event
          ? {
              ...(event as object),
              admissionTaxRateBps: null,
              postalCode: "T5J 3N9",
              countryCode: "CA",
              region: "AB",
              updatedAt: undefined,
            }
          : null;
      },
    );
  };

  it("regression: reports to Sentry (guarded), logs at error, writes no stamp, and still charges the resolved rate", async () => {
    const ctx = makeContext();
    unstampedWithoutVersion(ctx);
    const reportError = vi.fn();

    const result = await createCheckout(
      { ...ctx.deps, reportError },
      ctx.input,
    );

    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("updatedAt"),
      }),
      expect.objectContaining({
        tags: { useCase: "resolveCheckoutTax" },
        extra: expect.objectContaining({
          eventId: DEFAULT_EVENT_ID,
          event: "tax_rate_backfill_skipped_no_row_version",
        }),
      }),
    );
    expect(ctx.mocks.logger.error).toHaveBeenCalledWith(
      "tax_rate_backfill_skipped_no_row_version",
      expect.objectContaining({ eventId: DEFAULT_EVENT_ID }),
    );
    expect(ctx.mocks.nonTxFillTaxRateIfUnset).not.toHaveBeenCalled();
    // The order itself is unaffected: the Canadian 5% GST is still charged.
    expect(result.taxAmountCents).toBeGreaterThan(0);
  });

  it("a throwing reporter changes nothing about the checkout", async () => {
    const ctx = makeContext();
    unstampedWithoutVersion(ctx);
    const reportError = vi.fn(() => {
      throw new Error("sentry down");
    });
    const result = await createCheckout(
      { ...ctx.deps, reportError },
      ctx.input,
    );
    expect(reportError).toHaveBeenCalled();
    expect(result.taxAmountCents).toBeGreaterThan(0);
  });
});

describe("createCheckout — no payment-processor call while a transaction is open", () => {
  // A slow Stripe call inside the checkout transaction outlived its 30s
  // budget ("expired transaction" at linkPaymentIntent) while holding the
  // capacity lock, seat holds and credit/fee-waiver row locks. The order now
  // commits first; the PaymentIntent is created and linked afterwards, and a
  // failure in between hands back everything the transaction took.
  const CART_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const SEAT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

  const withSeatedTier = (ctx: ReturnType<typeof makeContext>) => {
    const seatSectionId = "section-paid";
    ctx.mocks.repos.events.listTicketTypes.mockResolvedValue([
      {
        id: ctx.defaults.ticketTypeId,
        priceCents: 1000,
        status: "ACTIVE" as const,
        capacity: 10,
        seatSectionId,
        resaleAllowed: false,
        resaleCapCents: null,
        transferAllowed: true,
        scheduledPriceCents: null,
        scheduledPriceAt: null,
        salesOpenAt: null,
        salesCloseAt: null,
      },
    ]);
    ctx.state.seats.set(SEAT_ID, {
      eventId: ctx.defaults.eventId,
      seatSectionId,
      status: "AVAILABLE",
      label: "B1",
      row: "B",
      number: 1,
    });
  };

  // Records whether each audit row was written inside a transaction.
  const trackAuditTx = (ctx: ReturnType<typeof makeContext>) => {
    const rows: Array<{ action: string; inTx: boolean }> = [];
    ctx.mocks.repos.audit.log.mockImplementation((async (entry: {
      action: string;
    }) => {
      rows.push({ action: entry.action, inTx: ctx.state.txDepth > 0 });
    }) as never);
    return rows;
  };

  // Credit release that actually restores the balance from the redemption
  // rows written for the order, like the adapter's `releaseForOrder`.
  const withFunctionalCreditRelease = (ctx: ReturnType<typeof makeContext>) => {
    const released = new Set<string>();
    vi.mocked(ctx.mocks.repos.credits.releaseForOrder).mockImplementation(
      async (orderId: string) => {
        let releasedCents = 0;
        const creditIds: string[] = [];
        for (const [row] of ctx.state.recordRedemptionMock.mock.calls) {
          const key = `${row.creditId}:${row.orderId}`;
          if (row.orderId !== orderId || released.has(key)) continue;
          released.add(key);
          const credit = ctx.state.creditStore.get(row.creditId)!;
          credit.balanceCents += row.amountCents;
          credit.status = "ACTIVE" as never;
          releasedCents += row.amountCents;
          creditIds.push(row.creditId);
        }
        return { releasedCents, creditIds } as never;
      },
    );
  };

  it("creates the PaymentIntent after the order commits and links it in a separate short transaction", async () => {
    const ctx = makeContext();
    const audit = trackAuditTx(ctx);

    const result = await createCheckout(ctx.deps, ctx.input);

    expect(result.clientSecret).toBe("secret-123");
    // THE invariant: no processor call ran inside any transaction.
    expect(ctx.state.paymentCalls).toEqual([
      { method: "createPaymentIntent", inTx: false },
    ]);

    // Order committed → PI created → PI linked.
    const createdAt =
      ctx.mocks.repos.orders.createPending.mock.invocationCallOrder[0]!;
    const piAt =
      ctx.mocks.payments.createPaymentIntent.mock.invocationCallOrder[0]!;
    const linkedAt =
      ctx.mocks.repos.orders.linkPaymentIntentIfPending.mock
        .invocationCallOrder[0]!;
    expect(createdAt).toBeLessThan(piAt);
    expect(piAt).toBeLessThan(linkedAt);
    expect(ctx.state.order.stripePaymentIntentId).toBe("pi-123");

    // Both audit rows are written, inside the link transaction, as before.
    expect(audit).toEqual([
      { action: "pending_created", inTx: true },
      { action: "order.terms_accepted", inTx: true },
    ]);
    expect(ctx.mocks.repos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "pending_created",
        entityId: DEFAULT_ORDER_ID,
        data: expect.objectContaining({ paymentIntentId: "pi-123" }),
        at: ctx.defaults.now,
      }),
    );
  });

  it("sends Stripe the request it sent from inside the transaction, keyed per order", async () => {
    // Pinned against HEAD's in-transaction call: the same cart produces the
    // same request, except the Stripe idempotency key, which is now per order
    // (client key + order id; see the retry test below).
    const ctx = makeContext();

    await createCheckout(ctx.deps, {
      ...ctx.input,
      ref: "11111111-1111-4111-8111-111111111111",
      utmSource: "newsletter",
    });

    expect(ctx.mocks.payments.createPaymentIntent).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.payments.createPaymentIntent.mock.calls[0]).toEqual([
      {
        amountCents: 2194,
        currency: "usd",
        metadata: {
          orderId: DEFAULT_ORDER_ID,
          eventId: ctx.defaults.eventId,
          buyerHumanId: ctx.defaults.buyerHumanId,
          source: "primary",
          currency: "usd",
          ref: "11111111-1111-4111-8111-111111111111",
          utmSource: "newsletter",
        },
        idempotencyKey: `pi:checkout:${ctx.defaults.actorHumanId}:${DEFAULT_CLIENT_KEY}:${DEFAULT_ORDER_ID}`,
        destinationAccountId: "acct_test_connected",
        allowRedirectPaymentMethods: true,
        allowBankDebit: true,
        statementDescriptorSuffix: "LAUNCH PARTY",
        description: `Launch Party — 2 tickets · Order ${formatOrderCode(DEFAULT_ORDER_ID)}`,
      },
    ]);
  });

  it("settles a superseded cart's PaymentIntent before the transaction, and retires it only on that exact PI", async () => {
    const ctx = makeContext({ pendingCartHolds: { [CART_ID]: 1 } });
    ctx.mocks.repos.orders.getById.mockImplementation(async (id: string) =>
      id === CART_ID
        ? ({
            id: CART_ID,
            buyerHumanId: ctx.defaults.buyerHumanId,
            eventId: ctx.defaults.eventId,
            status: "PENDING",
            stripePaymentIntentId: "pi_old",
            occurredAt: ctx.defaults.now,
            items: [],
          } as never)
        : ({ ...ctx.state.order } as never),
    );

    const result = await createCheckout(ctx.deps, {
      ...ctx.input,
      pendingOrderId: CART_ID,
    });

    expect(result.clientSecret).toBe("secret-123");
    expect(ctx.mocks.payments.cancelPaymentIntent).toHaveBeenCalledWith({
      paymentIntentId: "pi_old",
    });
    expect(ctx.state.paymentCalls).toEqual([
      { method: "cancelPaymentIntent", inTx: false },
      { method: "createPaymentIntent", inTx: false },
    ]);
    expect(ctx.mocks.repos.orders.cancelPendingOrder).toHaveBeenCalledWith(
      CART_ID,
      { expectedPaymentIntentId: "pi_old" },
    );
    expect(ctx.state.pendingCartHolds.has(CART_ID)).toBe(false);
  });

  it.each([
    [
      "another buyer's",
      { buyerHumanId: "99999999-9999-4999-8999-000000000001" },
    ],
    ["another event's", { eventId: "99999999-9999-4999-8999-000000000002" }],
    ["a non-PENDING", { status: "SUCCEEDED" }],
  ] as const)(
    "never cancels the PaymentIntent of %s order named as pendingOrderId",
    async (_label, override) => {
      // The settle now runs before the transaction, so its ownership check is
      // the only thing standing between an unvalidated `pendingOrderId` and a
      // stranger's live PaymentIntent.
      const ctx = makeContext({ pendingCartHolds: { [CART_ID]: 1 } });
      ctx.mocks.repos.orders.getById.mockImplementation(async (id: string) =>
        id === CART_ID
          ? ({
              id: CART_ID,
              buyerHumanId: ctx.defaults.buyerHumanId,
              eventId: ctx.defaults.eventId,
              status: "PENDING",
              stripePaymentIntentId: "pi_stranger",
              occurredAt: ctx.defaults.now,
              items: [],
              ...override,
            } as never)
          : ({ ...ctx.state.order } as never),
      );

      await createCheckout(ctx.deps, {
        ...ctx.input,
        pendingOrderId: CART_ID,
      });

      expect(ctx.mocks.payments.cancelPaymentIntent).not.toHaveBeenCalled();
      expect(ctx.mocks.payments.retrievePaymentIntent).not.toHaveBeenCalled();
      expect(
        ctx.mocks.repos.orders.cancelPendingOrder,
      ).not.toHaveBeenCalledWith(CART_ID, expect.anything());
      expect(ctx.state.pendingCartHolds.get(CART_ID)).toBe(1);
    },
  );

  // A cart whose PaymentIntent changes with each read, and a cancel CAS that
  // honours `expectedPaymentIntentId` against the latest one, like the
  // adapter's WHERE.
  const scriptedCart = (
    ctx: ReturnType<typeof makeContext>,
    piForRead: (read: number) => string | null,
  ) => {
    const state = { reads: 0, currentPi: null as string | null };
    ctx.mocks.repos.orders.getById.mockImplementation(async (id: string) => {
      if (id !== CART_ID) return { ...ctx.state.order } as never;
      state.reads++;
      state.currentPi = piForRead(state.reads);
      return {
        id: CART_ID,
        buyerHumanId: ctx.defaults.buyerHumanId,
        eventId: ctx.defaults.eventId,
        status: "PENDING",
        stripePaymentIntentId: state.currentPi,
        occurredAt: ctx.defaults.now,
        items: [],
      } as never;
    });
    ctx.mocks.repos.orders.cancelPendingOrder.mockImplementation((async (
      orderId: string,
      opts?: { expectedPaymentIntentId: string | null },
    ) => {
      if (orderId !== CART_ID) return true;
      if (opts && opts.expectedPaymentIntentId !== state.currentPi) {
        return false;
      }
      ctx.state.pendingCartHolds.delete(orderId);
      return true;
    }) as never);
    return state;
  };

  // A superseded cart with a still-confirmable PaymentIntent (the buyer's
  // other tab can still pay it). Killing that PI and THEN refusing the new
  // checkout would leave the buyer with neither.
  const withLiveSupersededCart = (ctx: ReturnType<typeof makeContext>) => {
    ctx.mocks.repos.orders.getById.mockImplementation(async (id: string) =>
      id === CART_ID
        ? ({
            id: CART_ID,
            buyerHumanId: ctx.defaults.buyerHumanId,
            eventId: ctx.defaults.eventId,
            status: "PENDING",
            stripePaymentIntentId: "pi_tab_a_live",
            occurredAt: ctx.defaults.now,
            items: [],
          } as never)
        : ({ ...ctx.state.order } as never),
    );
  };

  const expectSupersededCartUntouched = (
    ctx: ReturnType<typeof makeContext>,
  ) => {
    expect(ctx.mocks.payments.cancelPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.mocks.payments.retrievePaymentIntent).not.toHaveBeenCalled();
    expect(ctx.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.mocks.repos.orders.cancelPendingOrder).not.toHaveBeenCalled();
    expect(ctx.state.pendingCartHolds.get(CART_ID)).toBe(1);
  };

  it("an event that is not on sale is refused BEFORE the superseded cart's live PaymentIntent is cancelled", async () => {
    const ctx = makeContext({ pendingCartHolds: { [CART_ID]: 1 } });
    withLiveSupersededCart(ctx);
    const event = await ctx.mocks.repos.events.getById(ctx.defaults.eventId);
    ctx.mocks.repos.events.getById.mockResolvedValue({
      ...event,
      status: "DRAFT",
    } as never);

    await expect(
      createCheckout(ctx.deps, { ...ctx.input, pendingOrderId: CART_ID }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_ON_SALE" });
    expectSupersededCartUntouched(ctx);
  });

  it("sales closing AFTER the shared prep still refuse before the superseded cart's PaymentIntent is cancelled", async () => {
    // The event is on sale for the prep transaction; it is unpublished as
    // soon as anything reads it outside a transaction afterwards (the tax
    // lookup / the pre-settle check), and stays that way.
    const ctx = makeContext({ pendingCartHolds: { [CART_ID]: 1 } });
    withLiveSupersededCart(ctx);
    const event = await ctx.mocks.repos.events.getById(ctx.defaults.eventId);
    let preppedOnSale = false;
    let unpublished = false;
    ctx.mocks.repos.events.getById.mockImplementation((async () => {
      if (ctx.state.txDepth > 0 && !unpublished) preppedOnSale = true;
      else if (preppedOnSale) unpublished = true;
      return unpublished ? { ...event, status: "DRAFT" } : event;
    }) as never);

    await expect(
      createCheckout(ctx.deps, { ...ctx.input, pendingOrderId: CART_ID }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_ON_SALE" });
    expect(preppedOnSale).toBe(true);
    expectSupersededCartUntouched(ctx);
  });

  it("re-settles a superseded cart that gained a PaymentIntent after the settle read it, then retires it", async () => {
    // Tab B reads cart O with no PI (nothing to cancel); tab A's checkout of
    // O links P; B's retire CAS (on "no PI") loses. HEAD's in-transaction
    // settle would have cancelled P. Now B's transaction rolls back, P is
    // settled with no transaction open, and the rerun retires O — so the
    // buyer is never left holding two payable PaymentIntents for one cart.
    const ctx = makeContext({
      capacity: 10,
      pendingCartHolds: { [CART_ID]: 1 },
    });
    const cart = scriptedCart(ctx, (read) =>
      // 1 routing probe, 2 first settle: no PI. From 3 (first transaction)
      // on, the PI tab A linked.
      read <= 2 ? null : "pi_linked_meanwhile",
    );

    const result = await createCheckout(ctx.deps, {
      ...ctx.input,
      items: [{ ticketTypeId: ctx.defaults.ticketTypeId, qty: 1 }],
      pendingOrderId: CART_ID,
    });

    expect(result.clientSecret).toBe("secret-123");
    // probe, settle, tx#1 read, tx#1 re-read, settle#2, tx#2 read, and the
    // retire's read-back after its cancel (resale listing release).
    expect(cart.reads).toBe(7);
    expect(ctx.mocks.repos.orders.cancelPendingOrder.mock.calls).toEqual([
      [CART_ID, { expectedPaymentIntentId: null }],
      [CART_ID, { expectedPaymentIntentId: "pi_linked_meanwhile" }],
    ]);
    expect(ctx.mocks.payments.cancelPaymentIntent).toHaveBeenCalledWith({
      paymentIntentId: "pi_linked_meanwhile",
    });
    expect(ctx.state.paymentCalls).toEqual([
      { method: "cancelPaymentIntent", inTx: false },
      { method: "createPaymentIntent", inTx: false },
    ]);
    expect(ctx.state.pendingCartHolds.has(CART_ID)).toBe(false);
    // The rolled-back first attempt wrote no order; exactly one was created.
    expect(ctx.mocks.repos.orders.createPending).toHaveBeenCalledTimes(1);
  });

  it("on the final attempt, a cart whose PaymentIntent keeps changing is left live rather than retired", async () => {
    // Bounded: one re-settle. If the cart changes yet again, the checkout
    // proceeds WITHOUT retiring it — the cart keeps its reservation (counted
    // by the capacity gate, its seats untouched) and its newest PI is never
    // cancelled blind. Nothing is double-sold.
    const ctx = makeContext({
      capacity: 10,
      pendingCartHolds: { [CART_ID]: 1 },
    });
    const cart = scriptedCart(ctx, (read) =>
      read <= 2 ? null : read <= 5 ? "pi_a" : "pi_b",
    );
    const reportError = vi.fn();

    await createCheckout(
      { ...ctx.deps, reportError },
      {
        ...ctx.input,
        items: [{ ticketTypeId: ctx.defaults.ticketTypeId, qty: 1 }],
        pendingOrderId: CART_ID,
      },
    );

    // probe, settle, tx#1 read + re-read, settle#2, tx#2 read + re-read (the
    // final attempt re-reads to report the change instead of throwing)
    expect(cart.reads).toBe(7);
    // Leaving the cart live with an uncancelled PI is a fallback, so it is
    // reported (CLAUDE.md, Error Reporting Convention).
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "carried_over_cart_changed_after_final_settle",
      }),
      expect.objectContaining({
        tags: expect.objectContaining({ caller: "createCheckout" }),
        extra: expect.objectContaining({
          orderId: CART_ID,
          observedPaymentIntentId: "pi_a",
          currentPaymentIntentId: "pi_b",
        }),
      }),
    );
    expect(ctx.mocks.payments.cancelPaymentIntent.mock.calls).toEqual([
      [{ paymentIntentId: "pi_a" }],
    ]);
    expect(ctx.mocks.repos.orders.cancelPendingOrder.mock.calls).toEqual([
      [CART_ID, { expectedPaymentIntentId: null }],
      [CART_ID, { expectedPaymentIntentId: "pi_a" }],
    ]);
    expect(ctx.state.pendingCartHolds.get(CART_ID)).toBe(1);
    expect(
      ctx.mocks.repos.promos.releaseHoldsForOrder,
    ).not.toHaveBeenCalledWith(CART_ID);
    expect(ctx.mocks.repos.credits.releaseForOrder).not.toHaveBeenCalled();
    expect(ctx.mocks.payments.createPaymentIntent).toHaveBeenCalledTimes(1);
  });

  it("a PaymentIntent failure after the commit hands back the seats, promo holds, fee waiver and SPENT credit", async () => {
    const ctx = makeContext({
      activeCredits: [{ id: "credit-1", balanceCents: 500 }],
    });
    withSeatedTier(ctx);
    const audit = trackAuditTx(ctx);
    ctx.mocks.payments.createPaymentIntent.mockRejectedValueOnce(
      new Error("stripe: request timed out"),
    );

    await expect(
      createCheckout(ctx.deps, {
        ...ctx.input,
        items: [
          {
            ticketTypeId: ctx.defaults.ticketTypeId,
            qty: 1,
            seatIds: [SEAT_ID],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "dependency_failed" });

    // The transaction DID commit: credit spent, seat held, order written.
    expect(ctx.state.redeemConditionalMock).toHaveBeenCalled();
    expect(ctx.mocks.repos.orders.createPending).toHaveBeenCalledTimes(1);

    // Never linked, so there is no PaymentIntent to cancel.
    expect(
      ctx.mocks.repos.orders.linkPaymentIntentIfPending,
    ).not.toHaveBeenCalled();
    expect(ctx.mocks.payments.cancelPaymentIntent).not.toHaveBeenCalled();

    // The unwind: status-only cancel CAS on the order it just created, then
    // everything that order took.
    expect(ctx.mocks.repos.orders.cancelPendingOrder).toHaveBeenCalledWith(
      DEFAULT_ORDER_ID,
    );
    expect(ctx.mocks.repos.promos.releaseHoldsForOrder).toHaveBeenCalledWith(
      DEFAULT_ORDER_ID,
    );
    expect(ctx.mocks.repos.feeWaivers.release).toHaveBeenCalledWith(
      DEFAULT_ORDER_ID,
    );
    expect(ctx.mocks.repos.credits.releaseForOrder).toHaveBeenCalledWith(
      DEFAULT_ORDER_ID,
      { now: ctx.defaults.now },
    );
    expect(ctx.mocks.repos.seats.releaseSeats).toHaveBeenCalledWith({
      seatIds: [SEAT_ID],
      releasedAt: ctx.defaults.now,
      // Fenced to this order's own hold, stamped at `now`.
      heldBefore: new Date(
        ctx.defaults.now.getTime() + SEAT_FENCE_SLACK_SECONDS * 1000,
      ),
    });
    expect(ctx.state.seats.get(SEAT_ID)?.status).toBe("AVAILABLE");
    expect(audit).toEqual([
      { action: "platform_credit_applied", inTx: true },
      { action: "pending_abandoned", inTx: true },
    ]);

    // The claim is released (not `fail`ed, which would block the key for 15
    // minutes) so a retry can start; nothing was committed to replay.
    expect(ctx.mocks.idempotency.release).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.idempotency.release).toHaveReturnedWith(true);
    expect(ctx.mocks.idempotency.fail).not.toHaveBeenCalled();
    expect(ctx.mocks.idempotency.commit).not.toHaveBeenCalled();
    expect(ctx.mocks.repos.audit.log).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "pending_created" }),
    );
    expect(ctx.mocks.logger.error).toHaveBeenCalledWith(
      "dependency_failed",
      expect.objectContaining({
        action: "create_payment_intent",
        orderId: DEFAULT_ORDER_ID,
      }),
    );
  });

  it("a retry with the same client key after Stripe created the PI (lost response) succeeds, with the released credit applied again", async () => {
    const ctx = makeContext({
      activeCredits: [{ id: "credit-1", balanceCents: 500 }],
    });
    withFunctionalCreditRelease(ctx);

    // Each attempt mints its own order id, as in production (the harness
    // otherwise hands every attempt DEFAULT_ORDER_ID).
    const originalCreatePending =
      ctx.mocks.repos.orders.createPending.getMockImplementation()!;
    ctx.mocks.repos.orders.createPending.mockImplementation((async (input: {
      id: string;
    }) => {
      const created = await (
        originalCreatePending as (i: unknown) => Promise<{
          id: string;
        }>
      )(input);
      ctx.state.order.id = input.id;
      ctx.state.order.stripePaymentIntentId = null;
      return { ...created, id: input.id };
    }) as never);
    ctx.mocks.repos.orders.getById.mockImplementation((async (id: string) =>
      id === ctx.state.order.id ? { ...ctx.state.order } : null) as never);

    // A fake processor that MODELS Stripe's idempotency: a stored result is
    // replayed for the same key and the same parameters; the same key with
    // different parameters is an `idempotency_error`. The first response is
    // lost AFTER Stripe stored the PI (a timeout on our side).
    type PiRequest = { idempotencyKey: string } & Record<string, unknown>;
    const stripe = new Map<string, { params: string; id: string }>();
    let piSeq = 0;
    let loseNextResponse = true;
    const stripeCreate = async (request: PiRequest) => {
      const { idempotencyKey, ...rest } = request;
      const params = JSON.stringify(rest);
      const prior = stripe.get(idempotencyKey);
      if (prior && prior.params !== params) {
        throw Object.assign(
          new Error(
            "Keys for idempotent requests can only be used with the same parameters they were first used with.",
          ),
          { type: "StripeIdempotencyError" },
        );
      }
      const pi = prior ?? { params, id: `pi_model_${++piSeq}` };
      stripe.set(idempotencyKey, pi);
      if (loseNextResponse) {
        loseNextResponse = false;
        throw new Error("stripe: request timed out");
      }
      return { id: pi.id, clientSecret: `${pi.id}_secret` };
    };
    ctx.mocks.payments.createPaymentIntent.mockImplementation(
      stripeCreate as never,
    );

    await expect(createCheckout(ctx.deps, ctx.input)).rejects.toMatchObject({
      code: "dependency_failed",
    });
    const firstOrderId = ctx.state.order.id;
    // Stripe holds the first PI; its secret never left the server.
    expect(stripe.size).toBe(1);
    // The first attempt's credit is back on the balance.
    expect(ctx.state.creditStore.get("credit-1")?.balanceCents).toBe(500);

    const retry = await createCheckout(ctx.deps, ctx.input);

    expect(retry.orderId).not.toBe(firstOrderId);
    expect(retry.clientSecret).toBe("pi_model_2_secret");
    expect(retry.creditAppliedCents).toBe(500);
    expect(ctx.state.creditStore.get("credit-1")?.balanceCents).toBe(0);
    expect(ctx.state.order.stripePaymentIntentId).toBe("pi_model_2");

    // Same amount, but each attempt's key names its own order: the retry
    // is a NEW PaymentIntent rather than a mismatched replay.
    const calls = ctx.mocks.payments.createPaymentIntent.mock
      .calls as unknown as Array<
      [PiRequest & { amountCents: number; metadata: { orderId: string } }]
    >;
    expect(calls).toHaveLength(2);
    const clientKeyPrefix = `pi:checkout:${ctx.defaults.actorHumanId}:${DEFAULT_CLIENT_KEY}`;
    expect(calls[0]![0].idempotencyKey).toBe(
      `${clientKeyPrefix}:${firstOrderId}`,
    );
    expect(calls[1]![0].idempotencyKey).toBe(
      `${clientKeyPrefix}:${retry.orderId}`,
    );
    expect(calls[1]![0].metadata.orderId).toBe(retry.orderId);
    expect(calls[1]![0].amountCents).toBe(calls[0]![0].amountCents);

    // The model is honest: the client-key-only scheme (the retry's request
    // under the FIRST attempt's key) is exactly what Stripe refuses.
    await expect(
      stripeCreate({
        ...calls[1]![0],
        idempotencyKey: calls[0]![0].idempotencyKey,
      }),
    ).rejects.toMatchObject({ type: "StripeIdempotencyError" });

    expect(ctx.mocks.idempotency.release).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.idempotency.fail).not.toHaveBeenCalled();
    expect(ctx.mocks.idempotency.commit).toHaveBeenCalledTimes(1);
  });

  it("an order retired between the commit and the link gets no client secret, and its PaymentIntent is cancelled", async () => {
    // The buyer's other tab resumed this order (`pendingOrderId`) while the
    // PaymentIntent was being created, retiring it and handing back its
    // holds. Linking now would put a payable PI on a CANCELLED order.
    const ctx = makeContext();
    const audit = trackAuditTx(ctx);
    ctx.mocks.payments.createPaymentIntent.mockImplementationOnce(async () => {
      ctx.state.order.status = "CANCELLED";
      return { id: "pi-123", clientSecret: "secret-123" };
    });
    ctx.mocks.repos.orders.cancelPendingOrder.mockImplementation((async (
      orderId: string,
    ) =>
      orderId === DEFAULT_ORDER_ID
        ? ctx.state.order.status === "PENDING"
        : true) as never);

    await expect(createCheckout(ctx.deps, ctx.input)).rejects.toMatchObject({
      code: "ORDER_NOT_PENDING",
    });

    expect(
      ctx.mocks.repos.orders.linkPaymentIntentIfPending,
    ).toHaveBeenCalledWith(DEFAULT_ORDER_ID, "pi-123");
    expect(ctx.state.order.stripePaymentIntentId).toBeNull();
    expect(ctx.mocks.payments.cancelPaymentIntent).toHaveBeenCalledWith({
      paymentIntentId: "pi-123",
    });
    expect(ctx.state.paymentCalls).toEqual([
      { method: "cancelPaymentIntent", inTx: false },
    ]);
    // Whoever retired it already released its holds; the unwind's CAS loses.
    expect(ctx.mocks.repos.promos.releaseHoldsForOrder).not.toHaveBeenCalled();
    expect(ctx.mocks.repos.credits.releaseForOrder).not.toHaveBeenCalled();
    // No `pending_created` (never linked), but the abandonment is recorded.
    expect(audit).toEqual([{ action: "pending_abandoned", inTx: true }]);
    expect(ctx.mocks.repos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "pending_abandoned",
        entityId: DEFAULT_ORDER_ID,
        data: expect.objectContaining({
          reason: "link_lost",
          paymentIntentId: "pi-123",
          cancelledHere: false,
        }),
      }),
    );
    expect(ctx.mocks.idempotency.commit).not.toHaveBeenCalled();
  });

  it("reports a PaymentIntent cancel that fails during the unwind, guarded, and still surfaces the original error", async () => {
    const ctx = makeContext();
    const reportError = vi.fn(() => {
      throw new Error("reporter down");
    });
    ctx.deps.reportError = reportError;
    ctx.mocks.payments.createPaymentIntent.mockImplementationOnce(async () => {
      ctx.state.order.status = "CANCELLED";
      return { id: "pi-123", clientSecret: "secret-123" };
    });
    const cancelErr = new Error("stripe: cancel 500");
    ctx.mocks.payments.cancelPaymentIntent.mockRejectedValueOnce(cancelErr);

    await expect(createCheckout(ctx.deps, ctx.input)).rejects.toMatchObject({
      code: "ORDER_NOT_PENDING",
    });

    expect(reportError).toHaveBeenCalledWith(cancelErr, {
      tags: {
        area: "checkout",
        useCase: "createCheckout",
        step: "unwindCancelPaymentIntent",
      },
      extra: { orderId: DEFAULT_ORDER_ID, paymentIntentId: "pi-123" },
    });
    expect(ctx.mocks.logger.error).toHaveBeenCalledWith(
      "createCheckout.unwind_cancel_payment_intent_failed",
      expect.objectContaining({ orderId: DEFAULT_ORDER_ID, err: cancelErr }),
    );
  });

  it("reports a failed hold release during the unwind, and still surfaces the original error", async () => {
    const ctx = makeContext();
    const reportError = vi.fn();
    ctx.deps.reportError = reportError;
    ctx.mocks.payments.createPaymentIntent.mockRejectedValueOnce(
      new Error("stripe: request timed out"),
    );
    const releaseErr = new Error("db: connection reset");
    ctx.mocks.repos.promos.releaseHoldsForOrder.mockRejectedValueOnce(
      releaseErr,
    );

    await expect(createCheckout(ctx.deps, ctx.input)).rejects.toMatchObject({
      code: "dependency_failed",
    });

    expect(reportError).toHaveBeenCalledWith(releaseErr, {
      tags: {
        area: "checkout",
        useCase: "createCheckout",
        step: "unwindReleaseHolds",
      },
      extra: { orderId: DEFAULT_ORDER_ID, paymentIntentId: null },
    });
    expect(ctx.mocks.logger.error).toHaveBeenCalledWith(
      "createCheckout.unwind_release_failed",
      expect.objectContaining({ orderId: DEFAULT_ORDER_ID, err: releaseErr }),
    );
  });

  it("a fully credit-covered order still never touches the processor", async () => {
    const ctx = makeContext({
      ...ZERO_FEE_POLICY,
      activeCredits: [{ id: "credit-cover", balanceCents: 2000 }],
    });

    const result = await createCheckout(ctx.deps, ctx.input);

    expect(result.clientSecret).toBeNull();
    expect(result.creditAppliedCents).toBe(2000);
    expect(ctx.state.paymentCalls).toEqual([]);
    expect(
      ctx.mocks.repos.orders.linkPaymentIntentIfPending,
    ).not.toHaveBeenCalled();
  });
});

describe("createCheckout — tax rate unavailable (owner ruling 2026-10-06)", () => {
  it("a failed provider lookup refuses TAX_RATE_UNAVAILABLE: no order, no seat held, claim RELEASED (not failed), reported once", async () => {
    // Unstamped event at an inline US address: checkout must look the rate
    // up, and the provider is rate-limited (ZipTax 108) on every attempt.
    const ctx = makeContext({
      taxSitus: { countryCode: "US", region: "MN", postalCode: "55420" },
    });
    const stamped = ctx.mocks.repos.events.getById.getMockImplementation()!;
    ctx.mocks.repos.events.getById.mockImplementation(async (id: string) => {
      const event = await stamped(id);
      return event ? { ...event, admissionTaxRateBps: null } : event;
    });
    const lookupByPostalCode = vi.fn(async () => {
      const { TaxRateLookupError } = await import("@th/ports/tax-rate-lookup");
      throw new TaxRateLookupError("Ziptax rCode 108", {
        providerCode: 108,
        httpStatus: 429,
      });
    });
    const reportError = vi.fn();
    const deps: CreateCheckoutDeps = {
      ...ctx.deps,
      taxRateLookup: { lookupByPostalCode },
      reportError,
    };

    await expect(createCheckout(deps, ctx.input)).rejects.toMatchObject({
      code: "TAX_RATE_UNAVAILABLE",
    });

    // Retried, then refused — never priced at 0.
    expect(lookupByPostalCode).toHaveBeenCalledTimes(3);
    // Nothing was created or held.
    expect(ctx.mocks.repos.orders.createPending).not.toHaveBeenCalled();
    expect(ctx.mocks.repos.seats.reserveForHold).not.toHaveBeenCalled();
    expect(ctx.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
    // The idempotency claim is RELEASED, so the buyer's "try again" under the
    // same key runs at once — `fail` would lock it out for 15 minutes.
    expect(ctx.mocks.idempotency.begin).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.idempotency.release).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.idempotency.fail).not.toHaveBeenCalled();
    expect(ctx.mocks.idempotency.commit).not.toHaveBeenCalled();
    // One Sentry event for the refusal.
    const refusals = reportError.mock.calls.filter(
      (call) =>
        (call[1] as { tags?: { useCase?: string } } | undefined)?.tags
          ?.useCase === "checkoutTaxRateUnavailable",
    );
    expect(refusals).toHaveLength(1);
  }, 15_000);
});

describe("createCheckout — an order paid in full with platform credit needs a Ready organizer (owner ruling 2026-10-11)", () => {
  // Fixture: 2 × 1000 = 2000 face, ZERO_FEE_POLICY (no platform or processing
  // fee), tax 0, so a 2000 credit covers the whole charge and the order would
  // complete in the checkout transaction with no PaymentIntent.
  const SUBTOTAL = 2000;
  const CREDIT_ID = "credit-cover";

  type Ctx = ReturnType<typeof makeContext>;
  type PayeeRow = Record<string, unknown> | null;

  const READY_PAYEE = {
    id: "acct_test_connected",
    subjectType: "ORGANIZATION",
    subjectId: "org-1",
    status: "ACTIVE",
    payoutsEnabled: true,
    chargesEnabled: true,
    defaultCurrency: "usd",
  } as const;

  const coveredContext = (options: MakeContextOptions = {}) =>
    makeContext({
      ...ZERO_FEE_POLICY,
      activeCredits: [{ id: CREDIT_ID, balanceCents: SUBTOTAL }],
      ...options,
    });

  const payeesOf = (ctx: Ctx) =>
    ctx.deps.repos.payees as unknown as {
      getBySubject: ReturnType<typeof vi.fn>;
      getById: ReturnType<typeof vi.fn>;
    };

  /** The event's org is linked to `row` (null = linked to a missing row). */
  const withPayeeRow = (ctx: Ctx, row: PayeeRow) => {
    const payees = payeesOf(ctx);
    const id = (row?.id as string | undefined) ?? "acct_test_connected";
    payees.getBySubject.mockImplementation(async () => ({ id }));
    payees.getById.mockImplementation(async () => row);
  };

  const fullPromo = (ctx: Ctx): PromoRecord => ({
    id: "promo-free-no-payee",
    code: "FREE",
    codeNormalized: "FREE",
    status: "ACTIVE",
    kind: "AMOUNT",
    scope: "EVENT",
    scopeId: ctx.defaults.eventId,
    value: SUBTOTAL,
    currency: "usd",
    minOrderCents: 0,
    maxRedemptions: undefined,
    maxRedemptionsPerHuman: undefined,
    maxDiscountCents: undefined,
    stackable: false,
    isPublic: false,
    startsAt: undefined,
    endsAt: undefined,
    createdAt: ctx.defaults.now,
    updatedAt: ctx.defaults.now,
  });

  const expectNothingSpentOrIssued = (ctx: Ctx) => {
    // The credit is exactly as it was: never debited, never marked REDEEMED.
    expect(ctx.state.creditStore.get(CREDIT_ID)).toMatchObject({
      balanceCents: SUBTOTAL,
      status: "ACTIVE",
    });
    expect(ctx.state.redeemConditionalMock).not.toHaveBeenCalled();
    expect(ctx.state.recordRedemptionMock).not.toHaveBeenCalled();
    // No order row at all (the gate runs before `createPending`), so nothing
    // SUCCEEDED and nothing minted.
    expect(ctx.mocks.repos.orders.createPending).not.toHaveBeenCalled();
    expect(ctx.mocks.repos.orders.markSucceeded).not.toHaveBeenCalled();
    expect(ctx.mocks.repos.tickets.create).not.toHaveBeenCalled();
    // No promo hold made or confirmed, no organiser money written.
    expect(ctx.mocks.repos.promos.createHolds).not.toHaveBeenCalled();
    expect(ctx.mocks.repos.promos.confirmHoldsForOrder).not.toHaveBeenCalled();
    expect(ctx.mocks.repos.splits.upsertForOrder).not.toHaveBeenCalled();
    expect(ctx.mocks.repos.payeeLedger.settlementCredit).not.toHaveBeenCalled();
    expect(ctx.mocks.repos.audit.log).not.toHaveBeenCalled();
    expect(ctx.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
  };

  const notReadyCases: Array<[string, (ctx: Ctx) => void]> = [
    [
      "the organizer has no payee",
      (ctx) => payeesOf(ctx).getBySubject.mockImplementation(async () => null),
    ],
    ["the payee link points at no row", (ctx) => withPayeeRow(ctx, null)],
    [
      "the payee is not ACTIVE",
      (ctx) => withPayeeRow(ctx, { ...READY_PAYEE, status: "PENDING" }),
    ],
    [
      "charges are not enabled",
      (ctx) => withPayeeRow(ctx, { ...READY_PAYEE, chargesEnabled: false }),
    ],
    [
      "payouts are not enabled",
      (ctx) => withPayeeRow(ctx, { ...READY_PAYEE, payoutsEnabled: false }),
    ],
    [
      "the payee has no Connect account id",
      (ctx) =>
        withPayeeRow(ctx, {
          ...READY_PAYEE,
          id: "payee-without-account",
          stripeAccountId: null,
        }),
    ],
  ];

  it.each(notReadyCases)(
    "refuses STRIPE_NOT_CONNECTED and spends nothing when %s",
    async (_label, arrange) => {
      const ctx = coveredContext();
      arrange(ctx);

      await expect(createCheckout(ctx.deps, ctx.input)).rejects.toMatchObject({
        code: "STRIPE_NOT_CONNECTED",
      });

      expectNothingSpentOrIssued(ctx);
    },
  );

  it("refuses with the harness's own not-connected switch too (the one the card test uses)", async () => {
    const ctx = coveredContext({ stripeConnected: false });

    await expect(createCheckout(ctx.deps, ctx.input)).rejects.toMatchObject({
      code: "STRIPE_NOT_CONNECTED",
    });

    expectNothingSpentOrIssued(ctx);
  });

  it("completes on credit alone when the payee is Ready, checking the payee once", async () => {
    const ctx = coveredContext();
    withPayeeRow(ctx, { ...READY_PAYEE });

    const result = await createCheckout(ctx.deps, ctx.input);

    expect(result.clientSecret).toBeNull();
    expect(result.creditAppliedCents).toBe(SUBTOTAL);
    expect(ctx.state.creditStore.get(CREDIT_ID)?.balanceCents).toBe(0);
    expect(ctx.state.recordRedemptionMock).toHaveBeenCalledWith(
      expect.objectContaining({ creditId: CREDIT_ID, amountCents: SUBTOTAL }),
    );
    expect(ctx.mocks.repos.orders.markSucceeded).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.repos.tickets.create).toHaveBeenCalled();
    expect(ctx.mocks.repos.splits.upsertForOrder).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
    // The gate ran ahead of the debit and its answer was reused, not re-read.
    expect(payeesOf(ctx).getBySubject).toHaveBeenCalledTimes(1);
    expect(payeesOf(ctx).getById).toHaveBeenCalledTimes(1);
  });

  it("checks the payee BEFORE the credit is debited on a credit-covered order", async () => {
    const ctx = coveredContext();
    const order: string[] = [];
    const getBySubject = payeesOf(ctx).getBySubject;
    const readPayee = getBySubject.getMockImplementation()!;
    getBySubject.mockImplementation(async (...args: unknown[]) => {
      order.push("payee");
      return readPayee(...args);
    });
    const debit = ctx.state.redeemConditionalMock.getMockImplementation()!;
    ctx.state.redeemConditionalMock.mockImplementation(async (input) => {
      order.push("debit");
      return debit(input);
    });

    await createCheckout(ctx.deps, ctx.input);

    expect(order).toEqual(["payee", "debit"]);
  });

  it("a credit-covered order with a promo confirms no promo hold when the payee is not Ready", async () => {
    // 1500 off leaves 500, which the credit covers in full.
    const ctx = coveredContext({ stripeConnected: false });
    ctx.mocks.repos.promos.findActiveByCodes.mockResolvedValue([
      { ...fullPromo(ctx), value: 1500 },
    ]);
    ctx.mocks.repos.promos.getRedemptionStats.mockResolvedValue({
      totalRedemptions: 0,
      redemptionsForHuman: 0,
    });

    await expect(
      createCheckout(ctx.deps, { ...ctx.input, promoCodes: ["free"] }),
    ).rejects.toMatchObject({ code: "STRIPE_NOT_CONNECTED" });

    expectNothingSpentOrIssued(ctx);
  });

  it("part credit, part card: still refused at the card path's own gate, after the pending order", async () => {
    // Default fees: a 500 credit leaves a card charge, so this is the card
    // path. Its gate has not moved: the pending order is written first (this
    // harness does not roll back; the real transaction does, credit included).
    const ctx = makeContext({
      stripeConnected: false,
      activeCredits: [{ id: "credit-part", balanceCents: 500 }],
    });

    await expect(createCheckout(ctx.deps, ctx.input)).rejects.toMatchObject({
      code: "STRIPE_NOT_CONNECTED",
    });

    expect(ctx.mocks.repos.orders.createPending).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.repos.orders.markSucceeded).not.toHaveBeenCalled();
    expect(ctx.mocks.repos.tickets.create).not.toHaveBeenCalled();
    expect(ctx.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
  });

  it("card path precedence is unchanged: missing chargeback terms is reported before a not-Ready payee", async () => {
    const ctx = makeContext({
      stripeConnected: false,
      chargebackTermsAccepted: false,
    });

    await expect(createCheckout(ctx.deps, ctx.input)).rejects.toMatchObject({
      code: "chargeback_terms_required",
    });
  });

  it("card path precedence is unchanged: a sold-out tier is reported before a not-Ready payee", async () => {
    const ctx = makeContext({
      stripeConnected: false,
      capacity: 1,
      issuedForTicketType: 1,
    });

    await expect(createCheckout(ctx.deps, ctx.input)).rejects.toMatchObject({
      code: "TICKET_TYPE_SOLD_OUT",
    });
    expect(ctx.mocks.repos.orders.createPending).not.toHaveBeenCalled();
  });

  it("a credit-covered order names the not-Ready payee first, since its gate runs before the debit", async () => {
    // The one place the two paths differ: the card path reaches capacity (and
    // chargeback terms) before its gate, a credit-covered order is refused
    // before its credit is touched. Both refuse; only the named reason differs.
    const ctx = coveredContext({
      stripeConnected: false,
      capacity: 1,
      issuedForTicketType: 1,
      chargebackTermsAccepted: false,
    });

    await expect(createCheckout(ctx.deps, ctx.input)).rejects.toMatchObject({
      code: "STRIPE_NOT_CONNECTED",
    });
    expectNothingSpentOrIssued(ctx);
  });

  // A concurrent drain: the snapshot says 2000 of credit covers the whole
  // charge, but the atomic debit only applies `APPLIED` of it. The early gate
  // has already run (the snapshot said zero charge); the order ends on a card.
  const drainTo = (ctx: Ctx, APPLIED: number) => {
    const debit = ctx.state.redeemConditionalMock.getMockImplementation()!;
    ctx.state.redeemConditionalMock.mockImplementation(async (input) =>
      debit({ ...input, requestedCents: Math.min(input.requestedCents, APPLIED) }),
    );
  };

  it("concurrent drain, Ready payee: the order goes to a card for the rest, payee read once", async () => {
    const ctx = coveredContext();
    withPayeeRow(ctx, { ...READY_PAYEE });
    drainTo(ctx, 1000);

    const result = await createCheckout(ctx.deps, ctx.input);

    expect(result.creditAppliedCents).toBe(1000);
    expect(result.clientSecret).not.toBeNull();
    expect(ctx.mocks.payments.createPaymentIntent).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.payments.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: SUBTOTAL - 1000,
        destinationAccountId: "acct_test_connected",
      }),
    );
    // The early gate's answer was reused by the card path, not re-read.
    expect(payeesOf(ctx).getBySubject).toHaveBeenCalledTimes(1);
    expect(payeesOf(ctx).getById).toHaveBeenCalledTimes(1);
  });

  it("concurrent drain, payee not Ready: refused STRIPE_NOT_CONNECTED and the credit is never debited", async () => {
    const ctx = coveredContext({ stripeConnected: false });
    drainTo(ctx, 1000);

    await expect(createCheckout(ctx.deps, ctx.input)).rejects.toMatchObject({
      code: "STRIPE_NOT_CONNECTED",
    });

    expectNothingSpentOrIssued(ctx);
  });

  it("refuses inside the same transaction that made the waiver reservation and retired the carried cart", async () => {
    const CART_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const ctx = coveredContext({
      stripeConnected: false,
      capacity: 5,
      pendingCartHolds: { [CART_ID]: 1 },
    });
    ctx.mocks.repos.orders.getById.mockImplementation(async (id: string) =>
      id === CART_ID
        ? {
            id: CART_ID,
            buyerHumanId: ctx.defaults.buyerHumanId,
            eventId: ctx.defaults.eventId,
            status: "PENDING",
            stripePaymentIntentId: null,
            items: [],
          }
        : { ...ctx.state.order },
    );
    // Track the transaction callback: every write below must happen inside
    // it, and the refusal must propagate out of that same callback.
    const txState = { inTx: false, threwInTx: null as unknown };
    const repos = ctx.deps.repos as unknown as {
      tx: (fn: unknown, opts?: unknown) => Promise<unknown>;
    };
    const originalTx = repos.tx;
    repos.tx = async (fn, opts) => {
      txState.inTx = true;
      try {
        return await originalTx(fn, opts);
      } catch (err) {
        txState.threwInTx = err;
        throw err;
      } finally {
        txState.inTx = false;
      }
    };
    const writesInTx: Record<string, boolean> = {};
    ctx.mocks.repos.feeWaivers.resolveApplicable.mockImplementation(async () => {
      writesInTx.waiverLookup = txState.inTx;
      return [{ id: "waiver-1" }];
    });
    ctx.mocks.repos.feeWaivers.reserve.mockImplementation(async () => {
      writesInTx.waiverReserve = txState.inTx;
      return { reservedTickets: 1, feeWaivedCents: 0, redemptionId: "r-1" };
    });
    ctx.mocks.repos.feeWaivers.release.mockImplementation(async () => {
      writesInTx.cartRelease = txState.inTx;
      return { releasedTickets: 1 };
    });

    await expect(
      createCheckout(ctx.deps, { ...ctx.input, pendingOrderId: CART_ID }),
    ).rejects.toMatchObject({ code: "STRIPE_NOT_CONNECTED" });

    // The cart was retired (release ran) and the refusal came out of the same
    // transaction callback, so a real transaction undoes those writes.
    expect(writesInTx.cartRelease).toBe(true);
    expect(txState.threwInTx).toMatchObject({ code: "STRIPE_NOT_CONNECTED" });
    expectNothingSpentOrIssued(ctx);
  });

  it("a FREE order ($0 tier, no credit spent) is still claimed with no payee at all", async () => {
    const ctx = makeContext({
      ticketPriceCents: 0,
      stripeConnected: false,
      activeCredits: [{ id: CREDIT_ID, balanceCents: SUBTOTAL }],
    });

    const result = await createCheckout(ctx.deps, ctx.input);

    expect(result.clientSecret).toBeNull();
    expect(result.creditAppliedCents).toBe(0);
    expect(ctx.mocks.repos.orders.markSucceeded).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.repos.tickets.create).toHaveBeenCalled();
    expect(ctx.state.creditStore.get(CREDIT_ID)?.balanceCents).toBe(SUBTOTAL);
    expect(ctx.state.redeemConditionalMock).not.toHaveBeenCalled();
    expect(payeesOf(ctx).getBySubject).not.toHaveBeenCalled();
  });

  it("a promo that brings a paid cart to $0 is still claimed with no payee at all", async () => {
    const ctx = makeContext({
      stripeConnected: false,
      activeCredits: [{ id: CREDIT_ID, balanceCents: SUBTOTAL }],
    });
    ctx.mocks.repos.promos.findActiveByCodes.mockResolvedValue([fullPromo(ctx)]);
    ctx.mocks.repos.promos.getRedemptionStats.mockResolvedValue({
      totalRedemptions: 0,
      redemptionsForHuman: 0,
    });

    const result = await createCheckout(ctx.deps, {
      ...ctx.input,
      promoCodes: ["free"],
    });

    expect(result.clientSecret).toBeNull();
    expect(result.creditAppliedCents).toBe(0);
    expect(ctx.mocks.repos.orders.markSucceeded).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.repos.tickets.create).toHaveBeenCalled();
    expect(ctx.state.creditStore.get(CREDIT_ID)?.balanceCents).toBe(SUBTOTAL);
    expect(payeesOf(ctx).getBySubject).not.toHaveBeenCalled();
  });
});

describe("createCheckout — an embed checkout never sells a gated event (owner ruling 2026-10-12)", () => {
  // An embed names its buyer by a TYPED email, so an unlock held by that
  // email's human proves nothing about who is buying. createEmbedGuestCheckout
  // refuses first; this pins the backstop INSIDE createCheckout itself.
  const EMBED_ID = "77777777-7777-4777-8777-777777777777";

  const gatedContext = async (gateType: "NONE" | "PASSWORD" | "APPLICATION") => {
    const ctx = makeContext();
    const base = await ctx.mocks.repos.events.getById(ctx.defaults.eventId);
    ctx.mocks.repos.events.getById.mockImplementation(async (id: string) =>
      id === ctx.defaults.eventId ? { ...base!, gateType } : null,
    );
    // The typed email's human holds an unlock (the approved person). The
    // gate reads it on the transaction's repos, so hand those our spy.
    const isUnlocked = vi.fn(async () => true);
    const repos = ctx.deps.repos as unknown as {
      tx: (fn: (tx: unknown) => Promise<unknown>, ...rest: unknown[]) => unknown;
    };
    const originalTx = repos.tx;
    repos.tx = (fn, ...rest) =>
      originalTx((tx) => {
        (tx as { eventUnlocks: unknown }).eventUnlocks = { isUnlocked };
        return fn(tx);
      }, ...rest);
    return { ctx, isUnlocked };
  };

  it.each(["APPLICATION", "PASSWORD"] as const)(
    "a %s event with the embed context is refused with EVENT_GATED, even though the buyer holds an unlock",
    async (gateType) => {
      const { ctx, isUnlocked } = await gatedContext(gateType);

      await expect(
        createCheckout(ctx.deps, ctx.input, { embedId: EMBED_ID }),
      ).rejects.toMatchObject({ code: "EVENT_GATED" });

      expect(isUnlocked).not.toHaveBeenCalled();
      expect(ctx.mocks.repos.orders.createPending).not.toHaveBeenCalled();
      expect(ctx.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
    },
  );

  it("the main checkout (no embed context) still lets an unlocked buyer buy an APPLICATION event", async () => {
    const { ctx, isUnlocked } = await gatedContext("APPLICATION");

    const result = await createCheckout(ctx.deps, ctx.input);

    expect(result.clientSecret).toBe("secret-123");
    expect(isUnlocked).toHaveBeenCalled();
  });

  it("an ungated event sells through the embed context as before", async () => {
    const { ctx } = await gatedContext("NONE");

    const result = await createCheckout(ctx.deps, ctx.input, {
      embedId: EMBED_ID,
    });

    expect(result.clientSecret).toBe("secret-123");
  });
});

describe("createCheckout — every gate site refuses an embed checkout of an event gated mid-checkout", () => {
  // The event reads NONE on the first read (createCheckout's shared-prep
  // transaction passes) and PASSWORD on every later read, so the site that
  // throws is the NEXT gate check: the free claim's transaction, the paid
  // transaction, or the paid pre-transaction settle. The buyer holds an
  // unlock on every repo, so only the embed rule can refuse.
  const EMBED_ID = "77777777-7777-4777-8777-777777777777";
  const CART_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  const flippingContext = async (options: MakeContextOptions = {}) => {
    const ctx = makeContext(options);
    const base = await ctx.mocks.repos.events.getById(ctx.defaults.eventId);
    let reads = 0;
    ctx.mocks.repos.events.getById.mockImplementation(async (id: string) => {
      if (id !== ctx.defaults.eventId) return null;
      reads += 1;
      return { ...base!, gateType: reads === 1 ? "NONE" : "PASSWORD" };
    });
    const isUnlocked = vi.fn(async () => true);
    const repos = ctx.deps.repos as unknown as {
      eventUnlocks?: unknown;
      tx: (fn: (tx: unknown) => Promise<unknown>, ...rest: unknown[]) => unknown;
    };
    // Outside a transaction too: the pre-transaction settle reads deps.repos.
    repos.eventUnlocks = { isUnlocked };
    const originalTx = repos.tx;
    repos.tx = (fn, ...rest) =>
      originalTx((tx) => {
        (tx as { eventUnlocks: unknown }).eventUnlocks = { isUnlocked };
        return fn(tx);
      }, ...rest);
    return { ctx, isUnlocked, reads: () => reads };
  };

  it("FREE order: the claim transaction refuses with EVENT_GATED and mints nothing", async () => {
    const { ctx, isUnlocked, reads } = await flippingContext({
      ticketPriceCents: 0,
    });

    await expect(
      createCheckout(ctx.deps, ctx.input, { embedId: EMBED_ID }),
    ).rejects.toMatchObject({ code: "EVENT_GATED" });

    expect(reads()).toBeGreaterThan(1);
    expect(isUnlocked).not.toHaveBeenCalled();
    expect(ctx.mocks.repos.tickets.create).not.toHaveBeenCalled();
    expect(ctx.mocks.repos.orders.createPending).not.toHaveBeenCalled();
  });

  it("PAID order: the paid transaction refuses with EVENT_GATED and no PaymentIntent is made", async () => {
    const { ctx, isUnlocked, reads } = await flippingContext();

    await expect(
      createCheckout(ctx.deps, ctx.input, { embedId: EMBED_ID }),
    ).rejects.toMatchObject({ code: "EVENT_GATED" });

    expect(reads()).toBeGreaterThan(1);
    expect(isUnlocked).not.toHaveBeenCalled();
    expect(ctx.mocks.repos.orders.createPending).not.toHaveBeenCalled();
    expect(ctx.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
  });

  it("PAID order carrying a cart: the pre-transaction settle refuses BEFORE the cart's PaymentIntent is cancelled", async () => {
    const { ctx, isUnlocked } = await flippingContext();
    ctx.mocks.repos.orders.getById.mockImplementation(async (id: string) =>
      id === CART_ID
        ? {
            id: CART_ID,
            buyerHumanId: ctx.defaults.buyerHumanId,
            eventId: ctx.defaults.eventId,
            status: "PENDING",
            stripePaymentIntentId: "pi_other_tab",
            items: [],
          }
        : { ...ctx.state.order },
    );

    await expect(
      createCheckout(
        ctx.deps,
        { ...ctx.input, pendingOrderId: CART_ID },
        { embedId: EMBED_ID },
      ),
    ).rejects.toMatchObject({ code: "EVENT_GATED" });

    expect(isUnlocked).not.toHaveBeenCalled();
    expect(ctx.mocks.payments.cancelPaymentIntent).not.toHaveBeenCalled();
    expect(ctx.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
  });
});

// ── organiser-resale-share FR-003: the record each ticket keeps ─────────────
// Every primary sale writes, on each ticket item, the event's RESALE clause in
// force at that sale plus the ticket's original price. Read once per order.
describe("createCheckout — FR-003 resale clause record", () => {
  const RESALE_TERMS_ID = "resale-terms-fr003";
  const EMBED_ID = "66666666-6666-4666-8666-666666666666";

  type Clause = Pick<
    PayoutTermsRecord,
    | "resaleShareType"
    | "resaleShareBps"
    | "resaleShareCents"
    | "resaleSharePayer"
    | "version"
  >;

  /**
   * Points the harness event at RESALE terms whose clause the test can change
   * between sales. Returns the live clause object.
   */
  const withResaleTerms = (
    ctx: ReturnType<typeof makeContext>,
    clause: Clause,
  ) => {
    const live = { ...clause };
    const originalEvent = ctx.mocks.repos.events.getById.getMockImplementation()!;
    ctx.mocks.repos.events.getById.mockImplementation(async (id: string) => {
      const event = await originalEvent(id);
      return event ? { ...event, resalePayoutTermsId: RESALE_TERMS_ID } : null;
    });
    const originalTerms =
      ctx.mocks.repos.payoutTerms.getById.getMockImplementation()!;
    ctx.mocks.repos.payoutTerms.getById.mockImplementation(
      async (...args: unknown[]) => {
        if (args[0] === RESALE_TERMS_ID) {
          const primary = await (
            originalTerms as () => Promise<PayoutTermsRecord>
          )();
          return { ...primary, id: RESALE_TERMS_ID, kind: "RESALE", ...live };
        }
        return (originalTerms as () => Promise<PayoutTermsRecord>)();
      },
    );
    return live;
  };

  const ticketItems = (ctx: ReturnType<typeof makeContext>) =>
    (ctx.state.lastCreatePendingInput?.items ?? []).filter(
      (item) => item.kind === "ticket",
    );

  const resaleTermsReads = (ctx: ReturnType<typeof makeContext>) =>
    ctx.mocks.repos.payoutTerms.getById.mock.calls.filter(
      (call: unknown[]) => call[0] === RESALE_TERMS_ID,
    ).length;

  it("stamps the event's clause, its terms id + version and each ticket's original price, reading the terms once", async () => {
    const ctx = makeContext({ ticketPriceCents: 4000 });
    withResaleTerms(ctx, {
      resaleShareType: "PERCENT",
      resaleShareBps: 1000,
      resaleShareCents: null,
      resaleSharePayer: "SELLER",
      version: 3,
    });

    await createCheckout(ctx.deps, ctx.input);

    const tickets = ticketItems(ctx);
    expect(tickets).toHaveLength(2);
    for (const item of tickets) {
      expect(item).toMatchObject({
        unitPriceCents: 4000,
        resaleClauseType: "PERCENT",
        resaleClauseBps: 1000,
        resaleClauseCents: null,
        resaleClausePayer: "SELLER",
        resaleClauseTermsId: RESALE_TERMS_ID,
        resaleClauseTermsVersion: 3,
        originalUnitPriceCents: 4000,
      });
    }
    // Once per order, not once per ticket.
    expect(resaleTermsReads(ctx)).toBe(1);
  });

  it("stamps a FLAT BUYER clause", async () => {
    const ctx = makeContext({ ticketPriceCents: 2500 });
    withResaleTerms(ctx, {
      resaleShareType: "FLAT",
      resaleShareBps: null,
      resaleShareCents: 800,
      resaleSharePayer: "BUYER",
      version: 1,
    });

    await createCheckout(ctx.deps, ctx.input);

    expect(ticketItems(ctx)[0]).toMatchObject({
      resaleClauseType: "FLAT",
      resaleClauseBps: null,
      resaleClauseCents: 800,
      resaleClausePayer: "BUYER",
      resaleClauseTermsVersion: 1,
      originalUnitPriceCents: 2500,
    });
  });

  it("an event whose clause is not set records no clause, but still the original price", async () => {
    const ctx = makeContext({ ticketPriceCents: 4000 });
    withResaleTerms(ctx, {
      resaleShareType: null,
      resaleShareBps: null,
      resaleShareCents: null,
      resaleSharePayer: "SELLER",
      version: 2,
    });

    await createCheckout(ctx.deps, ctx.input);

    for (const item of ticketItems(ctx)) {
      expect(item).toMatchObject({
        resaleClauseType: null,
        resaleClauseBps: null,
        resaleClauseCents: null,
        resaleClausePayer: null,
        // The CHECK forbids a terms id/version without a clause.
        resaleClauseTermsId: null,
        resaleClauseTermsVersion: null,
        originalUnitPriceCents: 4000,
      });
    }
  });

  it("an event with no RESALE terms records no clause and never reads terms for one", async () => {
    const ctx = makeContext({ ticketPriceCents: 4000 });

    await createCheckout(ctx.deps, ctx.input);

    expect(ticketItems(ctx)[0]).toMatchObject({
      resaleClauseType: null,
      resaleClauseTermsId: null,
      originalUnitPriceCents: 4000,
    });
    expect(resaleTermsReads(ctx)).toBe(0);
  });

  it("a later clause change applies to tickets sold afterwards, never to items already written", async () => {
    const ctx = makeContext({ ticketPriceCents: 4000 });
    const live = withResaleTerms(ctx, {
      resaleShareType: "PERCENT",
      resaleShareBps: 1000,
      resaleShareCents: null,
      resaleSharePayer: "SELLER",
      version: 1,
    });

    await createCheckout(ctx.deps, ctx.input);
    const firstSale = ticketItems(ctx);
    const firstSnapshot = structuredClone(
      firstSale.map(({ meta: _meta, ...rest }) => rest),
    );

    // The organiser changes the clause to 5%.
    live.resaleShareBps = 500;
    live.version = 2;

    const later = makeContext({ ticketPriceCents: 4000 });
    const laterLive = withResaleTerms(later, { ...live });
    await createCheckout(later.deps, later.input);

    expect(laterLive.resaleShareBps).toBe(500);
    expect(ticketItems(later)[0]).toMatchObject({
      resaleClauseBps: 500,
      resaleClauseTermsVersion: 2,
    });
    // The first sale's items still carry the clause of THEIR sale.
    expect(firstSale.map(({ meta: _meta, ...rest }) => rest)).toEqual(
      firstSnapshot,
    );
    expect(firstSale[0]).toMatchObject({
      resaleClauseBps: 1000,
      resaleClauseTermsVersion: 1,
    });
  });

  it("a free claim (claimFreeTickets) stamps the clause and an original price of 0", async () => {
    const ctx = makeContext({ ticketPriceCents: 0 });
    withResaleTerms(ctx, {
      resaleShareType: "PERCENT",
      resaleShareBps: 500,
      resaleShareCents: null,
      resaleSharePayer: "SELLER",
      version: 2,
    });

    const result = await createCheckout(ctx.deps, ctx.input);

    expect(result.clientSecret).toBeNull();
    expect(ctx.mocks.payments.createPaymentIntent).not.toHaveBeenCalled();
    const tickets = ticketItems(ctx);
    expect(tickets).toHaveLength(2);
    for (const item of tickets) {
      expect(item).toMatchObject({
        resaleClauseType: "PERCENT",
        resaleClauseBps: 500,
        resaleClauseTermsId: RESALE_TERMS_ID,
        resaleClauseTermsVersion: 2,
        originalUnitPriceCents: 0,
      });
    }
    expect(resaleTermsReads(ctx)).toBe(1);
  });

  it("a ticket a promo makes free (claimFreeTickets) keeps the organiser's price as the original, not $0", async () => {
    const ctx = makeContext({ ticketPriceCents: 4000 });
    withResaleTerms(ctx, {
      resaleShareType: "PERCENT",
      resaleShareBps: 1000,
      resaleShareCents: null,
      resaleSharePayer: "SELLER",
      version: 1,
    });
    const freePromo: PromoRecord = {
      id: "promo-free-fr003",
      code: "FREE",
      codeNormalized: "FREE",
      status: "ACTIVE",
      kind: "AMOUNT",
      scope: "EVENT",
      scopeId: ctx.defaults.eventId,
      value: 100_000,
      currency: "usd",
      minOrderCents: 0,
      maxRedemptions: undefined,
      maxRedemptionsPerHuman: undefined,
      maxDiscountCents: undefined,
      stackable: false,
      isPublic: false,
      startsAt: undefined,
      endsAt: undefined,
      createdAt: ctx.defaults.now,
      updatedAt: ctx.defaults.now,
    };
    ctx.mocks.repos.promos.findActiveByCodes.mockResolvedValue([freePromo]);
    ctx.mocks.repos.promos.getRedemptionStats.mockResolvedValue({
      totalRedemptions: 0,
      redemptionsForHuman: 0,
    });

    await createCheckout(ctx.deps, { ...ctx.input, promoCodes: ["free"] });

    const tickets = ticketItems(ctx);
    expect(tickets).toHaveLength(2);
    for (const item of tickets) {
      expect(item).toMatchObject({
        resaleClauseBps: 1000,
        originalUnitPriceCents: 4000,
      });
    }
    // The promo line itself records nothing.
    const discount = ctx.state.lastCreatePendingInput!.items.find(
      (item) => item.kind === "discount",
    );
    expect(discount).toBeDefined();
    expect(discount).not.toHaveProperty("originalUnitPriceCents");
  });

  it("an embed guest checkout (pay what you want) stamps the clause and the buyer's chosen price as the original", async () => {
    const { createEmbedGuestCheckout } = await import(
      "../../embeds/create-embed-guest-checkout"
    );
    const ctx = makeContext({ admissionTaxRateBps: 0 });
    const originalTypes =
      ctx.mocks.repos.events.listTicketTypes.getMockImplementation()!;
    ctx.mocks.repos.events.listTicketTypes.mockImplementation(
      async (eventId: string) =>
        (await originalTypes(eventId)).map((tt) => ({
          ...tt,
          priceCents: 0,
          pricingMode: "ADJUSTABLE" as const,
          minimumCents: 500,
        })),
    );
    const repos = ctx.deps.repos as unknown as Record<string, unknown>;
    repos.embeds = {
      getById: vi.fn(async () => ({
        id: EMBED_ID,
        subjectType: "organization",
        subjectId: ctx.defaults.orgId,
        domain: "shop.example.com",
        status: "ACTIVE",
        requireAuth: false,
        linkOut: false,
        defaultView: "list",
        viewToggle: false,
        createdBy: "someone",
        createdAt: new Date("2025-01-01"),
      })),
    };
    Object.assign(ctx.mocks.repos.humans, {
      ensureGuestHuman: vi.fn(async () => ({
        humanId: ctx.defaults.buyerHumanId,
        created: false,
      })),
      update: vi.fn(),
    });
    withResaleTerms(ctx, {
      resaleShareType: "PERCENT",
      resaleShareBps: 750,
      resaleShareCents: null,
      resaleSharePayer: "SELLER",
      version: 4,
    });

    await createEmbedGuestCheckout(ctx.deps, {
      embedId: EMBED_ID,
      eventId: ctx.defaults.eventId,
      hostOrigin: "https://shop.example.com",
      guestName: "Guest Buyer",
      guestEmail: "guest@example.com",
      clientKey: EMBED_CLIENT_KEY,
      termsAccepted: true,
      refundPolicyAccepted: true,
      items: [
        {
          ticketTypeId: ctx.defaults.ticketTypeId,
          qty: 1,
          donationAmountCents: 1500,
        },
      ],
    });

    expect(ticketItems(ctx)).toHaveLength(1);
    expect(ticketItems(ctx)[0]).toMatchObject({
      unitPriceCents: 1500,
      resaleClauseType: "PERCENT",
      resaleClauseBps: 750,
      resaleClauseTermsId: RESALE_TERMS_ID,
      resaleClauseTermsVersion: 4,
      originalUnitPriceCents: 1500,
    });
  });
});
