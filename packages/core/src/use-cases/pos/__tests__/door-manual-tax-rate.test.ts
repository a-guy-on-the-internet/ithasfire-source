import { describe, expect, it, vi } from "vitest";

import type { IdempotencyPort } from "@th/ports/idempotency";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { PromoRecord } from "@th/ports/repos/promos";
import { TaxRateLookupError } from "@th/ports/tax-rate-lookup";
import { SCANNER_TERMS_VERSION } from "@th/types";
import { createTestLogger } from "@th/test-utils/fakes/logger";
import { createFakePayeeLedgerRepo } from "@th/test-utils/fakes/payee-ledger";

import { MANUAL_EVENT_TAX_RATE_SOURCE } from "../../../lib/tax/manual-event-tax-rate";
import { setManualEventTaxRate } from "../../events/set-manual-event-tax-rate";
import {
  applyCheckoutTaxSelfHeal,
  prepareCheckoutTax,
} from "../../orders/_shared/resolve-checkout-tax-rate";
import { canEnterManualTaxRate } from "../_shared/manual-tax-rate-hint";
import { recordCashSale } from "../record-cash-sale";
import { startPosSale } from "../start-pos-sale";

/**
 * Owner ruling R5 at the door (spec
 * docs/specs/2026-10-07/door-sales-same-price-and-tax.spec.yaml FR-007): a
 * failed tax lookup refuses the sale; an Owner/Admin/Editor enters the rate
 * by hand (`setManualEventTaxRate`); both door paths then charge EXACTLY
 * that rate, as if it were the provider's stamp; the provider's next answer
 * replaces it, reported when the rates differ; a failed lookup keeps it.
 *
 * The world is a copy of `door-cash-parity.test.ts`'s (same cart: 2 × $25 GA
 * + 1 × $40 VIP; 5% + 50¢ platform fee, 2.9% + 30¢ processing, passed
 * through), with a stateful event stamp. At 9.75% in Nashville the cents are
 * the parity suites' TN row, pinned there and here as literals.
 */
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

type Role = "OWNER" | "ADMIN" | "EDITOR" | "FINANCE" | "SCANNER" | null;

type Situs = { countryCode: string; region: string; postalCode: string };

const NASHVILLE: Situs = { countryCode: "US", region: "TN", postalCode: "37203" };

type Scenario = {
  situs?: Situs | null;
  /** Publish-time stamp. `null` = unstamped (the prepare/lookup path). */
  admissionTaxRateBps: number | null;
  promo?: Partial<PromoRecord>;
  taxRateLookup?: { lookupByPostalCode: ReturnType<typeof vi.fn> };
  waiverTickets?: number;
  /** Org membership role of the operator. Default SCANNER. */
  role?: Role;
  /** Source of the stamp. Default "ziptax" for a stamped event. */
  taxRateSource?: string | null;
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
  let role: Role =
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
    admissionTaxRateBps: scenario.admissionTaxRateBps as number | null,
    taxRateSource: (
      scenario.taxRateSource !== undefined
        ? scenario.taxRateSource
        : scenario.admissionTaxRateBps == null
          ? null
          : "ziptax") as string | null,
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
      // A copy per read, as the adapter returns a fresh DTO.
      getById: vi.fn(async (id: string) =>
        id === EVENT_ID ? { ...event } : null,
      ),
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
      // The manual entry's write and the replacement's compare-and-set, both
      // bumping the row version as Prisma's @updatedAt does.
      updateTaxRate: vi.fn(
        async (input: {
          admissionTaxRateBps: number | null;
          taxRateSource: string | null;
        }) => {
          event.admissionTaxRateBps = input.admissionTaxRateBps;
          event.taxRateSource = input.taxRateSource;
          event.updatedAt = new Date(event.updatedAt.getTime() + 1000);
        },
      ),
      replaceTaxRateIfUnchanged: vi.fn(
        async (input: {
          expected: {
            admissionTaxRateBps: number;
            taxRateSource: string;
            updatedAt: Date;
          };
          admissionTaxRateBps: number;
          taxRateSource: string;
        }) => {
          if (
            event.admissionTaxRateBps !== input.expected.admissionTaxRateBps ||
            event.taxRateSource !== input.expected.taxRateSource ||
            event.updatedAt.getTime() !== input.expected.updatedAt.getTime()
          ) {
            return false;
          }
          event.admissionTaxRateBps = input.admissionTaxRateBps;
          event.taxRateSource = input.taxRateSource;
          event.updatedAt = new Date(event.updatedAt.getTime() + 1000);
          return true;
        },
      ),
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
    searchReindexPending: { mark: vi.fn(async () => undefined) },
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
    event,
    setRole(next: Role) {
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

async function sellCardOn(w: World, clientKey = "manual-card-key") {
  return startPosSale(
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
    { actorHumanId: OPERATOR_ID, eventId: EVENT_ID, clientKey, items: CART },
  );
}

async function enterRate(w: World, rateBps: number) {
  return setManualEventTaxRate(
    {
      repos: w.repos,
      clock: w.clock,
      logger: w.logger,
      reportError: w.reportError,
      taxRateLookup: w.taxRateLookup as never,
    },
    { actorHumanId: OPERATOR_ID, eventId: EVENT_ID, rateBps },
  );
}

/** Provider down: ZipTax's rate-limit answer, every time. */
function failingLookup() {
  return vi.fn(async () => {
    throw new TaxRateLookupError(
      "Ziptax rCode 108 (RESPONSE_CODE_REQUEST_LIMIT_MET)",
      { providerCode: 108, httpStatus: 429 },
    );
  });
}

function answeringLookup(rateBps: number) {
  return vi.fn(async () => ({ rateBps, source: "ziptax" }));
}

function reportsTagged(
  w: World,
  match: { useCase?: string; kind?: string },
): Array<[unknown, { tags?: Record<string, string>; extra?: Record<string, unknown> }]> {
  return (
    w.reportError.mock.calls as unknown as Array<
      [unknown, { tags?: Record<string, string>; extra?: Record<string, unknown> }]
    >
  ).filter(
    ([, ctx]) =>
      (match.useCase === undefined || ctx?.tags?.useCase === match.useCase) &&
      (match.kind === undefined || ctx?.tags?.kind === match.kind),
  );
}

function taxLineTuples(w: World): Array<[string, number, number]> {
  return w
    .taxLines()
    .map((l) => [l.code as string, l.taxableAmountCents as number, l.amountCents as number]);
}

// The parity suites' TN row at 9.75%, as literals (door-cash-parity CASH.TN,
// door-card-parity PINNED.TN). A manual 975 must charge exactly these. Cash
// is face + tax only (owner ruling 2026-10-08: no platform fee on cash):
// 9000 + round(9.75% × 9000) = 9000 + 878 = 9878.
const TN_CASH = {
  amountGrossCents: 9000,
  feesPlatformCents: 0,
  taxAmountCents: 878,
  chargeTotalCents: 9878,
  taxLines: [["SALES", 9000, 878]] as Array<[string, number, number]>,
};
const TN_CARD = {
  amountGrossCents: 9000,
  feesPlatformCents: 600,
  taxAmountCents: 970,
  chargeTotalCents: 10917,
  taxLines: [["SALES", 9947, 970]] as Array<[string, number, number]>,
};

const MANUAL = MANUAL_EVENT_TAX_RATE_SOURCE;

function manualWorld(manualBps: number, lookupByPostalCode: ReturnType<typeof vi.fn>) {
  const scenario: Scenario = {
    situs: NASHVILLE,
    admissionTaxRateBps: manualBps,
    taxRateSource: MANUAL,
    taxRateLookup: { lookupByPostalCode },
  };
  return { scenario, w: makeWorld(scenario) };
}

describe("R5: a failed lookup refuses; an Editor enters the rate; the door charges exactly it", () => {
  it("CASH: refused (a Scanner is told an Editor is needed), entered by an Editor, then sold at 9.75% to the cent", async () => {
    const lookupByPostalCode = failingLookup();
    const scenario: Scenario = {
      situs: NASHVILLE,
      admissionTaxRateBps: null,
      taxRateLookup: { lookupByPostalCode },
    };
    const w = makeWorld(scenario);

    // A Scanner: refused, and may not enter the rate.
    await expect(sellCash(w, scenario, 20_000, { clientKey: "manual-key-k1" })).rejects.toMatchObject({
      code: "TAX_RATE_UNAVAILABLE",
      meta: { canEnterManualTaxRate: false },
    });
    // An Editor: refused too, but may.
    w.setRole("EDITOR");
    await expect(sellCash(w, scenario, 20_000, { clientKey: "manual-key-k2" })).rejects.toMatchObject({
      code: "TAX_RATE_UNAVAILABLE",
      meta: { canEnterManualTaxRate: true },
    });
    expect(w.order()).toBeNull();
    expect(w.ledger.entries).toHaveLength(0);

    const entered = await enterRate(w, 975);
    expect(entered).toEqual({
      eventId: EVENT_ID,
      admissionTaxRateBps: 975,
      taxRateSource: MANUAL,
      changed: true,
    });
    expect(reportsTagged(w, { kind: "manual_rate_entered" })).toHaveLength(1);

    // Back to the Scanner at the till: the sale goes through at the manual rate.
    w.setRole("SCANNER");
    lookupByPostalCode.mockClear();
    const result = await sellCash(w, scenario, TN_CASH.chargeTotalCents, { clientKey: "manual-key-k3" });

    expect(result.amountCents).toBe(9878);
    const order = w.order()!;
    expect(order.amountGrossCents).toBe(9000);
    expect(order.feesPlatformCents).toBe(0);
    expect(order.taxAmountCents).toBe(878);
    expect(order.taxRateSource).toBe(MANUAL);
    expect(taxLineTuples(w)).toEqual(TN_CASH.taxLines);
    expect(w.ledger.entries).toHaveLength(1);
    // The provider was asked ONCE (no retries) and is still down: the manual
    // rate is kept, and that is reported — not refused, not 0%.
    expect(lookupByPostalCode).toHaveBeenCalledTimes(1);
    expect(reportsTagged(w, { useCase: "checkoutManualTaxRateKept" })).toHaveLength(1);
    expect(w.event.admissionTaxRateBps).toBe(975);
    expect(w.event.taxRateSource).toBe(MANUAL);
    expect(w.tx.events.replaceTaxRateIfUnchanged).not.toHaveBeenCalled();
  });

  it("CARD: refused before the entry; after it, the PaymentIntent is 10917 with 970 tax, as a 9.75% stamp", async () => {
    const lookupByPostalCode = failingLookup();
    const scenario: Scenario = {
      situs: NASHVILLE,
      admissionTaxRateBps: null,
      taxRateLookup: { lookupByPostalCode },
      role: "ADMIN",
    };
    const w = makeWorld(scenario);

    await expect(sellCardOn(w, "manual-card-c1")).rejects.toMatchObject({
      code: "TAX_RATE_UNAVAILABLE",
      meta: { canEnterManualTaxRate: true },
    });
    expect(w.paymentIntent).toBeNull();
    expect(w.order()).toBeNull();

    await enterRate(w, 975);
    await sellCardOn(w, "manual-card-c2");

    expect(w.paymentIntent!.amountCents).toBe(10917);
    const order = w.order()!;
    expect(order.amountGrossCents).toBe(9000);
    expect(order.feesPlatformCents).toBe(600);
    expect(order.taxAmountCents).toBe(970);
    expect(order.taxRateSource).toBe(MANUAL);
    expect(taxLineTuples(w)).toEqual(TN_CARD.taxLines);
    expect(w.event.taxRateSource).toBe(MANUAL);
  });

  it("an Owner and an Admin may enter the rate; Finance and a platform admin selling through the override may not", () => {
    expect(canEnterManualTaxRate({ via: "membership", role: "OWNER" })).toBe(true);
    expect(canEnterManualTaxRate({ via: "membership", role: "ADMIN" })).toBe(true);
    expect(canEnterManualTaxRate({ via: "membership", role: "EDITOR" })).toBe(true);
    expect(canEnterManualTaxRate({ via: "membership", role: "SCANNER" })).toBe(false);
    expect(canEnterManualTaxRate({ via: "membership", role: "FINANCE" })).toBe(false);
    expect(canEnterManualTaxRate({ via: "platform_admin", role: "OWNER" })).toBe(false);
    expect(canEnterManualTaxRate(null)).toBe(false);
  });

  it("online checkout's refusal carries no hint: only the door paths add it", async () => {
    const lookupByPostalCode = failingLookup();
    const w = makeWorld({
      situs: NASHVILLE,
      admissionTaxRateBps: null,
      taxRateLookup: { lookupByPostalCode },
    });
    const err = await prepareCheckoutTax(
      {
        repos: w.repos,
        taxRateLookup: w.taxRateLookup as never,
        clock: w.clock,
        sleep: async () => {},
      },
      EVENT_ID,
      w.logger,
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "TAX_RATE_UNAVAILABLE" });
    expect((err as { meta?: unknown }).meta).toBeUndefined();
  });
});

describe("R5: the provider's next answer replaces a manual stamp", () => {

  it("a DIFFERENT rate: the sale charges the looked-up rate, the stamp is replaced, and the platform hears once", async () => {
    const lookupByPostalCode = answeringLookup(975);
    const { scenario, w } = manualWorld(900, lookupByPostalCode);

    const result = await sellCash(w, scenario, TN_CASH.chargeTotalCents, { clientKey: "manual-key-r1" });

    // Charged the provider's 9.75%, not the manual 9%.
    expect(result.amountCents).toBe(9878);
    expect(w.order()!.taxAmountCents).toBe(878);
    expect(w.order()!.taxRateSource).toBe("ziptax");
    expect(w.event.admissionTaxRateBps).toBe(975);
    expect(w.event.taxRateSource).toBe("ziptax");
    const differs = reportsTagged(w, { kind: "manual_rate_replaced_differs" });
    expect(differs).toHaveLength(1);
    expect(differs[0]![1].tags).toMatchObject({ area: "tax" });
    expect(differs[0]![1].extra).toMatchObject({
      eventId: EVENT_ID,
      manualRateBps: 900,
      lookedUpRateBps: 975,
    });

    // The next sale reads the provider's stamp: no lookup, no second report.
    await sellCash(w, scenario, TN_CASH.chargeTotalCents, { clientKey: "manual-key-r2" });
    expect(lookupByPostalCode).toHaveBeenCalledTimes(1);
    expect(reportsTagged(w, { kind: "manual_rate_replaced_differs" })).toHaveLength(1);
    expect(w.tx.events.fillTaxRateIfUnset).not.toHaveBeenCalled();
  });

  it("the SAME rate: replaced (the source is the provider's now), no report", async () => {
    const lookupByPostalCode = answeringLookup(975);
    const { scenario, w } = manualWorld(975, lookupByPostalCode);

    const result = await sellCash(w, scenario, TN_CASH.chargeTotalCents, { clientKey: "manual-key-s1" });

    expect(result.amountCents).toBe(9878);
    expect(w.event.admissionTaxRateBps).toBe(975);
    expect(w.event.taxRateSource).toBe("ziptax");
    expect(reportsTagged(w, { kind: "manual_rate_replaced_differs" })).toHaveLength(0);
  });

  it("CARD: replaced the same way, the PaymentIntent at the looked-up rate", async () => {
    const lookupByPostalCode = answeringLookup(975);
    const { w } = manualWorld(900, lookupByPostalCode);

    await sellCardOn(w);

    expect(w.paymentIntent!.amountCents).toBe(10917);
    expect(w.order()!.taxAmountCents).toBe(970);
    expect(w.event.taxRateSource).toBe("ziptax");
    expect(reportsTagged(w, { kind: "manual_rate_replaced_differs" })).toHaveLength(1);
  });

  it("a FAILED lookup keeps the manual stamp: still charged, never 0%, never refused; card too", async () => {
    const lookupByPostalCode = failingLookup();
    const { scenario, w } = manualWorld(975, lookupByPostalCode);

    const cash = await sellCash(w, scenario, TN_CASH.chargeTotalCents, { clientKey: "manual-key-f1" });
    expect(cash.amountCents).toBe(9878);
    expect(w.order()!.taxAmountCents).toBe(878);

    await sellCardOn(w, "manual-card-f2");
    expect(w.paymentIntent!.amountCents).toBe(10917);
    expect(w.order()!.taxAmountCents).toBe(970);

    // One attempt per sale, no retries; each kept rate reported; no refusal.
    expect(lookupByPostalCode).toHaveBeenCalledTimes(2);
    expect(reportsTagged(w, { useCase: "checkoutManualTaxRateKept" })).toHaveLength(2);
    expect(reportsTagged(w, { useCase: "checkoutTaxRateUnavailable" })).toHaveLength(0);
    expect(w.event.admissionTaxRateBps).toBe(975);
    expect(w.event.taxRateSource).toBe(MANUAL);
  });

  it("a lookup still running at the budget keeps the manual stamp (reported, budget exhausted)", async () => {
    const lookupByPostalCode = vi.fn(
      () => new Promise<never>(() => {}),
    );
    const { w } = manualWorld(975, lookupByPostalCode);

    const prepared = await prepareCheckoutTax(
      {
        repos: w.repos,
        taxRateLookup: w.taxRateLookup as never,
        clock: w.clock,
        reportError: w.reportError,
        taxLookupBudgetMs: 20,
      },
      EVENT_ID,
      w.logger,
      { channel: "door" },
    );

    expect(prepared).toEqual({ refKey: null, prepared: null });
    const kept = reportsTagged(w, { useCase: "checkoutManualTaxRateKept" });
    expect(kept).toHaveLength(1);
    expect(kept[0]![1].extra).toMatchObject({ budgetExhausted: true, manualRateBps: 975 });
  });

  it("no provider configured: the manual stamp is charged and nothing is reported", async () => {
    const scenario: Scenario = {
      situs: NASHVILLE,
      admissionTaxRateBps: 975,
      taxRateSource: MANUAL,
    };
    const w = makeWorld(scenario);

    const result = await sellCash(w, scenario, TN_CASH.chargeTotalCents, { clientKey: "manual-key-n1" });

    expect(result.amountCents).toBe(9878);
    expect(w.order()!.taxRateSource).toBe(MANUAL);
    expect(w.reportError).not.toHaveBeenCalled();
  });

  it("ONLINE reads the same stamp: the checkout prepare looks the manual stamp up too (one event rate everywhere)", async () => {
    const lookupByPostalCode = answeringLookup(975);
    const { w } = manualWorld(900, lookupByPostalCode);

    const prepared = await prepareCheckoutTax(
      {
        repos: w.repos,
        taxRateLookup: w.taxRateLookup as never,
        clock: w.clock,
      },
      EVENT_ID,
      w.logger,
    );

    expect(lookupByPostalCode).toHaveBeenCalledTimes(1);
    expect(prepared.prepared?.stamp).toMatchObject({ rateBps: 975, source: "ziptax" });
  });

  it("a provider stamp is never looked up again (only a manual one is)", async () => {
    const lookupByPostalCode = answeringLookup(800);
    const scenario: Scenario = {
      situs: NASHVILLE,
      admissionTaxRateBps: 975,
      taxRateLookup: { lookupByPostalCode },
    };
    const w = makeWorld(scenario);

    await sellCash(w, scenario, TN_CASH.chargeTotalCents, { clientKey: "manual-key-p1" });

    expect(lookupByPostalCode).not.toHaveBeenCalled();
    expect(w.order()!.taxRateSource).toBe("ziptax");
  });

  it("two sales racing to replace the same manual stamp: one write, one report", async () => {
    const { w } = manualWorld(900, answeringLookup(975));
    const replacement = {
      eventId: EVENT_ID,
      manualRateBps: 900,
      admissionTaxRateBps: 975,
      taxRateSource: "ziptax",
      expectedUpdatedAt: w.event.updatedAt,
      at: NOW,
    };
    const deps = { repos: w.repos, reportError: w.reportError };
    const afterCommit = () => ({
      selfHeal: null,
      locationCache: null,
      manualReplacement: replacement,
    });

    await applyCheckoutTaxSelfHeal(deps, afterCommit(), w.logger);
    await applyCheckoutTaxSelfHeal(deps, afterCommit(), w.logger);

    expect(w.tx.events.replaceTaxRateIfUnchanged).toHaveBeenCalledTimes(2);
    // One reindex mark: only the write that won marks.
    expect(w.tx.searchReindexPending.mark).toHaveBeenCalledTimes(1);
    expect(w.event.taxRateSource).toBe("ziptax");
    expect(reportsTagged(w, { kind: "manual_rate_replaced_differs" })).toHaveLength(1);
  });

  it("a reporter that throws does not stop the replacement", async () => {
    const lookupByPostalCode = answeringLookup(975);
    const { scenario, w } = manualWorld(900, lookupByPostalCode);
    w.reportError.mockImplementation(() => {
      throw new Error("sentry down");
    });

    const result = await sellCash(w, scenario, TN_CASH.chargeTotalCents, { clientKey: "manual-key-t1" });

    expect(result.amountCents).toBe(9878);
    expect(w.event.taxRateSource).toBe("ziptax");
  });

  it("a stamp that changed since the sale read it is left alone (a new manual entry wins)", async () => {
    const { w } = manualWorld(900, answeringLookup(975));
    const replacement = {
      eventId: EVENT_ID,
      manualRateBps: 900,
      admissionTaxRateBps: 975,
      taxRateSource: "ziptax",
      expectedUpdatedAt: w.event.updatedAt,
      at: NOW,
    };
    // An Editor's new entry (950) commits after the sale read 900.
    w.event.admissionTaxRateBps = 950;
    w.event.updatedAt = new Date(w.event.updatedAt.getTime() + 1000);

    await applyCheckoutTaxSelfHeal(
      { repos: w.repos, reportError: w.reportError },
      { selfHeal: null, locationCache: null, manualReplacement: replacement },
      w.logger,
    );

    expect(w.event.admissionTaxRateBps).toBe(950);
    expect(w.event.taxRateSource).toBe(MANUAL);
    expect(w.reportError).not.toHaveBeenCalled();
    expect(w.tx.searchReindexPending.mark).not.toHaveBeenCalled();
  });

  it("a \"no rate here\" answer replaces it too: charged no tax, the event unstamped, reported as differing", async () => {
    const lookupByPostalCode = vi.fn(async () => null);
    const { scenario, w } = manualWorld(975, lookupByPostalCode);

    const result = await sellCash(w, scenario, 9000, { clientKey: "manual-key-z1" });

    // The OR row of the parity suites: the face alone (no fee on cash, no tax).
    expect(result.amountCents).toBe(9000);
    expect(w.order()!.taxAmountCents).toBe(0);
    expect(w.order()!.taxRateSource).toBe("none");
    expect(taxLineTuples(w)).toEqual([]);
    // Unstamped, as a "no rate" answer leaves any event.
    expect(w.event.admissionTaxRateBps).toBeNull();
    expect(w.event.taxRateSource).toBeNull();
    const differs = reportsTagged(w, { kind: "manual_rate_replaced_differs" });
    expect(differs).toHaveLength(1);
    expect(differs[0]![1].extra).toMatchObject({
      manualRateBps: 975,
      lookedUpRateBps: null,
    });
  });

  it("the replacement marks the event for a search reindex (listing cards quote the event rate)", async () => {
    const { scenario, w } = manualWorld(900, answeringLookup(975));

    await sellCash(w, scenario, TN_CASH.chargeTotalCents, { clientKey: "manual-key-x1" });

    expect(w.tx.searchReindexPending.mark).toHaveBeenCalledTimes(1);
    expect(w.tx.searchReindexPending.mark).toHaveBeenCalledWith(
      [{ entityType: "event", entityId: EVENT_ID }],
      NOW,
    );
  });

  it("a manual entry at the door marks the event for a search reindex", async () => {
    const lookupByPostalCode = failingLookup();
    const w = makeWorld({
      situs: NASHVILLE,
      admissionTaxRateBps: null,
      taxRateLookup: { lookupByPostalCode },
      role: "EDITOR",
    });
    await enterRate(w, 975);
    expect(w.tx.searchReindexPending.mark).toHaveBeenCalledWith(
      [{ entityType: "event", entityId: EVENT_ID }],
      NOW,
    );
  });
});

describe("R5: the transaction decides on ITS read of the stamp (preparedReplacesManualStamp)", () => {
  it("a concurrent sale replaced the stamp between this sale's prepare and its transaction: charged the new stamp, no second replacement", async () => {
    // This sale's prepare looks up 975 over the manual 900; before its
    // transaction reads the event, another sale's replacement commits 950.
    const { scenario, w } = manualWorld(
      900,
      vi.fn(async () => {
        w.event.admissionTaxRateBps = 950;
        w.event.taxRateSource = "ziptax";
        w.event.updatedAt = new Date(w.event.updatedAt.getTime() + 1000);
        return { rateBps: 975, source: "ziptax" };
      }),
    );

    const result = await sellCash(w, scenario, 9855, { clientKey: "manual-key-a1" });

    // 9000 × 9.50% = 855 → 9855: the stamp the transaction read, not 975.
    expect(result.amountCents).toBe(9855);
    expect(w.order()!.taxAmountCents).toBe(855);
    expect(w.order()!.taxRateSource).toBe("ziptax");
    expect(w.tx.events.replaceTaxRateIfUnchanged).not.toHaveBeenCalled();
    expect(w.event.admissionTaxRateBps).toBe(950);
    expect(reportsTagged(w, { kind: "manual_rate_replaced_differs" })).toHaveLength(0);
  });

  it("the venue moved between the prepare and the transaction: charged the manual stamp, no lookup on the transaction", async () => {
    const lookupByPostalCode = vi.fn(async () => {
      // The event's inline address changes before the transaction reads it.
      w.event.postalCode = "37206";
      return { rateBps: 975, source: "ziptax" };
    });
    const { scenario, w } = manualWorld(900, lookupByPostalCode);

    const result = await sellCash(w, scenario, 9810, { clientKey: "manual-key-b1" });

    // 9000 × 9.00% = 810 → 9810: the manual stamp.
    expect(result.amountCents).toBe(9810);
    expect(w.order()!.taxAmountCents).toBe(810);
    expect(w.order()!.taxRateSource).toBe(MANUAL);
    expect(lookupByPostalCode).toHaveBeenCalledTimes(1);
    expect(w.tx.events.replaceTaxRateIfUnchanged).not.toHaveBeenCalled();
  });
});

describe("R5: the rare in-transaction refusal carries the same hint", () => {
  // The venue moves between the prepare (which answered) and the
  // transaction, whose own lookup for the new address then fails.
  function movingThenFailing(w: () => World) {
    let calls = 0;
    return vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        w().event.postalCode = "37206";
        return { rateBps: 975, source: "ziptax" };
      }
      throw new TaxRateLookupError("Ziptax timeout", {
        providerCode: null,
        httpStatus: 504,
      });
    });
  }

  it("CASH, an Editor: TAX_RATE_UNAVAILABLE from the transaction says the rate may be entered", async () => {
    let world: World | null = null;
    const lookupByPostalCode = movingThenFailing(() => world!);
    const scenario: Scenario = {
      situs: NASHVILLE,
      admissionTaxRateBps: null,
      taxRateLookup: { lookupByPostalCode },
      role: "EDITOR",
    };
    world = makeWorld(scenario);

    await expect(
      sellCash(world, scenario, 20_000, { clientKey: "manual-key-h1" }),
    ).rejects.toMatchObject({
      code: "TAX_RATE_UNAVAILABLE",
      meta: { canEnterManualTaxRate: true },
    });
    expect(lookupByPostalCode).toHaveBeenCalledTimes(2);
    expect(
      reportsTagged(world, { useCase: "checkoutTaxRateUnavailable" })[0]![1].extra,
    ).toMatchObject({ stage: "transaction" });
  });

  it("CARD, a Scanner: the same refusal says an Editor is needed", async () => {
    let world: World | null = null;
    const lookupByPostalCode = movingThenFailing(() => world!);
    world = makeWorld({
      situs: NASHVILLE,
      admissionTaxRateBps: null,
      taxRateLookup: { lookupByPostalCode },
    });

    await expect(sellCardOn(world, "manual-card-h2")).rejects.toMatchObject({
      code: "TAX_RATE_UNAVAILABLE",
      meta: { canEnterManualTaxRate: false },
    });
    expect(lookupByPostalCode).toHaveBeenCalledTimes(2);
    expect(world.paymentIntent).toBeNull();
  });
});
