import { describe, expect, it, vi } from "vitest";

import type { IdempotencyPort } from "@th/ports/idempotency";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { PromoRecord } from "@th/ports/repos/promos";
import { TaxRateLookupError } from "@th/ports/tax-rate-lookup";
import { SCANNER_TERMS_VERSION } from "@th/types";
import { createTestLogger } from "@th/test-utils/fakes/logger";
import { createFakePayeeLedgerRepo } from "@th/test-utils/fakes/payee-ledger";

import { computeExpectedPaymentAmount } from "../../../lib/orders/compute-expected-payment-amount";
import type { LocalTaxImpositionRule } from "../../../lib/pricing/tax-impositions";
import { ledgerEntryBalanceDeltaCents } from "../../payouts/_shared/ledger-entry-delta";
import { recordCashSale } from "../record-cash-sale";
import { refundCashSale } from "../refund-cash-sale";
import { startPosSale } from "../start-pos-sale";

/**
 * NFR-001 / FR-003 / FR-004 PARITY, CASH SIDE
 * (docs/specs/2026-10-07/door-sales-same-price-and-tax.spec.yaml).
 *
 * The same cart sold by card at the door (`startPosSale`) and in cash
 * (`recordCashSale`): identical face; the cash sale has NO platform fee and
 * NO processing fee (owner ruling 2026-10-08: cash = ticket price after any
 * promo + tax, nothing else; it revises R3, which had cash pay the platform
 * fee), and its tax is RE-SOLVED on that base, so under a buyer-total base
 * (TN, MN) the tax moves too. The tax lands on the organiser's payee as one
 * CASH_SALE_DEBIT (R6); a tax-free sale writes none.
 *
 * Same scenarios and same test seam for local impositions as
 * `door-card-parity.test.ts` (2 × $25 GA + 1 × $40 VIP; 5% + 50¢ platform
 * fee, 2.9% + 30¢ processing, passed through). Every cash number is pinned as
 * a literal, and the card numbers are pinned there.
 */
const localTaxRules = vi.hoisted(() => ({
  rules: [] as LocalTaxImpositionRule[],
}));
vi.mock("../../../lib/pricing/tax-impositions", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../lib/pricing/tax-impositions")>();
  return {
    ...actual,
    resolveTaxImpositions: (
      args: Parameters<typeof actual.resolveTaxImpositions>[0],
    ) => actual.resolveTaxImpositions(args, localTaxRules.rules),
  };
});

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const OPERATOR_ID = "22222222-2222-4222-8222-222222222223";
const PHANTOM_ID = "22222222-2222-4222-8222-222222222224";
const GA_ID = "33333333-3333-4333-8333-333333333333";
const VIP_ID = "33333333-3333-4333-8333-333333333334";
const TERMS_ID = "44444444-4444-4444-8444-444444444444";
const POLICY_ID = "55555555-5555-4555-8555-555555555555";
const CARD_ORDER_ID = "66666666-6666-4666-8666-666666666666";
const PAYEE_ID = "77777777-7777-4777-8777-777777777777";
const PLACEHOLDER_PAYEE_ID = "77777777-7777-4777-8777-777777777778";
const NOW = new Date("2026-03-01T12:00:00.000Z");

type Situs = { countryCode: string; region: string; postalCode: string };

const NASHVILLE: Situs = { countryCode: "US", region: "TN", postalCode: "37203" };
const MINNEAPOLIS: Situs = { countryCode: "US", region: "MN", postalCode: "55403" };
const ST_PAUL: Situs = { countryCode: "US", region: "MN", postalCode: "55101" };
const PORTLAND: Situs = { countryCode: "US", region: "OR", postalCode: "97201" };

/** Stand-in for the Minneapolis entertainment tax (3% of face, platform-collected). */
const MPLS_LINE = {
  code: "TEST_MPLS_ENTERTAINMENT",
  label: "Test Minneapolis entertainment tax",
  jurisdiction: "US/MN/Minneapolis",
  countryCode: "US",
  region: "MN",
  postalCodes: ["55403"],
  rateBps: 300,
  base: "TICKET_FACE",
  collector: "PLATFORM",
  appliesToResale: false,
  source: "door-cash parity fixture",
} as LocalTaxImpositionRule;

type Scenario = {
  situs?: Situs | null;
  /** Publish-time stamp. `null` = unstamped (the prepare/lookup path). */
  admissionTaxRateBps: number | null;
  promo?: Partial<PromoRecord>;
  taxRateLookup?: { lookupByPostalCode: ReturnType<typeof vi.fn> };
  waiverTickets?: number;
  /** Org membership role of the operator. Default SCANNER. */
  role?: "SCANNER" | "ADMIN" | null;
  /** The org has no Payee row yet (no payout setup). */
  noPayee?: boolean;
  /**
   * A concurrent first cash sale creates the org's payee while this one is
   * mid-transaction: this sale's placeholder insert loses with P2002, and the
   * winner's payee (PAYEE_ID) is there on the next read.
   */
  payeeRace?: boolean;
};

const TICKET_TYPES = [
  { id: GA_ID, priceCents: 2500 },
  { id: VIP_ID, priceCents: 4000 },
];

function makeWorld(scenario: Scenario) {
  const situs = scenario.situs ?? null;
  const callLog: string[] = [];
  let role: "SCANNER" | "ADMIN" | null =
    scenario.role === undefined ? "SCANNER" : scenario.role;

  const event = {
    id: EVENT_ID,
    orgId: "org-1",
    humanId: null,
    title: "Parity Night",
    status: "PUBLISHED" as const,
    visibility: "PUBLIC" as const,
    gateType: "NONE" as const,
    attendanceMode: "TICKETED" as const,
    waiverTemplateId: null,
    startsAt: new Date("2026-04-01T20:00:00.000Z"),
    endsAt: new Date("2026-04-01T23:00:00.000Z"),
    placeId: null,
    savedLocationId: null,
    postalCode: situs?.postalCode ?? null,
    countryCode: situs?.countryCode ?? null,
    region: situs?.region ?? null,
    admissionTaxRateBps: scenario.admissionTaxRateBps,
    taxRateSource: scenario.admissionTaxRateBps == null ? null : "ziptax",
    instructionalAdmission: false,
    timezone: "America/Chicago",
    updatedAt: new Date("2026-02-01T00:00:00.000Z"),
    publishedAt: NOW,
    agreementPrimaryId: TERMS_ID,
    currency: "usd",
    ownerBanned: false,
  };

  const terms = {
    id: TERMS_ID,
    kind: "PRIMARY",
    status: "ACTIVE",
    feeMode: "PASS_THROUGH",
    feePolicyId: POLICY_ID,
    payoutSchedule: "WEEK_OF_EVENT",
    isDefault: false,
    settlementCurrency: "usd",
    version: 3,
    createdAt: NOW,
    updatedAt: NOW,
  };

  const feePolicy = {
    id: POLICY_ID,
    scopeType: "EVENT",
    scopeId: EVENT_ID,
    status: "ACTIVE",
    version: 7,
    buyerFeePct: 0.05,
    maxFeeCents: null,
    minFeeCents: 0,
    maxPlatformFeeCents: null,
    platformFixedCents: 50,
    feeMode: "PASS_THROUGH",
    processsorFeePct: 0.029,
    processorFixedCents: 30,
    payoutPct: 0,
    payoutFixedCents: 0,
    monthlyPayoutCents: 0,
    effectiveFrom: NOW,
    effectiveTo: null,
  };

  const promo: PromoRecord | null = scenario.promo
    ? ({
        id: "promo-1",
        code: "SAVE",
        codeNormalized: "SAVE",
        status: "ACTIVE",
        kind: "AMOUNT",
        scope: "EVENT",
        scopeId: EVENT_ID,
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
        createdAt: NOW,
        updatedAt: NOW,
        ...scenario.promo,
      } as PromoRecord)
    : null;

  // ── Orders: every createPending is kept, by id ──────────────────────────
  const ordersById = new Map<string, Record<string, any>>();
  const taxLinesByOrder = new Map<string, Array<Record<string, any>>>();
  let lastOrderId: string | null = null;
  let paymentIntentInput: Record<string, any> | null = null;
  let ticketSeq = 0;
  const ticketsByOrder = new Map<string, Array<Record<string, any>>>();

  const ledger = createFakePayeeLedgerRepo();
  let raceLost = false;

  const tx = {
    events: {
      lockRows: vi.fn(async () => undefined),
      getById: vi.fn(async (id: string) => (id === EVENT_ID ? event : null)),
      listTicketTypes: vi.fn(async () =>
        TICKET_TYPES.map((tt) => ({
          id: tt.id,
          name: tt.id,
          priceCents: tt.priceCents,
          status: "ACTIVE" as const,
          capacity: 1000,
          pricingMode: "FIXED" as const,
          minimumCents: null,
          suggestedCents: null,
          seatSectionId: null,
          scheduledPriceCents: null,
          scheduledPriceAt: null,
          salesOpenAt: null,
          salesCloseAt: null,
        })),
      ),
      // The self-heal stamp, compare-and-set like the adapter: it fills only
      // an empty stamp, and a later read sees it.
      fillTaxRateIfUnset: vi.fn(
        async (heal: { admissionTaxRateBps: number; taxRateSource: string }) => {
          if (event.admissionTaxRateBps != null) return false;
          event.admissionTaxRateBps = heal.admissionTaxRateBps;
          event.taxRateSource = heal.taxRateSource;
          return true;
        },
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
      getById: vi.fn(async (id: string) => (id === POLICY_ID ? feePolicy : null)),
    },
    promos: {
      findActiveByCodes: vi.fn(async () => (promo ? [promo] : [])),
      findActiveByIds: vi.fn(async () => []),
      getRedemptionStats: vi.fn(async () => ({
        totalRedemptions: 0,
        redemptionsForHuman: 0,
      })),
      createHolds: vi.fn(async () => []),
      confirmHoldsForOrder: vi.fn(async () => []),
      releaseHoldsForOrder: vi.fn(async () => undefined),
    },
    feeWaivers: {
      resolveApplicable: vi.fn(async () =>
        (scenario.waiverTickets ?? 0) > 0
          ? [{ id: "waiver-org", ticketsGranted: 10, ticketsUsed: 0 }]
          : [],
      ),
      reserve: vi.fn(async (input: { waivableTicketFeesCents: number[] }) => {
        const n = Math.min(
          scenario.waiverTickets ?? 0,
          input.waivableTicketFeesCents.length,
        );
        return {
          reservedTickets: n,
          feeWaivedCents: input.waivableTicketFeesCents
            .slice(0, n)
            .reduce((sum, c) => sum + c, 0),
          redemptionId: n > 0 ? "redemption-1" : null,
        };
      }),
      settle: vi.fn(async () => ({ settledTickets: 1 })),
      release: vi.fn(async () => ({ releasedTickets: 1 })),
    },
    authz: {
      getOrgMembership: vi.fn(async () =>
        role ? { orgId: "org-1", humanId: OPERATOR_ID, role } : null,
      ),
    },
    humans: {
      getById: vi.fn(async (id: string) =>
        id === OPERATOR_ID
          ? {
              id,
              scannerTermsAckAt: new Date("2026-01-01T00:00:00.000Z"),
              scannerTermsAckVersion: SCANNER_TERMS_VERSION,
            }
          : null,
      ),
      create: vi.fn(async () => ({ id: PHANTOM_ID })),
    },
    tickets: {
      lockAndCountCapacityForTicketType: vi.fn(async () => ({
        issued: 0,
        held: 0,
      })),
      countIssuedForTicketType: vi.fn(async () => 0),
      countCapacityConsumingForTicketType: vi.fn(async () => 0),
      countForOrderTicketType: vi.fn(async () => 0),
      getByOrderItemId: vi.fn(async () => null),
      create: vi.fn(async (input: Record<string, any>) => {
        ticketSeq += 1;
        const ticket = {
          id: `00000000-0000-4000-8000-0000000a${String(ticketSeq).padStart(4, "0")}`,
          code: `CASH-${ticketSeq}`,
          orderItemId: input.orderItemId,
          ticketTypeId: input.ticketTypeId,
          orderId: input.orderId,
          seatId: null,
          status: "VALID",
        };
        const list = ticketsByOrder.get(input.orderId) ?? [];
        list.push(ticket);
        ticketsByOrder.set(input.orderId, list);
        return ticket;
      }),
      markScanned: vi.fn(async () => ({ ok: true, scannedAt: NOW })),
      recordScan: vi.fn(async () => undefined),
      findBySeatIds: vi.fn(async () => []),
      findBySeatIdsIncludingTerminal: vi.fn(async () => []),
      listByOrderId: vi.fn(
        async (orderId: string) => ticketsByOrder.get(orderId) ?? [],
      ),
      setStatus: vi.fn(async () => undefined),
      clearSeatAssignments: vi.fn(async () => undefined),
    },
    seats: {
      updateStatuses: vi.fn(async () => undefined),
      findByIdsForUpdate: vi.fn(async () => []),
      releaseExpiredHolds: vi.fn(async () => 0),
      releaseSeats: vi.fn(async () => 0),
    },
    orderItems: {
      recordReleasedSeats: vi.fn(async () => undefined),
      updateStatus: vi.fn(
        async (
          itemId: string,
          status: string,
          at: Date,
          refundedTaxCents?: number | null,
          refundedPlatformFeeCents?: number | null,
        ) => {
          for (const order of ordersById.values()) {
            const item = (order.items as Array<Record<string, any>>).find(
              (i) => i.id === itemId,
            );
            if (!item) continue;
            Object.assign(item, {
              status,
              refundedAt: at,
              refundedTaxCents: refundedTaxCents ?? null,
              refundedPlatformFeeCents: refundedPlatformFeeCents ?? null,
            });
          }
        },
      ),
    },
    orders: {
      createPending: vi.fn(async (input: Record<string, any>) => {
        callLog.push("createPending");
        const id = (input.id as string | undefined) ?? CARD_ORDER_ID;
        lastOrderId = id;
        ordersById.set(id, {
          ...input,
          id,
          status: "PENDING",
          occurredAt: NOW,
          items: (input.items as any[]).map((item, i) => ({
            id: `${id.slice(0, 30)}${String(i).padStart(6, "0")}`,
            ...item,
            meta: item.meta ?? {},
          })),
        });
        return {
          id,
          amountGrossCents: input.amountGrossCents,
          feesPlatformCents: input.feesPlatformCents,
          currency: input.currency,
        };
      }),
      listTaxLines: vi.fn(
        async (orderId: string) => taxLinesByOrder.get(orderId) ?? [],
      ),
      createTaxLines: vi.fn(
        async (input: { orderId: string; lines: Array<Record<string, any>> }) => {
          taxLinesByOrder.set(input.orderId, input.lines);
        },
      ),
      markSucceeded: vi.fn(async (id: string) => {
        const o = ordersById.get(id);
        if (o) o.status = "SUCCEEDED";
      }),
      markRefunded: vi.fn(async (id: string) => {
        const o = ordersById.get(id);
        if (o) o.status = "REFUNDED";
      }),
      markRefundedIfSucceeded: vi.fn(async (id: string) => {
        const o = ordersById.get(id);
        if (!o || o.status !== "SUCCEEDED") return false;
        o.status = "REFUNDED";
        return true;
      }),
      getById: vi.fn(async (id: string) => ordersById.get(id) ?? null),
      linkPaymentIntent: vi.fn(async () => undefined),
      cancelPendingOrder: vi.fn(async () => true),
    },
    payees: {
      getBySubject: vi.fn(async () =>
        scenario.payeeRace
          ? raceLost
            ? { id: PAYEE_ID }
            : null
          : scenario.noPayee
            ? null
            : { id: PAYEE_ID },
      ),
      upsertForSubject: vi.fn(async () => {
        if (scenario.payeeRace && !raceLost) {
          raceLost = true;
          throw Object.assign(new Error("Unique constraint failed"), {
            code: "P2002",
          });
        }
        return { id: PLACEHOLDER_PAYEE_ID };
      }),
      getById: vi.fn(async () => ({
        id: PAYEE_ID,
        subjectType: "ORGANIZATION",
        subjectId: "org-1",
        status: "ACTIVE",
        payoutsEnabled: true,
        chargesEnabled: true,
        stripeAccountId: "acct_connected",
        defaultCurrency: "usd",
      })),
    },
    payeeLedger: ledger.repo,
    audit: { log: vi.fn(async () => undefined) },
  };

  const repos = {
    ...tx,
    tx: async <T>(fn: (t: TxRepos) => Promise<T>) => {
      callLog.push("tx");
      return fn(tx as unknown as TxRepos);
    },
  } as unknown as Repos;

  const store = new Map<string, unknown>();
  const holds = new Set<string>();
  const idempotency = {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    begin: vi.fn(async (k: string) => {
      if (holds.has(k)) return false;
      holds.add(k);
      return true;
    }),
    commit: vi.fn(async (k: string, v: unknown) => {
      store.set(k, v);
    }),
    fail: vi.fn(async (k: string) => {
      holds.delete(k);
    }),
    release: vi.fn(async () => true),
    run: vi.fn(),
    purgeExpired: async () => 0,
  } as unknown as IdempotencyPort;

  const payments = {
    createCardPresentPaymentIntent: vi.fn(async (input: Record<string, any>) => {
      paymentIntentInput = input;
      return { paymentIntentId: "pi_door_card", clientSecret: "secret_door" };
    }),
    cancelPaymentIntent: vi.fn(async () => ({ canceled: true })),
  } as unknown as PaymentProcessorPort;

  const logger = createTestLogger();
  vi.mocked(logger.child).mockReturnValue(logger);
  const reportError = vi.fn();
  const taxRateLookup = scenario.taxRateLookup ?? null;
  if (taxRateLookup) {
    const inner = taxRateLookup.lookupByPostalCode.getMockImplementation();
    taxRateLookup.lookupByPostalCode.mockImplementation(async (...args) => {
      callLog.push("taxLookup");
      return inner?.(...args);
    });
  }

  const authz = {
    hasStaffRole: vi.fn(async () => ({ allowed: false })),
  } as never;

  return {
    repos,
    tx,
    ledger,
    idempotency,
    payments,
    logger,
    reportError,
    taxRateLookup,
    callLog,
    authz,
    clock: { now: () => NOW },
    setRole(next: "SCANNER" | "ADMIN" | null) {
      role = next;
    },
    order(id?: string) {
      const key = id ?? lastOrderId;
      return key ? (ordersById.get(key) ?? null) : null;
    },
    taxLines(id?: string) {
      const key = id ?? lastOrderId;
      return key ? (taxLinesByOrder.get(key) ?? []) : [];
    },
    get paymentIntent() {
      return paymentIntentInput;
    },
  };
}

type World = ReturnType<typeof makeWorld>;

const CART = [
  { ticketTypeId: GA_ID, qty: 2 },
  { ticketTypeId: VIP_ID, qty: 1 },
];

function cashDeps(w: World) {
  return {
    repos: w.repos,
    authz: w.authz,
    idempotency: w.idempotency,
    clock: w.clock,
    logger: w.logger,
    reportError: w.reportError,
    taxRateLookup: w.taxRateLookup as never,
  };
}

async function sellCash(
  w: World,
  scenario: Scenario,
  amountCollectedCents: number,
  extra: { comp?: boolean; clientKey?: string } = {},
) {
  return recordCashSale(cashDeps(w), {
    actorHumanId: OPERATOR_ID,
    eventId: EVENT_ID,
    clientKey: extra.clientKey ?? "parity-cash-key",
    items: CART,
    amountCollectedCents,
    ...(extra.comp !== undefined ? { comp: extra.comp } : {}),
    ...(scenario.promo ? { promoCodes: ["save"] } : {}),
  });
}

async function sellCard(scenario: Scenario) {
  const w = makeWorld(scenario);
  await startPosSale(
    {
      repos: w.repos,
      authz: w.authz,
      payments: w.payments,
      idempotency: w.idempotency,
      clock: w.clock,
      logger: w.logger,
      reportError: w.reportError,
      taxRateLookup: w.taxRateLookup as never,
    },
    {
      actorHumanId: OPERATOR_ID,
      eventId: EVENT_ID,
      clientKey: "parity-card-key",
      items: CART,
      ...(scenario.promo ? { promoCodes: ["save"] } : {}),
    },
  );
  return w;
}

type Pinned = {
  amountGrossCents: number;
  feesPlatformCents: number;
  taxAmountCents: number;
  chargeTotalCents: number;
  itemBuyerTotalCents: number[];
  taxLines: Array<[string, number, number]>;
};

// Cash: ticket + tax, NO platform fee and NO processing fee (owner ruling
// 2026-10-08); tax re-solved on the face. Card equivalents
// (door-card-parity.test.ts PINNED) in comments; the card side is unchanged.
// Before the ruling cash also carried the 600 platform fee (TN was
// 9000 + 600 + round(9.75% × 9600) = 936 → 10536).
const CASH: Record<
  "TN" | "MPLS" | "ST_PAUL" | "OR" | "TN_WAIVER" | "TN_PROMO",
  Pinned & { cardChargeTotalCents: number; cardProcessorFeeCents: number }
> = {
  // 9000 × 9.75% = 877.5 → 878. Card: 9947 × 9.75% = 970, + 600 fee + 347 processing.
  TN: {
    amountGrossCents: 9000,
    feesPlatformCents: 0,
    taxAmountCents: 878,
    chargeTotalCents: 9878,
    itemBuyerTotalCents: [2500, 2500, 4000],
    taxLines: [["SALES", 9000, 878]],
    cardChargeTotalCents: 10917,
    cardProcessorFeeCents: 347,
  },
  // State line 9000 × 9.03% = 812.7 → 813; city line 9000 × 3% = 270.
  MPLS: {
    amountGrossCents: 9000,
    feesPlatformCents: 0,
    taxAmountCents: 1083,
    chargeTotalCents: 10083,
    itemBuyerTotalCents: [2500, 2500, 4000],
    taxLines: [
      ["SALES", 9000, 813],
      ["TEST_MPLS_ENTERTAINMENT", 9000, 270],
    ],
    cardChargeTotalCents: 11122,
    cardProcessorFeeCents: 353,
  },
  // 9000 × 8.88% = 799.2 → 799.
  ST_PAUL: {
    amountGrossCents: 9000,
    feesPlatformCents: 0,
    taxAmountCents: 799,
    chargeTotalCents: 9799,
    itemBuyerTotalCents: [2500, 2500, 4000],
    taxLines: [["SALES", 9000, 799]],
    cardChargeTotalCents: 10827,
    cardProcessorFeeCents: 344,
  },
  // No tax, no fee: the face alone, and nothing owed (no debit).
  OR: {
    amountGrossCents: 9000,
    feesPlatformCents: 0,
    taxAmountCents: 0,
    chargeTotalCents: 9000,
    itemBuyerTotalCents: [2500, 2500, 4000],
    taxLines: [],
    cardChargeTotalCents: 9918,
    cardProcessorFeeCents: 318,
  },
  // The organiser has a fee-waiver allowance. The CARD sale uses it (the
  // VIP's $2.50 fee is waived); cash has no fee to waive, reserves nothing,
  // and prices exactly as TN.
  TN_WAIVER: {
    amountGrossCents: 9000,
    feesPlatformCents: 0,
    taxAmountCents: 878,
    chargeTotalCents: 9878,
    itemBuyerTotalCents: [2500, 2500, 4000],
    taxLines: [["SALES", 9000, 878]],
    cardChargeTotalCents: 10634,
    cardProcessorFeeCents: 339,
  },
  // $5 off: gross 8500. 8500 × 9.75% = 828.75 → 829. Each ticket's buyer
  // total stays its face; the −500 discount item carries the cut.
  TN_PROMO: {
    amountGrossCents: 8500,
    feesPlatformCents: 0,
    taxAmountCents: 829,
    chargeTotalCents: 9329,
    itemBuyerTotalCents: [2500, 2500, 4000],
    taxLines: [["SALES", 8500, 829]],
    cardChargeTotalCents: 10351,
    cardProcessorFeeCents: 331,
  },
};

const MATRIX: Array<{
  name: string;
  scenario: Scenario;
  rules?: LocalTaxImpositionRule[];
  expected: (typeof CASH)[keyof typeof CASH];
}> = [
  {
    name: "TN, Nashville (buyer-total base)",
    scenario: { situs: NASHVILLE, admissionTaxRateBps: 975 },
    expected: CASH.TN,
  },
  {
    name: "MN, Minneapolis (state line + city entertainment line)",
    scenario: { situs: MINNEAPOLIS, admissionTaxRateBps: 903 },
    rules: [MPLS_LINE],
    expected: CASH.MPLS,
  },
  {
    name: "MN, St Paul (no city line)",
    scenario: { situs: ST_PAUL, admissionTaxRateBps: 888 },
    rules: [MPLS_LINE],
    expected: CASH.ST_PAUL,
  },
  {
    name: "OR, Portland (no sales tax)",
    scenario: { situs: PORTLAND, admissionTaxRateBps: 0 },
    expected: CASH.OR,
  },
  {
    name: "TN with an organiser fee waiver on one ticket",
    scenario: { situs: NASHVILLE, admissionTaxRateBps: 975, waiverTickets: 1 },
    expected: CASH.TN_WAIVER,
  },
  {
    name: "TN with a $5 promo",
    scenario: {
      situs: NASHVILLE,
      admissionTaxRateBps: 975,
      promo: { value: 500 },
    },
    expected: CASH.TN_PROMO,
  },
];

function ticketBuyerTotals(order: Record<string, any>): unknown[] {
  return (order.items as Array<Record<string, any>>)
    .filter((i) => i.kind === "ticket")
    .map((i) => i.meta.buyerTotalCents);
}

async function withRules<T>(
  rules: LocalTaxImpositionRule[] | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  localTaxRules.rules = rules ?? [];
  try {
    return await fn();
  } finally {
    localTaxRules.rules = [];
  }
}

describe("NFR-001 / FR-003: a door cash sale = the card sale's face + tax, no fees, tax re-solved", () => {
  for (const row of MATRIX) {
    it(row.name, async () => {
      await withRules(row.rules, async () => {
        const card = await sellCard(row.scenario);
        const cardOrder = card.order()!;

        const w = makeWorld(row.scenario);
        // Hand over $10 more than the total: the change comes back.
        const result = await sellCash(
          w,
          row.scenario,
          row.expected.chargeTotalCents + 1000,
        );
        const order = w.order()!;

        // Same face as the card sale; the card pays a platform fee, cash none.
        expect(order.amountGrossCents).toBe(cardOrder.amountGrossCents);
        expect(cardOrder.feesPlatformCents).toBeGreaterThan(0);
        expect(order.feesPlatformCents).toBe(0);
        // The card charge, for the record (pinned in door-card-parity).
        expect(card.paymentIntent!.amountCents).toBe(
          row.expected.cardChargeTotalCents,
        );
        expect(
          card.paymentIntent!.amountCents -
            cardOrder.amountGrossCents -
            cardOrder.feesPlatformCents -
            cardOrder.taxAmountCents,
        ).toBe(row.expected.cardProcessorFeeCents);

        // The cash sale, pinned.
        expect({
          amountGrossCents: order.amountGrossCents,
          feesPlatformCents: order.feesPlatformCents,
          taxAmountCents: order.taxAmountCents,
          chargeTotalCents: result.amountCents,
          itemBuyerTotalCents: ticketBuyerTotals(order),
          taxLines: w
            .taxLines()
            .map((l) => [l.code, l.taxableAmountCents, l.amountCents]),
        }).toEqual({
          amountGrossCents: row.expected.amountGrossCents,
          feesPlatformCents: row.expected.feesPlatformCents,
          taxAmountCents: row.expected.taxAmountCents,
          chargeTotalCents: row.expected.chargeTotalCents,
          itemBuyerTotalCents: row.expected.itemBuyerTotalCents,
          taxLines: row.expected.taxLines,
        });

        // No fee of either kind on a cash sale: the total is exactly face + tax.
        expect(result.amountCents).toBe(
          order.amountGrossCents + order.taxAmountCents,
        );
        // And no fee or processor-fee share anywhere on the items.
        for (const item of order.items as Array<Record<string, any>>) {
          expect(item.meta.processorFeeShareCents).toBeUndefined();
          if (item.kind === "ticket") {
            expect(item.meta.platformFeePerTicketCents).toBe(0);
          }
        }
        // completePosSale / refunds read the cash total from the order.
        expect(computeExpectedPaymentAmount(order as never)).toBe(
          result.amountCents,
        );
        // The same situs and source the card sale stamped.
        expect([
          order.taxSitusCountry,
          order.taxSitusState,
          order.taxSitusPostal,
          order.taxRateSource,
        ]).toEqual([
          cardOrder.taxSitusCountry,
          cardOrder.taxSitusState,
          cardOrder.taxSitusPostal,
          cardOrder.taxRateSource,
        ]);
        // The snapshot records the POLICY (it stays); the fee charged is the
        // order's `feesPlatformCents`, 0 above.
        expect(order.feePolicySnapshot).toEqual(cardOrder.feePolicySnapshot);
        expect(order.paymentChannel).toBe("CASH");
        expect(order.status).toBe("SUCCEEDED");
        // Σ PLATFORM tax lines === the order's tax.
        expect(
          w
            .taxLines()
            .filter((l) => l.collector === "PLATFORM")
            .reduce((s, l) => s + (l.amountCents as number), 0),
        ).toBe(order.taxAmountCents);

        // The output: change, and the split the till shows.
        expect(result).toMatchObject({
          amountCents: row.expected.chargeTotalCents,
          amountCollectedCents: row.expected.chargeTotalCents + 1000,
          changeCents: 1000,
          expectedDueCents: row.expected.chargeTotalCents,
          feesPlatformCents: row.expected.feesPlatformCents,
          taxAmountCents: row.expected.taxAmountCents,
          isComp: false,
          ticketCount: 3,
        });

        // FR-004: ONE ledger debit of the TAX only, on the org's payee, keyed
        // by the order. A tax-free sale owes nothing and writes none.
        if (row.expected.taxAmountCents === 0) {
          expect(w.ledger.entries).toHaveLength(0);
          expect(w.tx.payees.getBySubject).not.toHaveBeenCalled();
        } else {
          expect(w.ledger.entries).toHaveLength(1);
          expect(w.ledger.entries[0]).toMatchObject({
            type: "CASH_SALE_DEBIT",
            payeeId: PAYEE_ID,
            amountCents: row.expected.taxAmountCents,
            currency: "usd",
            orderId: order.id,
            idempotencyKey: `cash-sale-debit:${order.id}`,
            availableAt: null,
          });
        }

        // The tax lookup never ran (stamped events), and nothing was reported.
        expect(w.reportError).not.toHaveBeenCalled();
      });
    });
  }

  it("a cash sale neither reserves nor settles a fee waiver, even with allowance left: there is no fee to waive", async () => {
    const w = makeWorld({
      situs: NASHVILLE,
      admissionTaxRateBps: 975,
      waiverTickets: 1,
    });
    const result = await sellCash(w, {}, CASH.TN_WAIVER.chargeTotalCents);
    expect(result.feesPlatformCents).toBe(0);
    expect(w.tx.feeWaivers.resolveApplicable).not.toHaveBeenCalled();
    expect(w.tx.feeWaivers.reserve).not.toHaveBeenCalled();
    expect(w.tx.feeWaivers.settle).not.toHaveBeenCalled();
    // The card sale of the same cart still spends it (allowance kept for it).
    const card = await sellCard({
      situs: NASHVILLE,
      admissionTaxRateBps: 975,
      waiverTickets: 1,
    });
    expect(card.tx.feeWaivers.reserve).toHaveBeenCalledTimes(1);
  });
});

describe("FR-003 / R4: the typed amount only works out change", () => {
  const scenario: Scenario = { situs: NASHVILLE, admissionTaxRateBps: 975 };

  it("exactly the total: no change", async () => {
    const w = makeWorld(scenario);
    const result = await sellCash(w, scenario, CASH.TN.chargeTotalCents);
    expect(result.changeCents).toBe(0);
    expect(result.amountCents).toBe(CASH.TN.chargeTotalCents);
  });

  it("one cent short is REFUSED with CASH_AMOUNT_SHORT and the required total in meta — no order, no ticket, no debit", async () => {
    const w = makeWorld(scenario);
    await expect(
      sellCash(w, scenario, CASH.TN.chargeTotalCents - 1),
    ).rejects.toMatchObject({
      code: "CASH_AMOUNT_SHORT",
      meta: {
        requiredTotalCents: CASH.TN.chargeTotalCents,
        amountCollectedCents: CASH.TN.chargeTotalCents - 1,
        shortByCents: 1,
        currency: "usd",
      },
    });
    expect(w.tx.orders.createPending).not.toHaveBeenCalled();
    expect(w.tx.tickets.create).not.toHaveBeenCalled();
    expect(w.ledger.entries).toHaveLength(0);
    // The claim is released so the operator can retry with the right amount.
    expect(w.idempotency.fail).toHaveBeenCalled();
  });

  it("the old till behaviour — sending the FACE total ($90) — is refused on a taxed cart", async () => {
    const w = makeWorld(scenario);
    await expect(sellCash(w, scenario, 9000)).rejects.toMatchObject({
      code: "CASH_AMOUNT_SHORT",
      meta: { requiredTotalCents: CASH.TN.chargeTotalCents },
    });
  });

  it("`comp: false` with $0 is a paid sale, refused as short", async () => {
    const w = makeWorld(scenario);
    await expect(
      sellCash(w, scenario, 0, { comp: false }),
    ).rejects.toMatchObject({ code: "CASH_AMOUNT_SHORT" });
  });
});

describe("FR-005: a comp is $0, no fee, no tax, no debit, no pricing, no lookup", () => {
  // Unstamped event with a provider that FAILS: any lookup would refuse.
  const failingLookup = () =>
    vi.fn(async () => {
      throw new TaxRateLookupError("should never be called", {
        providerCode: 108,
        httpStatus: 429,
      });
    });

  for (const variant of [
    { name: "explicit `comp: true`", comp: true as boolean | undefined },
    { name: "$0 with `comp` unset (the signal today's tills send)", comp: undefined },
  ]) {
    it(variant.name, async () => {
      const lookupByPostalCode = failingLookup();
      const scenario: Scenario = {
        situs: NASHVILLE,
        admissionTaxRateBps: null,
        taxRateLookup: { lookupByPostalCode },
      };
      const w = makeWorld(scenario);
      const result = await sellCash(w, scenario, 0, {
        ...(variant.comp !== undefined ? { comp: variant.comp } : {}),
      });

      expect(result).toMatchObject({
        isComp: true,
        amountCents: 0,
        changeCents: 0,
        feesPlatformCents: 0,
        taxAmountCents: 0,
        expectedDueCents: 0,
        ticketCount: 3,
      });
      const order = w.order()!;
      expect(order).toMatchObject({
        amountGrossCents: 0,
        feesPlatformCents: 0,
        taxAmountCents: 0,
        paymentChannel: "CASH",
        status: "SUCCEEDED",
      });
      for (const item of order.items as Array<Record<string, any>>) {
        expect(item.amountCents).toBe(0);
        expect(item.unitPriceCents).toBe(0);
      }
      expect(computeExpectedPaymentAmount(order as never)).toBe(0);
      expect(w.tx.orders.createTaxLines).not.toHaveBeenCalled();
      expect(w.ledger.entries).toHaveLength(0);
      // No pricing pipeline, no waiver, no lookup.
      expect(lookupByPostalCode).not.toHaveBeenCalled();
      expect(w.tx.payoutTerms.listByEvent).not.toHaveBeenCalled();
      expect(w.tx.feeWaivers.reserve).not.toHaveBeenCalled();
      expect(w.tx.promos.createHolds).not.toHaveBeenCalled();
    });
  }

  it("$0 with `comp` unset but a 100%-off promo code is a PAID sale: the code is redeemed", async () => {
    // "First 10 free": the code must be spent and counted at the door too.
    const scenario: Scenario = {
      situs: NASHVILLE,
      admissionTaxRateBps: 975,
      promo: { kind: "PERCENT", value: 100 },
    };
    const w = makeWorld(scenario);
    const result = await sellCash(w, scenario, 0);

    expect(result).toMatchObject({
      isComp: false,
      amountCents: 0,
      changeCents: 0,
      feesPlatformCents: 0,
      taxAmountCents: 0,
      discountCents: 9000,
    });
    // The redemption ran: held and confirmed against this order.
    expect(w.tx.promos.createHolds).toHaveBeenCalledTimes(1);
    expect(w.tx.promos.confirmHoldsForOrder).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: w.order()!.id }),
    );
    expect(w.order()!.amountGrossCents).toBe(0);
    // $0 owed: nothing to debit.
    expect(w.ledger.entries).toHaveLength(0);
  });

  it("$0 with `comp` unset, a promo code, and a cart the code does NOT cover is refused as short, not comped", async () => {
    const scenario: Scenario = {
      situs: NASHVILLE,
      admissionTaxRateBps: 975,
      promo: { value: 500 },
    };
    const w = makeWorld(scenario);
    await expect(sellCash(w, scenario, 0)).rejects.toMatchObject({
      code: "CASH_AMOUNT_SHORT",
      meta: { requiredTotalCents: CASH.TN_PROMO.chargeTotalCents },
    });
    expect(w.tx.orders.createPending).not.toHaveBeenCalled();
  });

  it("`comp: true` with cash collected is refused before anything runs", async () => {
    const w = makeWorld({ situs: NASHVILLE, admissionTaxRateBps: 975 });
    await expect(
      sellCash(w, {}, 500, { comp: true }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(w.callLog).not.toContain("tx");
    expect(w.idempotency.begin).not.toHaveBeenCalled();
  });
});

describe("door cash tax lookup (FR-006, NFR-002, NFR-003, owner ruling R5)", () => {
  it("a failed lookup refuses with TAX_RATE_UNAVAILABLE — no transaction, no order, no debit — and reports once", async () => {
    const lookupByPostalCode = vi.fn(async () => {
      throw new TaxRateLookupError(
        "Ziptax rCode 108 (RESPONSE_CODE_REQUEST_LIMIT_MET)",
        { providerCode: 108, httpStatus: 429 },
      );
    });
    const scenario: Scenario = {
      situs: NASHVILLE,
      admissionTaxRateBps: null,
      taxRateLookup: { lookupByPostalCode },
    };
    const w = makeWorld(scenario);

    await expect(sellCash(w, scenario, 20_000)).rejects.toMatchObject({
      code: "TAX_RATE_UNAVAILABLE",
    });

    // Retried, as online and the card till (3 attempts), then refused.
    expect(lookupByPostalCode).toHaveBeenCalledTimes(3);
    expect(w.callLog).not.toContain("tx");
    expect(w.order()).toBeNull();
    expect(w.ledger.entries).toHaveLength(0);
    // NFR-003: the refusal reaches Sentry, once.
    expect(
      w.reportError.mock.calls.filter(
        ([, ctx]) =>
          (ctx as { tags?: { useCase?: string } }).tags?.useCase ===
          "checkoutTaxRateUnavailable",
      ),
    ).toHaveLength(1);
  });

  it("an unstamped event is looked up BEFORE the transaction and charged at that rate", async () => {
    const lookupByPostalCode = vi.fn(async () => ({
      rateBps: 975,
      source: "ziptax",
    }));
    const scenario: Scenario = {
      situs: NASHVILLE,
      admissionTaxRateBps: null,
      taxRateLookup: { lookupByPostalCode },
    };
    const w = makeWorld(scenario);
    const result = await sellCash(w, scenario, CASH.TN.chargeTotalCents);

    expect(lookupByPostalCode).toHaveBeenCalledTimes(1);
    expect(w.callLog.indexOf("taxLookup")).toBeLessThan(w.callLog.indexOf("tx"));
    expect(w.order()!.taxAmountCents).toBe(CASH.TN.taxAmountCents);
    expect(result.amountCents).toBe(CASH.TN.chargeTotalCents);
  });

  it("a short refusal keeps the rate it paid for: the retry does not look up again", async () => {
    const lookupByPostalCode = vi.fn(async () => ({
      rateBps: 975,
      source: "ziptax",
    }));
    const scenario: Scenario = {
      situs: NASHVILLE,
      admissionTaxRateBps: null,
      taxRateLookup: { lookupByPostalCode },
    };
    const w = makeWorld(scenario);

    // The operator types the face total; the sale is refused.
    await expect(sellCash(w, scenario, 9000)).rejects.toMatchObject({
      code: "CASH_AMOUNT_SHORT",
      meta: { requiredTotalCents: CASH.TN.chargeTotalCents },
    });
    expect(lookupByPostalCode).toHaveBeenCalledTimes(1);
    // Stamped outside the rolled-back transaction, as a committed sale does.
    expect(w.tx.events.fillTaxRateIfUnset).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: EVENT_ID, admissionTaxRateBps: 975 }),
    );

    // The retry with the right amount: same rate, no second lookup.
    const result = await sellCash(w, scenario, CASH.TN.chargeTotalCents);
    expect(result.amountCents).toBe(CASH.TN.chargeTotalCents);
    expect(lookupByPostalCode).toHaveBeenCalledTimes(1);
    expect(w.reportError).not.toHaveBeenCalled();
  });

  it("an operator with no role on the org is refused BEFORE any paid lookup", async () => {
    const lookupByPostalCode = vi.fn(async () => ({
      rateBps: 975,
      source: "ziptax",
    }));
    const scenario: Scenario = {
      situs: NASHVILLE,
      admissionTaxRateBps: null,
      taxRateLookup: { lookupByPostalCode },
      role: null,
    };
    const w = makeWorld(scenario);
    await expect(
      sellCash(w, scenario, CASH.TN.chargeTotalCents),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(lookupByPostalCode).not.toHaveBeenCalled();
    expect(w.callLog).not.toContain("tx");
  });
});

describe("R6: payout setup is not required to sell cash", () => {
  it("an org with no Payee gets a PENDING placeholder, and the debit lands on it", async () => {
    const scenario: Scenario = {
      situs: NASHVILLE,
      admissionTaxRateBps: 975,
      noPayee: true,
    };
    const w = makeWorld(scenario);
    await sellCash(w, scenario, CASH.TN.chargeTotalCents);

    expect(w.tx.payees.upsertForSubject).toHaveBeenCalledWith({
      subjectType: "ORGANIZATION",
      subjectId: "org-1",
    });
    expect(w.ledger.entries).toHaveLength(1);
    expect(w.ledger.entries[0]).toMatchObject({
      type: "CASH_SALE_DEBIT",
      payeeId: PLACEHOLDER_PAYEE_ID,
      amountCents: CASH.TN.taxAmountCents,
    });
    // Expected, not an error: logged at info, never reported.
    expect(w.logger.info).toHaveBeenCalledWith(
      "pos.cash_sale.placeholder_payee_created",
      expect.objectContaining({ payeeId: PLACEHOLDER_PAYEE_ID }),
    );
    expect(w.reportError).not.toHaveBeenCalled();
  });
});

describe("R6: two first cash sales at once (the placeholder payee race)", () => {
  it("the loser's P2002 rolls its transaction back; it retries once and debits the winner's payee", async () => {
    const scenario: Scenario = {
      situs: NASHVILLE,
      admissionTaxRateBps: 975,
      payeeRace: true,
    };
    const w = makeWorld(scenario);
    const result = await sellCash(w, scenario, CASH.TN.chargeTotalCents);

    expect(result.amountCents).toBe(CASH.TN.chargeTotalCents);
    expect(w.callLog.filter((c) => c === "tx")).toHaveLength(2);
    expect(w.tx.payees.upsertForSubject).toHaveBeenCalledTimes(1);
    expect(w.ledger.entries).toHaveLength(1);
    expect(w.ledger.entries[0]).toMatchObject({
      type: "CASH_SALE_DEBIT",
      payeeId: PAYEE_ID,
      orderId: result.orderId,
      amountCents: CASH.TN.taxAmountCents,
    });
    // The retry found the payee; it created nothing.
    expect(w.logger.info).not.toHaveBeenCalledWith(
      "pos.cash_sale.placeholder_payee_created",
      expect.anything(),
    );
  });

  it("a unique violation from anywhere else is NOT retried", async () => {
    const scenario: Scenario = { situs: NASHVILLE, admissionTaxRateBps: 975 };
    const w = makeWorld(scenario);
    w.tx.tickets.create.mockRejectedValueOnce(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );
    await expect(
      sellCash(w, scenario, CASH.TN.chargeTotalCents),
    ).rejects.toBeDefined();
    expect(w.callLog.filter((c) => c === "tx")).toHaveLength(1);
  });
});

describe("FR-008: a cash gate refund returns what the buyer paid and reverses the debit as recorded", () => {
  it("full total back, one reversal, balance restored; a second refund changes nothing", async () => {
    const scenario: Scenario = {
      situs: NASHVILLE,
      admissionTaxRateBps: 975,
      waiverTickets: 1,
    };
    const w = makeWorld(scenario);
    const sale = await sellCash(w, scenario, CASH.TN_WAIVER.chargeTotalCents);
    const orderId = sale.orderId;

    // Refund authority is ORG_EDIT_ROLES, above the scanner who sold.
    w.setRole("ADMIN");
    const refundDeps = { repos: w.repos, clock: w.clock, logger: w.logger };
    const refund = await refundCashSale(refundDeps, {
      actorHumanId: OPERATOR_ID,
      orderId,
    });

    expect(refund.amountReturnedCents).toBe(CASH.TN_WAIVER.chargeTotalCents);
    expect(refund.refundedTicketCount).toBe(3);
    // Every ticket item is stamped with what it gave back, as the card
    // refund stamps: Σ fee shares = the order's fee, Σ tax shares = its tax.
    const stamped = (w.order(orderId)!.items as Array<Record<string, any>>)
      .filter((i) => i.kind === "ticket");
    expect(stamped).toHaveLength(3);
    for (const item of stamped) {
      expect(item.status).toBe("refunded");
      expect(item.refundedPlatformFeeCents).not.toBeNull();
    }
    expect(
      stamped.map((i) => [i.refundedPlatformFeeCents, i.refundedTaxCents]),
    ).toEqual([
      // No platform fee on a cash sale: 0 fee stamped on every item. Tax 878
      // split by what each buyer paid, 2500 : 2500 : 4000 of 9000 →
      // 243.89 / 243.89 / 390.22: floors 243 / 243 / 390 = 876, and the 2
      // leftover cents go to the largest remainders (the two GA tickets).
      [0, 244],
      [0, 244],
      [0, 390],
    ]);
    expect(
      stamped.reduce((s, i) => s + (i.refundedPlatformFeeCents as number), 0),
    ).toBe(CASH.TN_WAIVER.feesPlatformCents);
    expect(
      stamped.reduce((s, i) => s + (i.refundedTaxCents as number), 0),
    ).toBe(CASH.TN_WAIVER.taxAmountCents);
    expect(w.order(orderId)!.status).toBe("REFUNDED");
    expect(w.tx.feeWaivers.release).toHaveBeenCalledWith(orderId);

    const debit = w.ledger.entriesOfType("CASH_SALE_DEBIT");
    const reversal = w.ledger.entriesOfType("CASH_SALE_DEBIT_REVERSAL");
    expect(debit).toHaveLength(1);
    expect(reversal).toHaveLength(1);
    expect(reversal[0]).toMatchObject({
      payeeId: PAYEE_ID,
      amountCents: debit[0]!.amountCents,
      orderId,
      relatedEntryId: debit[0]!.id,
      idempotencyKey: `cash-sale-debit-reversal:${orderId}`,
    });
    // Debit + reversal net to zero through the ledger's own sign table.
    const net = w.ledger.entries.reduce(
      (sum, e) =>
        sum +
        ledgerEntryBalanceDeltaCents({
          type: e.type,
          amountCents: e.amountCents,
          idempotencyKey: e.idempotencyKey,
          relatedEntryType: null,
        }),
      0,
    );
    expect(net).toBe(0);

    // Idempotent: the order is REFUNDED, the same total comes back, and no
    // second reversal is written.
    const again = await refundCashSale(refundDeps, {
      actorHumanId: OPERATOR_ID,
      orderId,
    });
    expect(again.amountReturnedCents).toBe(CASH.TN_WAIVER.chargeTotalCents);
    expect(w.ledger.entriesOfType("CASH_SALE_DEBIT_REVERSAL")).toHaveLength(1);
  });

  it("a two-line tax (Minneapolis) is stamped per line, and the stamps add up to the order", async () => {
    const scenario: Scenario = { situs: MINNEAPOLIS, admissionTaxRateBps: 903 };
    await withRules([MPLS_LINE], async () => {
      const w = makeWorld(scenario);
      const sale = await sellCash(w, scenario, CASH.MPLS.chargeTotalCents);
      w.setRole("ADMIN");
      const refund = await refundCashSale(
        { repos: w.repos, clock: w.clock, reportError: w.reportError },
        { actorHumanId: OPERATOR_ID, orderId: sale.orderId },
      );
      expect(refund.amountReturnedCents).toBe(CASH.MPLS.chargeTotalCents);
      const stamped = (
        w.order(sale.orderId)!.items as Array<Record<string, any>>
      ).filter((i) => i.kind === "ticket");
      expect(
        stamped.reduce((s, i) => s + (i.refundedTaxCents as number), 0),
      ).toBe(CASH.MPLS.taxAmountCents);
      expect(
        stamped.reduce((s, i) => s + (i.refundedPlatformFeeCents as number), 0),
      ).toBe(CASH.MPLS.feesPlatformCents);
      // The lines reconcile: nothing reported.
      expect(w.reportError).not.toHaveBeenCalled();
    });
  });

  it("a cash sale recorded BEFORE the 2026-10-08 ruling (fee + tax debited) is refunded in full and its whole debit reversed, as recorded", async () => {
    // Seeded as the pre-ruling recordCashSale wrote it: TN 2 × $25 + 1 × $40,
    // 600 platform fee, tax round(9.75% × 9600) = 936, total 10536, one
    // CASH_SALE_DEBIT of 600 + 936 = 1536.
    const w = makeWorld({ situs: NASHVILLE, admissionTaxRateBps: 975 });
    const orderId = "88888888-8888-4888-8888-888888888888";
    const legacyItems = [
      { id: GA_ID, face: 2500, fee: 175 },
      { id: GA_ID, face: 2500, fee: 175 },
      { id: VIP_ID, face: 4000, fee: 250 },
    ].map((t) => ({
      kind: "ticket",
      ticketTypeId: t.id,
      qty: 1,
      unitPriceCents: t.face,
      amountCents: t.face,
      meta: {
        buyerTotalCents: t.face + t.fee,
        buyerUnitTotalCents: t.face + t.fee,
        platformFeePerTicketCents: t.fee,
        effectiveFeeMode: "PASS_THROUGH",
      },
    }));
    await w.tx.orders.createPending({
      id: orderId,
      eventId: EVENT_ID,
      amountGrossCents: 9000,
      feesPlatformCents: 600,
      taxAmountCents: 936,
      currency: "usd",
      paymentChannel: "CASH",
      items: legacyItems,
    });
    await w.tx.orders.createTaxLines({
      orderId,
      lines: [
        {
          code: "SALES",
          label: "Sales tax",
          base: "BUYER_TOTAL",
          collector: "PLATFORM",
          rateBps: 975,
          taxableAmountCents: 9600,
          amountCents: 936,
        },
      ],
    });
    await w.tx.orders.markSucceeded(orderId);
    for (const item of w.order(orderId)!.items as Array<Record<string, any>>) {
      await w.tx.tickets.create({
        orderId,
        orderItemId: item.id,
        ticketTypeId: item.ticketTypeId,
      });
    }
    await w.ledger.repo.cashSaleDebit({
      idempotencyKey: `cash-sale-debit:${orderId}`,
      payeeId: PAYEE_ID,
      amountCents: 1536,
      currency: "usd",
      orderId,
      description: "Door cash sale — platform fee and tax (pre-ruling)",
      sourceKind: "pos_cash_sale",
      sourceId: orderId,
    });

    w.setRole("ADMIN");
    const refund = await refundCashSale(
      { repos: w.repos, clock: w.clock, reportError: w.reportError },
      { actorHumanId: OPERATOR_ID, orderId },
    );

    // The buyer gets back what they paid then: face + fee + tax.
    expect(refund.amountReturnedCents).toBe(10536);
    // The reversal is the debit AS RECORDED (fee + tax), not today's rule.
    const reversal = w.ledger.entriesOfType("CASH_SALE_DEBIT_REVERSAL");
    expect(reversal).toHaveLength(1);
    expect(reversal[0]).toMatchObject({ amountCents: 1536, payeeId: PAYEE_ID });
    const stamped = (
      w.order(orderId)!.items as Array<Record<string, any>>
    ).filter((i) => i.kind === "ticket");
    expect(
      stamped.reduce((s, i) => s + (i.refundedPlatformFeeCents as number), 0),
    ).toBe(600);
    expect(
      stamped.reduce((s, i) => s + (i.refundedTaxCents as number), 0),
    ).toBe(936);
  });

  it("refunding a tax-free cash sale returns the face and writes nothing to the ledger (there was no debit)", async () => {
    const scenario: Scenario = { situs: PORTLAND, admissionTaxRateBps: 0 };
    const w = makeWorld(scenario);
    const sale = await sellCash(w, scenario, CASH.OR.chargeTotalCents);
    w.setRole("ADMIN");
    const refund = await refundCashSale(
      { repos: w.repos, clock: w.clock },
      { actorHumanId: OPERATOR_ID, orderId: sale.orderId },
    );
    expect(refund.amountReturnedCents).toBe(9000);
    expect(w.ledger.entries).toHaveLength(0);
  });

  it("refunding a comp writes nothing to the ledger and returns $0", async () => {
    const scenario: Scenario = { situs: NASHVILLE, admissionTaxRateBps: 975 };
    const w = makeWorld(scenario);
    const sale = await sellCash(w, scenario, 0, { comp: true });
    w.setRole("ADMIN");
    const refund = await refundCashSale(
      { repos: w.repos, clock: w.clock },
      { actorHumanId: OPERATOR_ID, orderId: sale.orderId },
    );
    expect(refund.amountReturnedCents).toBe(0);
    expect(w.ledger.entries).toHaveLength(0);
  });
});
