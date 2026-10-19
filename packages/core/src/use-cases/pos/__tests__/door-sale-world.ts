import { vi } from "vitest";

import type { IdempotencyPort } from "@th/ports/idempotency";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { PromoRecord } from "@th/ports/repos/promos";
import { SCANNER_TERMS_VERSION } from "@th/types";
import { createTestLogger } from "@th/test-utils/fakes/logger";
import { createFakePayeeLedgerRepo } from "@th/test-utils/fakes/payee-ledger";

import type { LocalTaxImpositionRule } from "../../../lib/pricing/tax-impositions";
import { recordCashSale } from "../record-cash-sale";
import { startPosSale } from "../start-pos-sale";
import type { DoorReceiptMailConfig } from "../_shared/door-buyer";

/**
 * The door-sale test world of `door-cash-parity.test.ts` (2 × $25 GA + 1 ×
 * $40 VIP; 5% + 50¢ platform fee, 2.9% + 30¢ processing, passed through),
 * shared by the Sell-screen quote and buyer-email suites, plus a guest-Human
 * store for `buyerEmail` (the `ensureGuestHuman` adapter's contract: one
 * Human per address, an existing address resolves to its Human).
 *
 * The local-imposition seam (`vi.mock` of `tax-impositions`) stays in each
 * test file: a mock must be hoisted in the file that runs.
 */
export const EVENT_ID = "11111111-1111-4111-8111-111111111111";
export const OPERATOR_ID = "22222222-2222-4222-8222-222222222223";
export const PHANTOM_ID = "22222222-2222-4222-8222-222222222224";
export const GA_ID = "33333333-3333-4333-8333-333333333333";
export const VIP_ID = "33333333-3333-4333-8333-333333333334";
export const TERMS_ID = "44444444-4444-4444-8444-444444444444";
export const POLICY_ID = "55555555-5555-4555-8555-555555555555";
export const CARD_ORDER_ID = "66666666-6666-4666-8666-666666666666";
export const PAYEE_ID = "77777777-7777-4777-8777-777777777777";
export const PLACEHOLDER_PAYEE_ID = "77777777-7777-4777-8777-777777777778";
export const NOW = new Date("2026-03-01T12:00:00.000Z");

export type Situs = { countryCode: string; region: string; postalCode: string };

export const NASHVILLE: Situs = { countryCode: "US", region: "TN", postalCode: "37203" };
export const MINNEAPOLIS: Situs = { countryCode: "US", region: "MN", postalCode: "55403" };
export const ST_PAUL: Situs = { countryCode: "US", region: "MN", postalCode: "55101" };
export const PORTLAND: Situs = { countryCode: "US", region: "OR", postalCode: "97201" };

/** Stand-in for the Minneapolis entertainment tax (3% of face, platform-collected). */
export const MPLS_LINE = {
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

export type Scenario = {
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
  /** Addresses that already have an account (email → Human id). */
  existingAccounts?: Record<string, string>;
};

export const TICKET_TYPES = [
  { id: GA_ID, priceCents: 2500 },
  { id: VIP_ID, priceCents: 4000 },
];

export function makeWorld(scenario: Scenario) {
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
  const guestHumans = new Map<string, string>(
    Object.entries(scenario.existingAccounts ?? {}),
  );
  let raceLost = false;

  const tx = {
    events: {
      lockRows: vi.fn(async () => undefined),
      getById: vi.fn(async (id: string) => (id === EVENT_ID ? event : null)),
      listTicketTypes: vi.fn(async () =>
        TICKET_TYPES.map((tt) => ({
          id: tt.id,
          name: tt.id === GA_ID ? "General admission" : "VIP",
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
      // Step 5's manual-stamp replacement. A quote must never reach it.
      replaceTaxRateIfUnchanged: vi.fn(async () => false),
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
      // Headroom = what `reserve` grants below, so the quote's preview and
      // the sale's reservation see the same allowance.
      resolveApplicable: vi.fn(async () =>
        (scenario.waiverTickets ?? 0) > 0
          ? [
              {
                id: "waiver-org",
                ticketsGranted: scenario.waiverTickets ?? 0,
                ticketsUsed: 0,
              },
            ]
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
      create: vi.fn(async () => {
        callLog.push("phantomCreated");
        return { id: PHANTOM_ID };
      }),
      // The `ensureGuestHuman` adapter's contract: an address with an account
      // resolves to its Human; a new one mints ONE shadow Human, and the same
      // address resolves to it from then on.
      ensureGuestHuman: vi.fn(async ({ email }: { email: string }) => {
        callLog.push("guestEnsured");
        const known = guestHumans.get(email);
        if (known) return { humanId: known, created: false };
        const humanId = `00000000-0000-4000-8000-${String(
          guestHumans.size + 1,
        ).padStart(12, "0")}`;
        guestHumans.set(email, humanId);
        return { humanId, created: true };
      }),
      update: vi.fn(async () => undefined),
      getByIdWithIdentity: vi.fn(async (id: string) => {
        for (const [email, humanId] of guestHumans) {
          if (humanId !== id) continue;
          return {
            human: { id, name: null },
            identity: {
              authUserId: `auth-${id}`,
              email,
              // An existing account is a verified one; a shadow guest is
              // not (B2: `isLoginableBuyer` needs both an AuthAccount and a
              // verified email).
              emailVerified: Object.values(
                scenario.existingAccounts ?? {},
              ).includes(id),
            },
          };
        }
        return null;
      }),
      listAuthAccounts: vi.fn(async (id: string) =>
        Object.values(scenario.existingAccounts ?? {}).includes(id)
          ? [{ id: "acct", providerId: "credential" }]
          : [],
      ),
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
      hasActiveTicketForEvent: vi.fn(async () => true),
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
    places: { getById: vi.fn(async () => null) },
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

  const sentMail: Array<Record<string, any>> = [];
  const mailer = {
    send: vi.fn(async (input: Record<string, any>) => {
      callLog.push("mail");
      sentMail.push(input);
      return { result: { success: true, id: `mail-${sentMail.length}` } };
    }),
    sendBatch: vi.fn(),
    health: vi.fn(),
  };
  const receiptMail: DoorReceiptMailConfig = {
    mailer: mailer as never,
    publicAppUrl: "https://ithasfire.test",
    supportUrl: "https://ithasfire.test/support",
  };

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
    /** The event row every read returns; mutate it to change the scenario. */
    event,
    mailer,
    sentMail,
    receiptMail,
    guestHumans,
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

export type World = ReturnType<typeof makeWorld>;

export const CART = [
  { ticketTypeId: GA_ID, qty: 2 },
  { ticketTypeId: VIP_ID, qty: 1 },
];

export function cashDeps(w: World) {
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

export async function sellCash(
  w: World,
  scenario: Scenario,
  amountCollectedCents: number,
  extra: {
    comp?: boolean;
    clientKey?: string;
    buyerEmail?: string;
    /** Wire the world's mailer (default) or pass null for "not configured". */
    receiptMail?: DoorReceiptMailConfig | null;
    reportError?: (...args: unknown[]) => void;
  } = {},
) {
  return recordCashSale(
    {
      ...cashDeps(w),
      receiptMail:
        extra.receiptMail === undefined ? w.receiptMail : extra.receiptMail,
      ...(extra.reportError ? { reportError: extra.reportError } : {}),
    },
    {
      actorHumanId: OPERATOR_ID,
      eventId: EVENT_ID,
      clientKey: extra.clientKey ?? "parity-cash-key",
      items: CART,
      amountCollectedCents,
      ...(extra.comp !== undefined ? { comp: extra.comp } : {}),
      ...(scenario.promo ? { promoCodes: ["save"] } : {}),
      ...(extra.buyerEmail !== undefined ? { buyerEmail: extra.buyerEmail } : {}),
    },
  );
}

export async function sellCard(
  scenario: Scenario,
  extra: { buyerEmail?: string; world?: World } = {},
) {
  const w = extra.world ?? makeWorld(scenario);
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
      ...(extra.buyerEmail !== undefined ? { buyerEmail: extra.buyerEmail } : {}),
    },
  );
  return w;
}
