import { z } from "zod";
import { donationAmountCentsSchema } from "../../lib/pricing/pay-what-you-want";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { MetricsPort } from "@th/ports/metric";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { TaxRateLookupPort } from "@th/ports/tax-rate-lookup";
import { SCANNER_TERMS_VERSION } from "@th/types";
import type { CreateOrderItemInput } from "@th/types/repos/orders";
import { formatOrderCode } from "@th/types/order-identifier";

import { asKnownError } from "../../lib/errors";
import { describeError, parseInput } from "../../lib/io";
import { ORG_SCAN_ROLES, requireScannerAccessOnOrg } from "../../lib/rbac";
import { assertTicketTypeOnSale } from "../../lib/orders/door-pricing";
import {
  aggregateItems,
  computeOrderAmounts,
  loadPayoutTermsContext,
  unseatedSeatPrices,
} from "../orders/checkout-helpers";
import {
  createPromoHolds,
  evaluatePromoApplications,
  preparePromoCodes,
} from "../orders/checkout-promos";
import { priceCart } from "../orders/_shared/price-cart";
import {
  resolveTicketResaleClause,
  stampTicketResaleClause,
} from "../orders/_shared/resolve-ticket-resale-clause";
import {
  applyCheckoutTaxSelfHeal,
  newCheckoutTaxAfterCommit,
  prepareCheckoutTax,
  resolveCheckoutTax,
  type PreparedCheckoutTax,
} from "../orders/_shared/resolve-checkout-tax-rate";
import { mintTicketsForOrder } from "../tickets/mint-tickets";
import { assertPosCapacity } from "./assert-pos-capacity";
import { assertCanSellBeforeTaxLookup } from "./_shared/assert-can-sell-before-tax-lookup";
import { withManualTaxRateHint } from "./_shared/manual-tax-rate-hint";
import { toDoorTicketTypeSummaries } from "./_shared/door-ticket-types";
import {
  doorBuyerEmailSchema,
  resolveDoorBuyer,
  sendDoorReceiptAfterCommit,
  type DoorReceiptMailConfig,
} from "./_shared/door-buyer";
import {
  assertDoorSellsEvent,
  lockDoorEvent,
} from "./_shared/door-event-gate";
import {
  cashSaleDebitKey,
  resolveCashSalePayee,
  type CashSalePayeeRace,
} from "./_shared/cash-sale-ledger";
import { isUniqueViolation } from "../places/_shared/claim";
import { fail, isAppError } from "@th/errors";

// ── Schema ───────────────────────────────────────────────────────────────────

export const recordCashSaleInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  eventId: z.string().uuid(),
  /**
   * Client-supplied stable key for idempotency. Same key + same payload
   * within 2 minutes returns the cached result; same key + different
   * payload is rejected.
   */
  clientKey: z.string().min(8).max(128),
  items: z
    .array(
      z.object({
        ticketTypeId: z.string().uuid(),
        qty: z.number().int().positive().max(100),
        /**
         * Buyer-named amount PER TICKET for an ADJUSTABLE ("pay what you can")
         * type. Required when the resolved type is ADJUSTABLE on a paid sale;
         * ignored when FIXED and on a comp. Server validates `>= minimumCents`.
         * Same field and same semantics as `startPosSale` and web checkout.
         */
        // Capped at MAX_DONATION_AMOUNT_CENTS ($10,000.00 per ticket), the
        // same shared schema online checkout uses.
        donationAmountCents: donationAmountCentsSchema.optional(),
      }),
    )
    .nonempty(),
  /**
   * Cash the operator took from the buyer, in cents. It is NOT the price:
   * the sale is priced by the server (`priceCart`, channel DOOR_CASH: ticket
   * net of discount + tax, no platform fee and no processing fee; owner
   * ruling 2026-10-08 and R4) and this only works out the change. Below the computed total the
   * sale is REFUSED with CASH_AMOUNT_SHORT (meta carries the total).
   *
   * `0` with `comp` unset and no promo code is a comp, as the till has
   * always sent it; see `comp`.
   */
  amountCollectedCents: z.number().int().nonnegative(),
  /**
   * The explicit comp action (owner ruling R4: a comp is an explicit action
   * at the till). A comp records $0: no fee, no tax, no ledger debit, and it
   * runs neither the pricing pipeline nor a tax lookup. `amountCollectedCents`
   * must be 0. Left unset, `amountCollectedCents: 0` with NO promo code
   * still means comp (the signal today's tills send); with a promo code it
   * is a paid sale, so the code is redeemed. `comp: false` with 0 is a paid
   * sale and is refused as short unless the cart's total is $0.
   */
  comp: z.boolean().optional(),
  /**
   * When true, tickets mint as VALID (not auto-admitted). Defaults to
   * false. Used for pre-sale windows where admission opens later.
   */
  sellWithoutAdmitting: z.boolean().optional(),
  /**
   * Operator-entered promo codes. Evaluated by the same
   * `evaluatePromoApplications` path as web checkout; redemptions are
   * confirmed inline (cash finalises in one transaction). Ignored on a comp
   * (nothing is charged, so no redemption is spent).
   */
  promoCodes: z.array(z.string().min(1).max(64)).max(4).optional(),
  /**
   * Optional buyer email (spec 2026-10-07 door-sales FR-011, owner ruling
   * R7), paid sale or comp. Given, the order is recorded against that address
   * the way guest checkout records one (`resolveDoorBuyer`) and, after the
   * sale commits, the buyer is emailed the ticket and an itemised receipt
   * (a $0 one for a comp). No account is created and no marketing consent
   * recorded.
   */
  buyerEmail: doorBuyerEmailSchema,
});

export type RecordCashSaleInput = z.infer<typeof recordCashSaleInputSchema>;

export const recordCashSaleOutputSchema = z.object({
  orderId: z.string().uuid(),
  ticketCount: z.number().int().nonnegative(),
  ticketCodes: z.array(z.string()),
  /**
   * Seat labels assigned to this sale, in admission order — e.g.
   * `["V14","V15","V16"]`. Populated for RESERVED-section sales so the
   * Sell screen can tell the operator where to direct the walk-up group.
   * Empty array for GA / unseated sales.
   */
  seatLabels: z.array(z.string()),
  /**
   * What the sale cost the buyer, in cents: ticket net of discount + tax
   * (no platform fee, no processing fee; owner ruling 2026-10-08). The cash
   * that stays in the box. 0 for a comp.
   */
  amountCents: z.number().int().nonnegative(),
  /** Cash handed over, as typed. Defaulted for records cached before it existed. */
  amountCollectedCents: z.number().int().nonnegative().default(0),
  /** `amountCollectedCents − amountCents`: hand this back. */
  changeCents: z.number().int().nonnegative().default(0),
  /** Total promo discount applied, in cents. 0 when no codes were given. */
  discountCents: z.number().int().nonnegative(),
  /**
   * The promo codes this sale redeemed, normalized, in the order typed.
   * Empty for a comp and for a sale without codes. A sale with codes and
   * `amountCents: 0` is "free with <CODE>": a sale, not a comp. Defaulted
   * for records cached before it existed.
   */
  promoCodes: z.array(z.string()).default([]),
  /**
   * Platform fee inside `amountCents`. Always 0 for a sale recorded since
   * the owner ruling of 2026-10-08 (cash = no platform fee); kept so the
   * tills that read it, and replays of older cached results, still parse.
   */
  feesPlatformCents: z.number().int().nonnegative().default(0),
  /** Tax inside `amountCents` (owed to the platform, which remits it). */
  taxAmountCents: z.number().int().nonnegative().default(0),
  /** Same as `amountCents`; kept for the tills that read it. */
  expectedDueCents: z.number().int().nonnegative(),
  isComp: z.boolean(),
  autoAdmitted: z.boolean(),
});

export type RecordCashSaleOutput = z.infer<typeof recordCashSaleOutputSchema>;

// ── Deps ─────────────────────────────────────────────────────────────────────

export type RecordCashSaleDeps = {
  repos: Repos;
  authz: AuthZPort;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
  metrics?: MetricsPort;
  /**
   * Best-effort reporter. Wired to the sales-window guard (an unparseable
   * window bound makes that guard fail OPEN, and the POS has no event-level
   * sales close to catch it) and to the tax resolver's reports (a refused
   * lookup, a failed self-heal write).
   */
  reportError?: ReporterPort;
  /**
   * Tax provider (ZipTax), for an event never stamped at publish time. The
   * same port online checkout and the card till get; without it an unstamped
   * event prices at 0% exactly as checkout does in a deployment with no
   * provider.
   */
  taxRateLookup?: TaxRateLookupPort | null;
  /**
   * Sends the buyer's ticket + receipt when the sale carries `buyerEmail`.
   * Absent while the sale has an email: the sale still records, and the
   * missing receipt is reported.
   */
  receiptMail?: DoorReceiptMailConfig | null;
};

const IDEMPOTENCY_TTL_SECONDS = 120;
const IDEMPOTENCY_KEEP_SECONDS = 86_400;

/**
 * New entries store `{ payloadHash, response }`; entries cached before the
 * payload-hash check shipped are the bare output object. Both shapes live
 * side by side for one 24h keep window after deploy, so the readers below
 * accept either — a legacy entry simply skips the hash comparison.
 */
type StoredRecordCashSaleRecord =
  | { payloadHash: string; response: RecordCashSaleOutput }
  | RecordCashSaleOutput;

function isWrappedCashRecord(
  record: StoredRecordCashSaleRecord,
): record is { payloadHash: string; response: RecordCashSaleOutput } {
  return (
    typeof (record as { payloadHash?: unknown }).payloadHash === "string" &&
    typeof (record as { response?: unknown }).response === "object"
  );
}

function unwrapCashRecord(
  record: StoredRecordCashSaleRecord,
): RecordCashSaleOutput {
  return isWrappedCashRecord(record) ? record.response : record;
}

function assertCashPayloadMatches(
  record: StoredRecordCashSaleRecord,
  payloadHash: string,
): void {
  if (isWrappedCashRecord(record) && record.payloadHash !== payloadHash) {
    throw fail("IDEMPOTENCY_KEY_CONFLICT");
  }
}

type CashSaleResult = RecordCashSaleOutput & {
  /** Set when the org had no Payee and the debit needed a placeholder. */
  placeholderPayeeId: string | null;
};

// ── Use case ─────────────────────────────────────────────────────────────────

/**
 * Records an in-person cash sale (FR-015; priced per spec 2026-10-07
 * door-sales-same-price-and-tax, FR-003/FR-004/FR-005).
 *
 * Creates a SUCCEEDED Order with paymentChannel=CASH inline — no Stripe
 * call, no PaymentIntent, no Settlement. Mints tickets and auto-admits
 * them per FR-013 in the same DB transaction (unless
 * `sellWithoutAdmitting` is set).
 *
 * PAID SALE. Priced by `priceCart` (channel DOOR_CASH) from the same payout
 * terms, promo evaluation and tax resolution online checkout and the card
 * till use: ticket net of discount + tax, with NO platform fee and no
 * processing fee (owner ruling 2026-10-08: cash = no platform fee; revises
 * R3). With no fee to waive, a cash sale reserves no fee-waiver allowance.
 * The order's amounts come from that, never from the typed amount; a typed
 * amount below the total is refused with CASH_AMOUNT_SHORT (R4), above it
 * returns `changeCents`. The tax is owed to the platform (it remits it): a
 * CASH_SALE_DEBIT of the tax on the organisation's payee, in the same
 * transaction, recovered from the next payout (R6); no debit when the tax is
 * 0. The tax lookup runs BEFORE the transaction (NFR-002) and a failed one
 * refuses with TAX_RATE_UNAVAILABLE (R5).
 *
 * COMP. `comp: true` (or `amountCollectedCents: 0`, `comp` unset, no promo
 * code): $0
 * order and items, no fee, no tax lines, no debit, no pricing, no lookup.
 *
 * Auth: ORG_SCAN_ROLES on the event's org, checked before the paid lookup and
 * again inside the transaction.
 *
 * Idempotency: `cash:{actorHumanId}:{clientKey}`, 2-min TTL. Replays
 * within the window return the cached result.
 */
export async function recordCashSale(
  deps: RecordCashSaleDeps,
  rawInput: unknown,
): Promise<RecordCashSaleOutput> {
  const input = parseInput(recordCashSaleInputSchema, rawInput);
  const idempKey = `cash:${input.actorHumanId}:${input.clientKey}`;

  if (input.comp === true && input.amountCollectedCents !== 0) {
    // A comp collects nothing. Cash in hand on a comp is a mis-tap or a
    // mislabelled sale; refuse rather than guess which one the operator meant.
    throw fail("INVALID_INPUT", {
      message: "comp_with_cash_collected",
      meta: { amountCollectedCents: input.amountCollectedCents },
    });
  }
  const promoCodes = preparePromoCodes(input.promoCodes);
  // A comp is EXPLICIT (`comp: true`). One legacy alias survives until the
  // tills send `comp` (door-sales spec steps 9/10): `comp` unset, $0
  // collected and NO promo code is today's tills' comp button. With a code
  // it is a paid sale, so a 100%-off code ("first 10 free") is redeemed and
  // counted against its limits — a comp would skip the redemption entirely.
  const isComp =
    input.comp === true ||
    (input.comp === undefined &&
      input.amountCollectedCents === 0 &&
      promoCodes.length === 0);

  // Same payload-hash conflict check startPosSale uses: a replayed
  // clientKey with different items/amount/codes must ERROR, not silently
  // return the cached (differently-priced) sale. Promo codes made this
  // matter — "retry with the code the customer just produced" is a real
  // door flow, and the cached result would show discountCents: 0.
  const payloadHash = JSON.stringify({
    actor: input.actorHumanId,
    event: input.eventId,
    // `d` is load-bearing on the PRICE of an ADJUSTABLE tier, so a replay
    // carrying a different pay-what-you-can amount must conflict rather than
    // return the cached, differently-priced sale.
    items: input.items.map((i) => ({
      tt: i.ticketTypeId,
      q: i.qty,
      d: i.donationAmountCents ?? null,
    })),
    collected: input.amountCollectedCents,
    comp: isComp,
    promos: promoCodes.map((c) => c.normalized),
    // Whose ticket it is: a replay naming a different buyer conflicts.
    // Omitted when absent, so a sale without one hashes as it always did.
    ...(input.buyerEmail ? { email: input.buyerEmail } : {}),
  });

  const cached = await deps.idempotency.get<StoredRecordCashSaleRecord>(
    idempKey,
  );
  if (cached) {
    assertCashPayloadMatches(cached, payloadHash);
    return recordCashSaleOutputSchema.parse(unwrapCashRecord(cached));
  }

  const claimed = await deps.idempotency.begin(
    idempKey,
    IDEMPOTENCY_TTL_SECONDS,
  );
  if (!claimed) {
    const replay = await deps.idempotency.get<StoredRecordCashSaleRecord>(
      idempKey,
    );
    if (replay) {
      assertCashPayloadMatches(replay, payloadHash);
      return recordCashSaleOutputSchema.parse(unwrapCashRecord(replay));
    }
    throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
  }

  // The tax self-heal stamp and location cache a fresh lookup produced are
  // recorded inside the transaction and written after it commits, exactly as
  // checkout and the card till do.
  const taxAfterCommit = newCheckoutTaxAfterCommit();

  try {
    let result: CashSaleResult;
    if (isComp) {
      result = await deps.repos.tx((tx) => recordComp(deps, input, tx));
    } else {
      // ── Phase 0: tax lookup, BEFORE any transaction (NFR-002) ──────
      // RBAC first, on plain reads: the lookup can be a PAID provider call,
      // and nothing may spend it for a caller the transaction would refuse.
      // Then the same prepare checkout and the card till run: a live
      // provider call on a cache miss, retried, and refused with
      // TAX_RATE_UNAVAILABLE when every attempt failed (R5).
      const sellerAccess = await assertCanSellBeforeTaxLookup(deps, input);
      // A refusal says whether this seller may enter the rate by hand (R5).
      const preparedTax = await withManualTaxRateHint(sellerAccess, () =>
        prepareCheckoutTax(
          {
            repos: deps.repos,
            taxRateLookup: deps.taxRateLookup,
            clock: deps.clock,
            reportError: deps.reportError,
          },
          input.eventId,
          deps.logger,
          { channel: "door" },
        ),
      );
      try {
        // The rare in-transaction refusal carries the same hint.
        result = await withManualTaxRateHint(sellerAccess, () =>
          runPaidSaleTx(deps, input, promoCodes, preparedTax, taxAfterCommit),
        );
      } catch (err) {
        // A short amount is the door's normal retry loop: the operator reads
        // the total off the refusal and asks for the rest. The rate a fresh
        // lookup just paid for is a fact about the venue, not about this
        // sale, so keep it — stamped and cached outside the rolled-back
        // transaction, exactly as a sale that commits does — or every short
        // attempt on an unstamped event pays for another lookup. Both writes
        // are compare-and-set and never throw.
        if (isAppError(err) && err.code === "CASH_AMOUNT_SHORT") {
          await applyCheckoutTaxSelfHeal(
            { repos: deps.repos, reportError: deps.reportError },
            taxAfterCommit,
            deps.logger,
          );
        }
        throw err;
      }
      // The event's self-heal stamp and the location's rate cache, after the
      // commit. Never throws (failures are reported inside).
      await applyCheckoutTaxSelfHeal(
        { repos: deps.repos, reportError: deps.reportError },
        taxAfterCommit,
        deps.logger,
      );
    }

    const { placeholderPayeeId, ...output } = result;
    if (placeholderPayeeId) {
      // Expected for an org that sells cash before connecting Stripe (R6 —
      // payout setup is not required to sell cash). Not an error: the debit
      // is recorded and recovered from the org's first card payout.
      deps.logger?.info("pos.cash_sale.placeholder_payee_created", {
        eventId: input.eventId,
        orderId: output.orderId,
        payeeId: placeholderPayeeId,
      });
    }

    await deps.idempotency.commit<StoredRecordCashSaleRecord>(
      idempKey,
      { payloadHash, response: output },
      IDEMPOTENCY_KEEP_SECONDS,
    );

    const metricName = output.isComp
      ? "pos.cash_sale.comp_recorded"
      : "pos.cash_sale.recorded";
    deps.logger?.info(metricName, {
      actorHumanId: input.actorHumanId,
      eventId: input.eventId,
      orderId: output.orderId,
      ticketCount: output.ticketCount,
      amountCents: output.amountCents,
      feesPlatformCents: output.feesPlatformCents,
      taxAmountCents: output.taxAmountCents,
      autoAdmitted: output.autoAdmitted,
    });
    deps.metrics?.increment(metricName, { eventId: input.eventId });

    const parsed = recordCashSaleOutputSchema.parse(output);
    // The buyer's ticket + receipt, AFTER the commit (FR-011). Never throws:
    // a mail fault is reported and the committed sale stands.
    if (input.buyerEmail) {
      await sendDoorReceiptAfterCommit(deps, {
        orderId: parsed.orderId,
        eventId: input.eventId,
        useCase: "recordCashSale",
      });
    }
    return parsed;
  } catch (err) {
    await deps.idempotency.fail(idempKey, describeError(err));
    throw asKnownError("record_cash_sale", err);
  }
}

// ── Shared transaction steps ─────────────────────────────────────────────────

type ResolvedEvent = NonNullable<Awaited<ReturnType<TxRepos["events"]["getById"]>>> & {
  orgId: string;
};

/**
 * Event, scanner role, scanner-terms ack, and the platform-admin audit row:
 * the opening of every cash transaction, comp or paid.
 */
async function openCashSale(
  deps: RecordCashSaleDeps,
  input: RecordCashSaleInput,
  tx: TxRepos,
): Promise<ResolvedEvent> {
  // First in the transaction: serializes this sale (comp or paid) with a
  // cancellation of the event (see `lockDoorEvent`).
  await lockDoorEvent(tx, input.eventId);
  const event = await tx.events.getById(input.eventId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }
  if (!event.orgId) {
    throw fail("EVENT_NOT_ORG_OWNED");
  }

  const access = await requireScannerAccessOnOrg({
    repos: tx,
    authz: deps.authz,
    orgId: event.orgId,
    actorHumanId: input.actorHumanId,
    roles: ORG_SCAN_ROLES,
    errorCode: "INSUFFICIENT_ROLE",
  });

  // The door sells published events only (owner ruling 2026-10-07).
  assertDoorSellsEvent(event);

  const operator = await tx.humans.getById(input.actorHumanId);
  if (
    !operator?.scannerTermsAckAt ||
    operator.scannerTermsAckVersion !== SCANNER_TERMS_VERSION
  ) {
    throw fail("SCANNER_TERMS_REQUIRED");
  }

  if (access.via === "platform_admin") {
    await tx.audit.log({
      entity: "pos_sale",
      entityId: input.eventId,
      action: "pos.record_cash_sale.platform_admin_override",
      at: deps.clock.now(),
      data: {
        actorHumanId: input.actorHumanId,
        eventId: input.eventId,
        orgId: event.orgId,
        clientKey: input.clientKey,
        amountCollectedCents: input.amountCollectedCents,
        itemCount: input.items.length,
      },
    });
  }

  return event as ResolvedEvent;
}

type ActiveTicketType = Awaited<
  ReturnType<TxRepos["events"]["listTicketTypes"]>
>[number];

/**
 * The sellable types and the per-type sales window (FR-014), refused BEFORE
 * any pricing, lock or mint at the sale's single `now`. `listTicketTypes`
 * returns EVERY status, so the sellable set is narrowed here to ACTIVE (the
 * rule `listSellableItems` builds the till from); a DRAFT type named by id is
 * refused as TICKET_TYPE_NOT_FOUND (money audit 2026-09-08 #14).
 */
async function loadSellableTypes(
  deps: RecordCashSaleDeps,
  tx: TxRepos,
  event: ResolvedEvent,
  ticketTypeIds: readonly string[],
  now: Date,
): Promise<{ ticketTypes: ActiveTicketType[]; ttById: Map<string, ActiveTicketType> }> {
  const ticketTypes = (await tx.events.listTicketTypes(event.id)).filter(
    (tt) => tt.status === "ACTIVE",
  );
  const ttById = new Map(ticketTypes.map((tt) => [tt.id, tt]));
  for (const ticketTypeId of new Set(ticketTypeIds)) {
    const tt = ttById.get(ticketTypeId);
    if (!tt) {
      throw fail("TICKET_TYPE_NOT_FOUND");
    }
    // The POS has NO event-level sales close (door sales happen after the
    // start), so the per-type window is the ONLY window gate at the till.
    assertTicketTypeOnSale(tt, now, {
      meta: { ticketTypeId, eventId: event.id },
      onUnparseableBound: deps.reportError
        ? ({ field, meta }) =>
            deps.reportError?.(
              new Error(`ticket_type_sales_window_unparseable:${field}`),
              {
                tags: { area: "pos", field },
                // The POS has NO event-level sales close, so this window is
                // the ONLY gate at a till — an unevaluatable bound here sells
                // forever with no other backstop.
                extra: { ...meta, surface: "recordCashSale" },
              },
            )
        : undefined,
    });
  }
  return { ticketTypes, ttById };
}

/**
 * Auto-assign contiguous seats for RESERVED-section types so a walk-up group
 * lands in the same row. GA / unseated types get none. No HELD stamp: cash
 * mints inside this transaction, and the mint flips the seats to SOLD.
 */
async function pickSeats(
  tx: TxRepos,
  event: ResolvedEvent,
  ttById: Map<string, ActiveTicketType>,
  lines: ReadonlyArray<{ ticketTypeId: string; qty: number }>,
): Promise<{ seatsByType: Map<string, { id: string; label: string }[]> }> {
  const seatsByType = new Map<string, { id: string; label: string }[]>();
  for (const line of lines) {
    const tt = ttById.get(line.ticketTypeId);
    if (!tt?.seatSectionId) continue;
    const section = await tx.seats.getSectionById(tt.seatSectionId);
    if (section?.type !== "RESERVED") continue;
    const picked = await tx.seats.pickContiguousAvailable({
      seatSectionId: tt.seatSectionId,
      eventId: event.id,
      qty: line.qty,
    });
    if (picked.length !== line.qty) {
      throw {
        code: "conflict",
        message: "seat_unavailable",
        ticketTypeId: line.ticketTypeId,
      } as const;
    }
    seatsByType.set(
      line.ticketTypeId,
      picked.map((s) => ({ id: s.id, label: s.label })),
    );
  }
  return { seatsByType };
}

/** Seat ids onto the ticket items, one per ticket in pick order; labels out. */
function attachSeats(
  items: CreateOrderItemInput[],
  seatsByType: Map<string, { id: string; label: string }[]>,
): string[] {
  const labels: string[] = [];
  const used = new Map<string, number>();
  for (const item of items) {
    if (item.kind !== "ticket" || !item.ticketTypeId) continue;
    const seats = seatsByType.get(item.ticketTypeId);
    if (!seats) continue;
    const idx = used.get(item.ticketTypeId) ?? 0;
    used.set(item.ticketTypeId, idx + 1);
    const seat = seats[idx];
    if (!seat) continue;
    item.meta = {
      ...((item.meta ?? {}) as Record<string, unknown>),
      seatIds: [seat.id],
    };
    labels.push(seat.label);
  }
  return labels;
}

/** markSucceeded → reload → mint → auto-admit, inside the sale's transaction. */
async function finishCashOrder(
  deps: RecordCashSaleDeps,
  input: RecordCashSaleInput,
  tx: TxRepos,
  orderId: string,
  eventId: string,
): Promise<{ ticketCodes: string[]; autoAdmitted: boolean }> {
  await tx.orders.markSucceeded(orderId);

  const order = await tx.orders.getById(orderId);
  if (!order) {
    throw fail("ORDER_RELOAD_FAILED");
  }

  const issuedAt = deps.clock.now();
  const mint = await mintTicketsForOrder(tx, {
    order,
    issuedAt,
    actor: {
      kind: "human",
      humanId: input.actorHumanId,
      reason: "pos_cash_sale",
    },
  });

  const autoAdmit = !input.sellWithoutAdmitting;
  if (autoAdmit && mint.tickets.length > 0) {
    for (const ticket of mint.tickets) {
      await tx.tickets.markScanned(ticket.code, issuedAt);
      await tx.tickets.recordScan({
        ticketId: ticket.id,
        eventId,
        actorHumanId: input.actorHumanId,
        scannedAt: issuedAt,
        locationLat: null,
        locationLng: null,
        outcome: "ACCEPTED",
        // FR-013 audit tag — distinguishes auto-admit from a real
        // operator-driven scan in TicketScan reports.
        message: "POS_CASH_AUTO_ADMIT",
      });
    }
  }

  return { ticketCodes: mint.tickets.map((t) => t.code), autoAdmitted: autoAdmit };
}

// ── Comp ─────────────────────────────────────────────────────────────────────

/**
 * A comp (FR-005): $0 order and $0 items, no fee, no tax lines, no ledger
 * debit, no promo redemption. Neither `priceCart` nor a tax lookup runs. The
 * gates still apply: role, terms, sales window, capacity (a comp takes a real
 * seat), seats.
 */
async function recordComp(
  deps: RecordCashSaleDeps,
  input: RecordCashSaleInput,
  tx: TxRepos,
): Promise<CashSaleResult> {
  const event = await openCashSale(deps, input, tx);
  // ONE clock read for the whole sale: the window gate and the capacity gate
  // must agree.
  const now = deps.clock.now();
  const { ttById } = await loadSellableTypes(
    deps,
    tx,
    event,
    input.items.map((it) => it.ticketTypeId),
    now,
  );

  // Cash respects card holds: a comp must not take the last seat a card sale
  // is holding mid-tap.
  await assertPosCapacity(tx, {
    requests: input.items.map((it) => ({
      ticketTypeId: it.ticketTypeId,
      qty: it.qty,
    })),
    ticketTypesById: ttById,
    now,
  });

  // One pick per type (a type named on two lines is one contiguous block).
  const qtyByType = new Map<string, number>();
  for (const it of input.items) {
    qtyByType.set(it.ticketTypeId, (qtyByType.get(it.ticketTypeId) ?? 0) + it.qty);
  }
  const { seatsByType } = await pickSeats(
    tx,
    event,
    ttById,
    [...qtyByType].map(([ticketTypeId, qty]) => ({ ticketTypeId, qty })),
  );

  // One OrderItem per ticket (qty 1), the shape mint iterates. $0 items with
  // the free-order buyer totals, so every reader (receipt, till, refund) sees
  // a $0 sale.
  const items: CreateOrderItemInput[] = [];
  for (const it of input.items) {
    for (let i = 0; i < it.qty; i += 1) {
      items.push({
        kind: "ticket",
        ticketTypeId: it.ticketTypeId,
        qty: 1,
        unitPriceCents: 0,
        amountCents: 0,
        meta: {
          comp: true,
          platformFeePerTicketCents: 0,
          buyerTotalCents: 0,
          buyerUnitTotalCents: 0,
        },
      });
    }
  }
  const seatLabels = attachSeats(items, seatsByType);

  // The buyer: a per-sale phantom (FR-004), or the guest Human for the email
  // the buyer gave (FR-011).
  const buyerHumanId = await resolveDoorBuyer(tx, input.buyerEmail);

  // FR-003 (organiser-resale-share): a door comp is a first sale at $0, so
  // each ticket records the event's resale clause in force now.
  const resaleClause = await resolveTicketResaleClause(tx, event);
  const created = await tx.orders.createPending({
    eventId: event.id,
    buyerHumanId,
    amountGrossCents: 0,
    feesPlatformCents: 0,
    taxAmountCents: 0,
    currency: event.currency ?? "usd",
    feePolicySnapshot: {},
    source: "PRIMARY",
    items: stampTicketResaleClause(items, resaleClause),
    paymentChannel: "CASH",
  });

  const finished = await finishCashOrder(deps, input, tx, created.id, event.id);

  return {
    orderId: created.id,
    ticketCount: finished.ticketCodes.length,
    ticketCodes: finished.ticketCodes,
    seatLabels,
    amountCents: 0,
    amountCollectedCents: 0,
    changeCents: 0,
    discountCents: 0,
    promoCodes: [],
    feesPlatformCents: 0,
    taxAmountCents: 0,
    expectedDueCents: 0,
    isComp: true,
    autoAdmitted: finished.autoAdmitted,
    placeholderPayeeId: null,
  };
}

// ── Paid sale ────────────────────────────────────────────────────────────────

/**
 * A paid cash sale, priced as the card till prices the same cart minus the
 * platform fee and the processing fee (owner ruling 2026-10-08). The step
 * order is `startPosSale`'s, lock order included, minus its first lock (the
 * fee-waiver allowance; cash has no fee to waive): ticket-type capacity, then
 * seats — the order online checkout takes them in, so no two paths deadlock.
 */
/**
 * The paid sale's transaction, retried ONCE when — and only when — it lost
 * the race to create the org's placeholder payee (two first cash sales at
 * once; see `resolveCashSalePayee`). The P2002 aborted and rolled back the
 * whole attempt, so the retry starts clean and reads the winner's payee. Any
 * other unique violation is not retried.
 */
async function runPaidSaleTx(
  deps: RecordCashSaleDeps,
  input: RecordCashSaleInput,
  promoCodes: ReturnType<typeof preparePromoCodes>,
  preparedTax: PreparedCheckoutTax,
  taxAfterCommit: ReturnType<typeof newCheckoutTaxAfterCommit>,
): Promise<CashSaleResult> {
  const race: CashSalePayeeRace = { placeholderAttempted: false };
  const attempt = () =>
    deps.repos.tx((tx) =>
      recordPaidSale(
        deps,
        input,
        promoCodes,
        tx,
        preparedTax,
        taxAfterCommit,
        race,
      ),
    );
  try {
    return await attempt();
  } catch (err) {
    if (!(race.placeholderAttempted && isUniqueViolation(err))) throw err;
    deps.logger?.info("pos.cash_sale.payee_race_retried", {
      eventId: input.eventId,
    });
    race.placeholderAttempted = false;
    return attempt();
  }
}

async function recordPaidSale(
  deps: RecordCashSaleDeps,
  input: RecordCashSaleInput,
  promoCodes: ReturnType<typeof preparePromoCodes>,
  tx: TxRepos,
  preparedTax: PreparedCheckoutTax,
  taxAfterCommit: ReturnType<typeof newCheckoutTaxAfterCommit>,
  payeeRace: CashSalePayeeRace,
): Promise<CashSaleResult> {
  const event = await openCashSale(deps, input, tx);
  // ONE clock read for the whole sale: the window gate, the capacity gate,
  // every priced line (a scheduled price flip, FR-005) and the promo
  // evaluation must all agree.
  const now = deps.clock.now();
  const { ticketTypes, ttById } = await loadSellableTypes(
    deps,
    tx,
    event,
    input.items.map((it) => it.ticketTypeId),
    now,
  );

  // One line per ticket type, merged the way checkout merges a cart (and
  // refused the way checkout refuses two different pay-what-you-want amounts
  // for one type).
  const aggregatedItems = aggregateItems(
    input.items.map((it) => ({
      ticketTypeId: it.ticketTypeId,
      qty: it.qty,
      ...(it.donationAmountCents !== undefined
        ? { donationAmountCents: it.donationAmountCents }
        : {}),
    })),
  );

  // ── Price the cart: THE checkout pipeline (FR-001/FR-003) ─────────────
  const ticketTypeMap = toDoorTicketTypeSummaries(ticketTypes);
  const payoutTerms = await loadPayoutTermsContext(tx, event.id, now, {
    logger: deps.logger,
    reportError: deps.reportError,
  });

  // Pure: prices every line (pay-what-you-want amounts validated, scheduled
  // prices resolved at `now`) before any lock, and gives the promo
  // evaluation its subtotal and lines.
  // The door names no seats; a cart that does is refused rather than priced
  // without its seat overrides (seat-price-overrides spec R-004).
  const seatPrices = unseatedSeatPrices(aggregatedItems);
  const faceComputation = computeOrderAmounts(
    aggregatedItems,
    ticketTypeMap,
    payoutTerms,
    { now, seatPrices },
  );

  // ── No fee waiver ───────────────────────────────────────────────────
  // A cash sale charges no platform fee (owner ruling 2026-10-08), so there
  // is nothing for an organiser's fee-waiver allowance to cover: none is
  // reserved, settled or spent here, and the allowance stays for the card
  // and online sales that do pay the fee. (`priceCart` refuses a cash
  // computation that carries a waiver.) The order id is minted here, as
  // checkout does.
  const orderId = crypto.randomUUID();

  // ── Promo evaluation ────────────────────────────────────────────────
  // Same computation path and ledger as web checkout. The buyer is a
  // per-sale phantom, so the per-human cap can't bind (null, the anonymous
  // convention); the global maxRedemptions cap still applies.
  const promoEvaluation = await evaluatePromoApplications({
    codes: promoCodes,
    tx,
    event,
    buyerHumanId: null,
    now,
    orderSubtotalCents: faceComputation.amountGrossCents,
    ticketLines: faceComputation.ticketLines,
    ...(deps.logger ? { logger: deps.logger } : {}),
  });

  // ── Tax ─────────────────────────────────────────────────────────────
  // The read half of checkout's resolution, on this transaction, from the
  // lookup `prepareCheckoutTax` ran BEFORE it (NFR-002).
  const taxResolution = await resolveCheckoutTax(
    {
      taxRateLookup: deps.taxRateLookup,
      clock: deps.clock,
      reportError: deps.reportError,
    },
    tx,
    event,
    deps.logger,
    taxAfterCommit,
    preparedTax,
  );
  const taxSitus = taxResolution.situs;

  // ── Capacity (lock 1) ───────────────────────────────────────────────
  // Cash respects card holds: without this a cash sale could take the last
  // seat a card sale is holding mid-tap, stranding that buyer's charge.
  await assertPosCapacity(tx, {
    requests: input.items.map((it) => ({
      ticketTypeId: it.ticketTypeId,
      qty: it.qty,
    })),
    ticketTypesById: ttById,
    now,
  });

  // ── Seats (lock 2) ──────────────────────────────────────────────────
  const { seatsByType } = await pickSeats(tx, event, ttById, aggregatedItems);

  const priced = priceCart({
    channel: "DOOR_CASH",
    items: aggregatedItems,
    ticketTypes: ticketTypeMap,
    seatPrices,
    payoutTerms,
    now,
    promo: promoEvaluation,
    taxImpositions: taxResolution.impositions,
  });

  // ── The typed amount only works out change (owner ruling R4) ─────────
  if (input.amountCollectedCents < priced.chargeTotalCents) {
    throw fail("CASH_AMOUNT_SHORT", {
      message: "cash_amount_short",
      meta: {
        requiredTotalCents: priced.chargeTotalCents,
        amountCollectedCents: input.amountCollectedCents,
        shortByCents: priced.chargeTotalCents - input.amountCollectedCents,
        currency: event.currency ?? "usd",
      },
    });
  }
  const changeCents = input.amountCollectedCents - priced.chargeTotalCents;

  const items = priced.items;
  const seatLabels = attachSeats(items, seatsByType);

  // The buyer: a per-sale phantom (FR-004), or the guest Human for the email
  // the buyer gave (FR-011).
  const buyerHumanId = await resolveDoorBuyer(tx, input.buyerEmail);

  // What the card till writes for the same cart, minus both fees: face net
  // of discount, a 0 platform fee, tax + situs + tax lines, fee policy
  // snapshot (it records the policy, not a fee charged), and per-item
  // `buyerTotalCents` (each ticket's face), so
  // `computeExpectedPaymentAmount(order)` reads the cash total.
  //
  // FR-003 (organiser-resale-share): each ticket records the event's resale
  // clause in force at this sale, read in this transaction.
  const resaleClause = await resolveTicketResaleClause(tx, event);
  const created = await tx.orders.createPending({
    id: orderId,
    eventId: event.id,
    buyerHumanId,
    amountGrossCents: priced.amountGrossCents,
    feesPlatformCents: priced.feesPlatformCents,
    taxAmountCents: priced.taxAmountCents,
    currency: event.currency ?? "usd",
    feePolicySnapshot: priced.feePolicySnapshot,
    source: "PRIMARY",
    nonRefundable: priced.nonRefundable,
    items: stampTicketResaleClause(items, resaleClause),
    paymentChannel: "CASH",
    taxSitusCountry: taxSitus?.countryCode ?? null,
    taxSitusState: taxSitus?.region ?? null,
    taxSitusPostal: taxSitus?.postalCode ?? null,
    taxRateSource: taxResolution.rateSource,
  });

  // Per-imposition breakdown, same transaction and same solve as
  // `taxAmountCents` above (Σ PLATFORM lines === taxAmountCents).
  if (priced.orderTaxLines.length > 0) {
    await tx.orders.createTaxLines({
      orderId: created.id,
      lines: priced.orderTaxLines,
    });
  }

  // Cash finalises inline, so the hold's PENDING phase is a formality inside
  // this tx — create then confirm immediately. Confirmation writes the
  // PromoRedemption ledger row (the same single writer web checkout uses).
  await createPromoHolds(tx.promos, promoEvaluation.applications, {
    orderId: created.id,
    buyerHumanId,
    now,
  });
  if (promoEvaluation.applications.length > 0) {
    await tx.promos.confirmHoldsForOrder({
      orderId: created.id,
      confirmedAt: now,
    });
  }

  const finished = await finishCashOrder(deps, input, tx, created.id, event.id);

  // ── Ledger: the tax is the platform's to remit (FR-004, R6) ───────────
  // Same transaction as the order, so a taxed cash order never exists
  // without its debit. Keyed by the order id: one debit per cash order,
  // ever. Tax only: a cash sale carries no platform fee (owner ruling
  // 2026-10-08), so there is no fee to owe. A tax-free sale owes nothing and
  // writes no debit (and needs no payee). Cash orders recorded before the
  // ruling were debited fee + tax; their refunds reverse the debit row as
  // recorded (`refundCashOrderInTx`), never a recomputed amount.
  const owedCents = priced.taxAmountCents;
  let placeholderPayeeId: string | null = null;
  if (owedCents > 0) {
    const payee = await resolveCashSalePayee(tx, event.orgId, payeeRace);
    if (payee.placeholderCreated) placeholderPayeeId = payee.payeeId;
    await tx.payeeLedger.cashSaleDebit({
      idempotencyKey: cashSaleDebitKey(created.id),
      payeeId: payee.payeeId,
      amountCents: owedCents,
      currency: event.currency ?? "usd",
      orderId: created.id,
      description: `Door cash sale — tax, order ${formatOrderCode(created.id)}`,
      sourceKind: "pos_cash_sale",
      sourceId: created.id,
      metadata: {
        eventId: event.id,
        taxAmountCents: priced.taxAmountCents,
        chargeTotalCents: priced.chargeTotalCents,
      },
    });
  }

  return {
    orderId: created.id,
    ticketCount: finished.ticketCodes.length,
    ticketCodes: finished.ticketCodes,
    seatLabels,
    amountCents: priced.chargeTotalCents,
    amountCollectedCents: input.amountCollectedCents,
    changeCents,
    discountCents: priced.discountCents,
    // What was redeemed, not what was typed: the codes `createPromoHolds`
    // wrote above (membership benefits never apply to a door buyer).
    promoCodes: promoEvaluation.applications.flatMap((application) =>
      application.kind === "code" ? [application.code.normalized] : [],
    ),
    feesPlatformCents: priced.feesPlatformCents,
    taxAmountCents: priced.taxAmountCents,
    expectedDueCents: priced.chargeTotalCents,
    isComp: false,
    autoAdmitted: finished.autoAdmitted,
    placeholderPayeeId,
  };
}
