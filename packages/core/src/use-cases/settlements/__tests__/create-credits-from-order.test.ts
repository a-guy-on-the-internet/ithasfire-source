import { describe, it, expect, vi } from "vitest";
import {
  attributeCreditToItems,
  createCreditsFromOrder,
} from "../create-credits-from-order";
import { computePayoutDate } from "../../../lib/payout-scheduling";

const ORDER_ID = "731ec309-a9d8-49f0-8caf-0e67f4c00ac5";
const PAYEE_A = "731ec309-a9d8-49f0-8caf-0e67f4c00ac7";
const PAYEE_B = "731ec309-a9d8-49f0-8caf-0e67f4c00ac9";
const EVENT_ID = "731ec309-a9d8-49f0-8caf-0e67f4c00aca";
const TERMS_ID = "731ec309-a9d8-49f0-8caf-0e67f4c00acb";

const NOW = new Date("2026-03-01T12:00:00.000Z");
// Wed 2026-03-11; WEEK_OF_EVENT matures on the Sunday of the event's week
// (midnight America/Chicago) — Sun 2026-03-15.
const EVENT_ENDS_AT = new Date("2026-03-11T20:00:00.000Z");

type Split = { orderSplitId: string; payeeId: string; amountCents: number };
type Item = {
  id: string;
  kind: string;
  amountCents: number;
  /**
   * Stamped by `createResaleCheckout` on a RESALE order's ticket items.
   * Optional on the fixture for brevity; the harness normalises it to the
   * adapter's shape (`Date | null`, never undefined) before the use case
   * sees it, so no test exercises a shape the adapter cannot produce.
   */
  resalePayoutReleaseAt?: Date | null;
};

function makeHarness(
  overrides: {
    order?: Record<string, unknown> | null;
    event?: Record<string, unknown> | null;
    payoutTerms?: Record<string, unknown> | null;
    splits?: Split[];
    items?: Item[];
    instantPayouts?: boolean;
    /** Charge time. Credits are minted at order finalization, so this IS the charge. */
    now?: Date;
    /**
     * `Order.paymentMethodType`. The floor deliberately does NOT branch on it;
     * the override exists so a test can prove that.
     */
    paymentMethodType?: string | null;
  } = {},
) {
  const now = overrides.now ?? NOW;
  const order =
    overrides.order === undefined
      ? {
          id: ORDER_ID,
          eventId: EVENT_ID,
          status: "SUCCEEDED",
          disputeStatus: "NONE",
          currency: "usd",
          paymentMethodType: overrides.paymentMethodType ?? null,
        }
      : overrides.order;
  const event =
    overrides.event === undefined
      ? {
          id: EVENT_ID,
          startsAt: EVENT_ENDS_AT,
          endsAt: EVENT_ENDS_AT,
          payoutTermsId: TERMS_ID,
          agreementPrimaryId: null,
        }
      : overrides.event;
  const payoutTerms =
    overrides.payoutTerms === undefined
      ? { id: TERMS_ID, payoutSchedule: "WEEK_OF_EVENT" }
      : overrides.payoutTerms;
  const splits = overrides.splits ?? [
    { orderSplitId: "split-1", payeeId: PAYEE_A, amountCents: 4675 },
  ];
  const items: Item[] = overrides.items ?? [
    { id: "item-1", kind: "ticket", amountCents: 5000 },
  ];

  let entrySeq = 0;
  const settlementCredit = vi.fn(async (input: Record<string, unknown>) => {
    entrySeq += 1;
    return {
      id: `entry-${entrySeq}`,
      ...input,
      type: "SETTLEMENT_CREDIT",
      createdAt: now,
    };
  });

  const tx = {
    orders: { getById: vi.fn(async () => order) },
    events: { getById: vi.fn(async () => event) },
    payoutTerms: { getById: vi.fn(async () => payoutTerms) },
    splits: { getForOrder: vi.fn(async () => splits) },
    orderItems: {
      listByOrderId: vi.fn(async () =>
        items.map((item) => ({
          ...item,
          resalePayoutReleaseAt: item.resalePayoutReleaseAt ?? null,
        })),
      ),
    },
    payeeLedger: { settlementCredit },
    audit: { log: vi.fn(async () => {}) },
  };

  const deps = {
    repos: { tx: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) },
    clock: { now: () => now },
    ...(overrides.instantPayouts ? { instantPayouts: true } : {}),
  } as never as Parameters<typeof createCreditsFromOrder>[0];

  return { deps, tx, settlementCredit };
}

describe("createCreditsFromOrder", () => {
  it("writes ONE credit per payee with exact cents, keys and maturity", async () => {
    const h = makeHarness({
      splits: [
        { orderSplitId: "split-1", payeeId: PAYEE_A, amountCents: 3000 },
        { orderSplitId: "split-2", payeeId: PAYEE_B, amountCents: 1500 },
        // A second split for payee A folds into the SAME credit.
        { orderSplitId: "split-3", payeeId: PAYEE_A, amountCents: 175 },
      ],
      items: [{ id: "item-1", kind: "ticket", amountCents: 5000 }],
    });

    const result = await createCreditsFromOrder(h.deps, { orderId: ORDER_ID });

    const expectedAvailableAt = computePayoutDate(
      EVENT_ENDS_AT,
      "WEEK_OF_EVENT",
    );
    // Pin the actual instant, not just the helper round-trip: Sunday of the
    // event's week at midnight America/Chicago (CDT, UTC-5 in March 2026).
    expect(expectedAvailableAt.toISOString()).toBe(
      "2026-03-15T05:00:00.000Z",
    );

    expect(h.settlementCredit).toHaveBeenCalledTimes(2);
    expect(h.settlementCredit).toHaveBeenCalledWith({
      idempotencyKey: `settlement-credit:${ORDER_ID}:${PAYEE_A}`,
      payeeId: PAYEE_A,
      amountCents: 3175,
      currency: "usd",
      orderId: ORDER_ID,
      availableAt: expectedAvailableAt,
      // formatOrderCode = last 8 hex of the uuid, uppercased.
      description: "Ticket revenue — order F4C00AC5",
      metadata: { items: { "item-1": 3175 } },
      sourceKind: "order_split",
      sourceId: ORDER_ID,
    });
    expect(h.settlementCredit).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `settlement-credit:${ORDER_ID}:${PAYEE_B}`,
        payeeId: PAYEE_B,
        amountCents: 1500,
        availableAt: expectedAvailableAt,
      }),
    );

    expect(result).toEqual({
      orderId: ORDER_ID,
      credits: [
        { entryId: "entry-1", payeeId: PAYEE_A, amountCents: 3175 },
        { entryId: "entry-2", payeeId: PAYEE_B, amountCents: 1500 },
      ],
      skippedZeroAmount: [],
    });
  });

  it("matures immediately (clock.now) when instantPayouts is set", async () => {
    const h = makeHarness({ instantPayouts: true });

    await createCreditsFromOrder(h.deps, { orderId: ORDER_ID });

    expect(h.settlementCredit).toHaveBeenCalledWith(
      expect.objectContaining({ availableAt: NOW }),
    );
  });

  it("attributes the credit across ticket items proportionally, last item taking the remainder", async () => {
    // 60/40 items, payee amount 1001: item-1 = round(0.6 × 1001) = 601,
    // item-2 (last) = 1001 − 601 = 400. Σ contributions === amountCents.
    const h = makeHarness({
      splits: [{ orderSplitId: "split-1", payeeId: PAYEE_A, amountCents: 1001 }],
      items: [
        { id: "item-1", kind: "ticket", amountCents: 600 },
        { id: "item-2", kind: "ticket", amountCents: 400 },
        // Non-ticket items are excluded from the attribution basis.
        { id: "item-3", kind: "donation", amountCents: 9999 },
      ],
    });

    await createCreditsFromOrder(h.deps, { orderId: ORDER_ID });

    expect(h.settlementCredit).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 1001,
        metadata: { items: { "item-1": 601, "item-2": 400 } },
      }),
    );
    const metadata = h.settlementCredit.mock.calls[0]![0]!.metadata as {
      items: Record<string, number>;
    };
    const attributed = Object.values(metadata.items).reduce((a, b) => a + b, 0);
    expect(attributed).toBe(1001);
  });

  it("attributes nothing to a ticket a discount brought down to $0", async () => {
    // Owner ruling 2026-10-11: a refund of a $0 ticket returns $0. The
    // REFUND_DEBIT and the transfer reversal both read this attribution, so
    // a ticket that earned the payee nothing must carry none of the credit.
    // The shape of dev order f425308e: a freed $125 VIP beside a paid $50 GA;
    // the payee is credited 5000 − 50 = 4950. By face it was 3536 / 1414.
    const h = makeHarness({
      splits: [{ orderSplitId: "split-1", payeeId: PAYEE_A, amountCents: 4950 }],
      items: [
        { id: "discount", kind: "discount", amountCents: -12_500 },
        {
          id: "vip",
          kind: "ticket",
          amountCents: 12_500,
          meta: { buyerTotalCents: 12_500, discountedToZero: true },
        } as Item,
        {
          id: "ga",
          kind: "ticket",
          amountCents: 5_000,
          meta: { buyerTotalCents: 5_245 },
        } as Item,
      ],
    });

    await createCreditsFromOrder(h.deps, { orderId: ORDER_ID });

    expect(h.settlementCredit).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 4950,
        metadata: { items: { ga: 4950 } },
      }),
    );
  });

  it("still attributes by face to a ticket discounted to an amount above $0", async () => {
    const h = makeHarness({
      splits: [{ orderSplitId: "split-1", payeeId: PAYEE_A, amountCents: 1000 }],
      items: [
        { id: "discount", kind: "discount", amountCents: -300 },
        { id: "item-1", kind: "ticket", amountCents: 600 },
        { id: "item-2", kind: "ticket", amountCents: 400 },
      ],
    });

    await createCreditsFromOrder(h.deps, { orderId: ORDER_ID });

    expect(h.settlementCredit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { items: { "item-1": 600, "item-2": 400 } },
      }),
    );
  });

  it("writes metadata { items: {} } when the order has no ticket items", async () => {
    const h = makeHarness({ items: [] });

    await createCreditsFromOrder(h.deps, { orderId: ORDER_ID });

    expect(h.settlementCredit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { items: {} } }),
    );
  });

  it("skips a zero-amount payee (no credit; noted in output and audit)", async () => {
    const h = makeHarness({
      splits: [
        { orderSplitId: "split-1", payeeId: PAYEE_A, amountCents: 5000 },
        { orderSplitId: "split-2", payeeId: PAYEE_B, amountCents: 0 },
      ],
    });

    const result = await createCreditsFromOrder(h.deps, { orderId: ORDER_ID });

    expect(h.settlementCredit).toHaveBeenCalledTimes(1);
    expect(h.settlementCredit).toHaveBeenCalledWith(
      expect.objectContaining({ payeeId: PAYEE_A, amountCents: 5000 }),
    );
    expect(result.credits).toHaveLength(1);
    expect(result.skippedZeroAmount).toEqual([PAYEE_B]);

    expect(h.tx.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "payee_ledger",
        action: "credits_created_from_order",
        data: expect.objectContaining({
          orderId: ORDER_ID,
          skippedZeroAmount: [PAYEE_B],
        }),
      }),
    );
  });

  it("writes the audit row inside the transaction with per-payee amounts", async () => {
    const h = makeHarness({
      splits: [
        { orderSplitId: "split-1", payeeId: PAYEE_A, amountCents: 3000 },
        { orderSplitId: "split-2", payeeId: PAYEE_B, amountCents: 1500 },
      ],
    });

    await createCreditsFromOrder(h.deps, { orderId: ORDER_ID });

    expect(h.tx.audit.log).toHaveBeenCalledTimes(1);
    expect(h.tx.audit.log).toHaveBeenCalledWith({
      entity: "payee_ledger",
      entityId: null,
      action: "credits_created_from_order",
      data: {
        orderId: ORDER_ID,
        credits: [
          { payeeId: PAYEE_A, amountCents: 3000 },
          { payeeId: PAYEE_B, amountCents: 1500 },
        ],
        skippedZeroAmount: [],
        availableAt: "2026-03-15T05:00:00.000Z",
        resaleReleaseAt: null,
      },
      at: NOW,
    });
  });

  // ── Guards (preserved from createSettlementsFromOrder) ────────────────────

  it("rejects a missing order", async () => {
    const h = makeHarness({ order: null });

    await expect(
      createCreditsFromOrder(h.deps, { orderId: ORDER_ID }),
    ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
    expect(h.settlementCredit).not.toHaveBeenCalled();
  });

  it("rejects an order that is not SUCCEEDED", async () => {
    const h = makeHarness({
      order: {
        id: ORDER_ID,
        eventId: EVENT_ID,
        status: "PENDING",
        disputeStatus: "NONE",
        currency: "usd",
      },
    });

    await expect(
      createCreditsFromOrder(h.deps, { orderId: ORDER_ID }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: "order_not_succeeded",
      status: "PENDING",
    });
    expect(h.settlementCredit).not.toHaveBeenCalled();
  });

  // Deliberately NO dispute-status guard (Step B review finding): the payable
  // query is the SINGLE dispute enforcement point (spec §5). Blocking the
  // WRITE would leave a payee punished by dispute holds/debits (written from
  // the splits, which exist independently) with no credit to net against —
  // permanently, for terminal LOST. The credit must be writable on an
  // operator re-drive regardless of dispute state.
  it.each(["OPEN", "UNDER_REVIEW", "LOST"])(
    "writes credits even when the order is %s disputed — dispute handling lives in the payable query",
    async (disputeStatus) => {
      const h = makeHarness({
        order: {
          id: ORDER_ID,
          eventId: EVENT_ID,
          status: "SUCCEEDED",
          disputeStatus,
          currency: "usd",
        },
      });

      const out = await createCreditsFromOrder(h.deps, { orderId: ORDER_ID });
      expect(out.credits.length).toBeGreaterThan(0);
      expect(h.settlementCredit).toHaveBeenCalled();
      expect(h.tx.audit.log).toHaveBeenCalled();
    },
  );

  it("rejects when the event carries no payout terms reference", async () => {
    const h = makeHarness({
      event: {
        id: EVENT_ID,
        startsAt: EVENT_ENDS_AT,
        endsAt: EVENT_ENDS_AT,
        payoutTermsId: null,
        agreementPrimaryId: null,
      },
    });

    await expect(
      createCreditsFromOrder(h.deps, { orderId: ORDER_ID }),
    ).rejects.toMatchObject({ code: "EVENT_MISSING_PAYOUT_TERMS" });
    expect(h.settlementCredit).not.toHaveBeenCalled();
  });

  it("rejects when the payout terms row is missing", async () => {
    const h = makeHarness({ payoutTerms: null });

    await expect(
      createCreditsFromOrder(h.deps, { orderId: ORDER_ID }),
    ).rejects.toMatchObject({ code: "AGREEMENT_NOT_FOUND" });
    expect(h.settlementCredit).not.toHaveBeenCalled();
  });

  it("rejects when the order has no splits", async () => {
    const h = makeHarness({ splits: [] });

    await expect(
      createCreditsFromOrder(h.deps, { orderId: ORDER_ID }),
    ).rejects.toMatchObject({ code: "NO_SPLITS_FOUND" });
    expect(h.settlementCredit).not.toHaveBeenCalled();
  });

  it("falls back to agreementPrimaryId when payoutTermsId is unset", async () => {
    const h = makeHarness({
      event: {
        id: EVENT_ID,
        startsAt: EVENT_ENDS_AT,
        endsAt: EVENT_ENDS_AT,
        payoutTermsId: null,
        agreementPrimaryId: TERMS_ID,
      },
    });

    await createCreditsFromOrder(h.deps, { orderId: ORDER_ID });

    expect(h.tx.payoutTerms.getById).toHaveBeenCalledWith(TERMS_ID);
    expect(h.settlementCredit).toHaveBeenCalledTimes(1);
  });

  it("uses startsAt when the event has no endsAt", async () => {
    const h = makeHarness({
      event: {
        id: EVENT_ID,
        startsAt: EVENT_ENDS_AT,
        endsAt: null,
        payoutTermsId: TERMS_ID,
        agreementPrimaryId: null,
      },
    });

    await createCreditsFromOrder(h.deps, { orderId: ORDER_ID });

    expect(h.settlementCredit).toHaveBeenCalledWith(
      expect.objectContaining({
        availableAt: computePayoutDate(EVENT_ENDS_AT, "WEEK_OF_EVENT"),
      }),
    );
  });

  it("propagates a repo failure (retry path: the caller's swallow + idempotent keys re-drive it)", async () => {
    const h = makeHarness();
    h.settlementCredit.mockRejectedValueOnce(new Error("ledger down"));

    await expect(
      createCreditsFromOrder(h.deps, { orderId: ORDER_ID }),
    ).rejects.toThrow("ledger down");
    // Nothing after the throw: the audit row never lands outside the tx.
    expect(h.tx.audit.log).not.toHaveBeenCalled();
  });

  describe("Stripe availability floor on credit maturity", () => {
    // `run-batch` transfers WITHOUT `source_transaction`, so it spends the
    // platform's AVAILABLE balance. Maturity must therefore never be earlier
    // than the charge can clear: a flat 2 business days, every method.
    //
    // Saturday 2026-03-14 23:00 CDT door sale. Central weekday matters:
    // 23:00 CDT is 2026-03-15T04:00Z, a Sunday in UTC.
    const SATURDAY_DOOR_SALE = new Date("2026-03-14T23:00:00-05:00");

    function doorSaleHarness(opts: {
      schedule?: string;
      paymentMethodType?: string | null;
      instantPayouts?: boolean;
    } = {}) {
      return makeHarness({
        now: SATURDAY_DOOR_SALE,
        paymentMethodType: opts.paymentMethodType ?? null,
        instantPayouts: opts.instantPayouts,
        event: {
          id: EVENT_ID,
          startsAt: SATURDAY_DOOR_SALE,
          endsAt: SATURDAY_DOOR_SALE,
          payoutTermsId: TERMS_ID,
          agreementPrimaryId: null,
        },
        payoutTerms: {
          id: TERMS_ID,
          payoutSchedule: opts.schedule ?? "ASAP",
        },
      });
    }

    function availableAtOf(settlementCredit: { mock: { calls: unknown[][] } }) {
      const call = settlementCredit.mock.calls[0]?.[0] as {
        availableAt: Date;
      };
      return call.availableAt;
    }

    it("moves a Saturday-night door sale from Sunday to Wednesday (card)", async () => {
      // WITHOUT the floor this is Sun 2026-03-15 — Monday's batch would try
      // to transfer money still sitting in Stripe's `pending` balance.
      expect(
        computePayoutDate(SATURDAY_DOOR_SALE, "ASAP").toISOString(),
      ).toBe("2026-03-15T05:00:00.000Z");

      const h = doorSaleHarness();
      await createCreditsFromOrder(h.deps, { orderId: ORDER_ID });

      // Saturday charge → Monday is day 0 → available Wednesday.
      expect(availableAtOf(h.settlementCredit).toISOString()).toBe(
        "2026-03-18T05:00:00.000Z",
      );
    });

    it("gives an ACH order the SAME floor as a card order — no per-method branch", async () => {
      // A 4-business-day ACH branch used to live here. It was wrong: Stripe
      // puts ACH settlement at "4 business days from PAYMENT CREATION"
      // (https://docs.stripe.com/payments/ach-direct-debit) and
      // `payment_intent.succeeded` for ACH already sits at that ~T+4 mark, so
      // a second 4-day wait double-counts the same window. Reading
      // `paymentMethodType` was also racy — the webhook writes it after
      // finalize on the card path, and skips the early ACH write whenever the
      // browser's confirm-payment call has already moved the order out of
      // PENDING.
      //
      // If someone re-adds the branch, this test is what they have to argue
      // with.
      const results: string[] = [];
      for (const paymentMethodType of [
        "us_bank_account",
        "card",
        null,
        "cashapp",
      ]) {
        const h = doorSaleHarness({ paymentMethodType });
        await createCreditsFromOrder(h.deps, { orderId: ORDER_ID });
        results.push(availableAtOf(h.settlementCredit).toISOString());
      }

      expect(results).toEqual([
        "2026-03-18T05:00:00.000Z",
        "2026-03-18T05:00:00.000Z",
        "2026-03-18T05:00:00.000Z",
        "2026-03-18T05:00:00.000Z",
      ]);
    });

    it("is a NO-OP for an advance sale weeks ahead of the event", async () => {
      // Sold Mon 2026-02-23 for an event on Wed 2026-03-11. ASAP matures
      // Thu 2026-03-12, far past the Wed 2026-02-25 floor.
      const h = makeHarness({
        now: new Date("2026-02-23T15:00:00-06:00"),
        payoutTerms: { id: TERMS_ID, payoutSchedule: "ASAP" },
      });
      await createCreditsFromOrder(h.deps, { orderId: ORDER_ID });

      const scheduled = computePayoutDate(EVENT_ENDS_AT, "ASAP");
      expect(scheduled.toISOString()).toBe("2026-03-12T05:00:00.000Z");
      expect(availableAtOf(h.settlementCredit).toISOString()).toBe(
        scheduled.toISOString(),
      );
    });

    it("composes with the WEEK_OF_EVENT roll-forward instead of fighting it", async () => {
      // A Saturday event's WEEK_OF_EVENT payout now rolls to the FOLLOWING
      // Sunday (2026-03-22), which is already past the Wednesday floor — so
      // the schedule wins and the floor changes nothing.
      const h = doorSaleHarness({ schedule: "WEEK_OF_EVENT" });
      await createCreditsFromOrder(h.deps, { orderId: ORDER_ID });

      expect(availableAtOf(h.settlementCredit).toISOString()).toBe(
        "2026-03-22T05:00:00.000Z",
      );
    });

    it("records the FLOORED date on the audit row, not the raw schedule", async () => {
      const h = doorSaleHarness();
      await createCreditsFromOrder(h.deps, { orderId: ORDER_ID });

      expect(h.tx.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            availableAt: "2026-03-18T05:00:00.000Z",
          }),
        }),
      );
    });

    it("instantPayouts still bypasses the floor entirely (dev/e2e stack)", async () => {
      const h = doorSaleHarness({ instantPayouts: true });
      await createCreditsFromOrder(h.deps, { orderId: ORDER_ID });

      // Exactly `clock.now()` — not the schedule, not the floor.
      expect(availableAtOf(h.settlementCredit).toISOString()).toBe(
        SATURDAY_DOOR_SALE.toISOString(),
      );
    });

    it("pins the default fixture to an absolute instant (schedule wins over floor)", async () => {
      // Sold Sun 2026-03-01 for a Wed 2026-03-11 event on WEEK_OF_EVENT. The
      // schedule is Sun 2026-03-15; the floor is Wed 2026-03-04. Asserted as a
      // literal, NOT by re-running the helpers — a helper round-trip passes
      // for any consistent pair of wrong implementations.
      const h = makeHarness();
      await createCreditsFromOrder(h.deps, { orderId: ORDER_ID });

      expect(availableAtOf(h.settlementCredit).toISOString()).toBe(
        "2026-03-15T05:00:00.000Z",
      );
    });
  });

  describe("resale claim-window hold on credit maturity", () => {
    // A resold ticket's buyer can file a claim until the listing's
    // `resalePayoutReleaseAt`; the seller's credit must not mature before
    // that. Money audit 2026-09-08: the field was stamped by
    // `createResaleCheckout` and read by NOTHING, so a resale sold just before
    // the event matured at the schedule date and an approved claim had no
    // held money to unwind against.
    //
    // Default fixture: WEEK_OF_EVENT schedule → Sun 2026-03-15T05:00Z.
    const SCHEDULE_AT = "2026-03-15T05:00:00.000Z";
    const RELEASE_AFTER_SCHEDULE = new Date("2026-03-20T12:00:00.000Z");
    const RELEASE_BEFORE_SCHEDULE = new Date("2026-03-10T12:00:00.000Z");

    function resaleOrder(source: "RESALE" | "PRIMARY" = "RESALE") {
      return {
        id: ORDER_ID,
        eventId: EVENT_ID,
        status: "SUCCEEDED",
        disputeStatus: "NONE",
        currency: "usd",
        source,
        paymentMethodType: null,
      };
    }

    function availableAtOf(settlementCredit: { mock: { calls: unknown[][] } }) {
      const call = settlementCredit.mock.calls[0]?.[0] as {
        availableAt: Date;
      };
      return call.availableAt;
    }

    it("(a) holds a RESALE credit until resalePayoutReleaseAt when that is AFTER the schedule date", async () => {
      const h = makeHarness({
        order: resaleOrder("RESALE"),
        items: [
          {
            id: "item-1",
            kind: "ticket",
            amountCents: 5000,
            resalePayoutReleaseAt: RELEASE_AFTER_SCHEDULE,
          },
        ],
      });
      await createCreditsFromOrder(h.deps, { orderId: ORDER_ID });

      expect(availableAtOf(h.settlementCredit).toISOString()).toBe(
        "2026-03-20T12:00:00.000Z",
      );
      // The audit row records the HELD date, not the raw schedule.
      expect(h.tx.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            availableAt: "2026-03-20T12:00:00.000Z",
          }),
        }),
      );
    });

    it("(b) leaves a RESALE credit on the schedule date when resalePayoutReleaseAt is BEFORE it (later wins)", async () => {
      const h = makeHarness({
        order: resaleOrder("RESALE"),
        items: [
          {
            id: "item-1",
            kind: "ticket",
            amountCents: 5000,
            resalePayoutReleaseAt: RELEASE_BEFORE_SCHEDULE,
          },
        ],
      });
      await createCreditsFromOrder(h.deps, { orderId: ORDER_ID });

      expect(availableAtOf(h.settlementCredit).toISOString()).toBe(SCHEDULE_AT);
    });

    it("(c) instantPayouts does NOT bypass the claim window — a RESALE credit still matures at resalePayoutReleaseAt", async () => {
      // A dev/e2e stack with instant payouts must still hold a resale
      // seller's money through the claim window, or the claim-approval unwind
      // is exercisable only in production.
      const h = makeHarness({
        order: resaleOrder("RESALE"),
        instantPayouts: true,
        items: [
          {
            id: "item-1",
            kind: "ticket",
            amountCents: 5000,
            resalePayoutReleaseAt: RELEASE_AFTER_SCHEDULE,
          },
        ],
      });
      await createCreditsFromOrder(h.deps, { orderId: ORDER_ID });

      expect(availableAtOf(h.settlementCredit).toISOString()).toBe(
        "2026-03-20T12:00:00.000Z",
      );
      expect(availableAtOf(h.settlementCredit).toISOString()).not.toBe(
        NOW.toISOString(),
      );
    });

    it("(d) ignores resalePayoutReleaseAt on a PRIMARY order's item", async () => {
      const h = makeHarness({
        order: resaleOrder("PRIMARY"),
        items: [
          {
            id: "item-1",
            kind: "ticket",
            amountCents: 5000,
            resalePayoutReleaseAt: RELEASE_AFTER_SCHEDULE,
          },
        ],
      });
      await createCreditsFromOrder(h.deps, { orderId: ORDER_ID });

      expect(availableAtOf(h.settlementCredit).toISOString()).toBe(SCHEDULE_AT);
    });

    it("(e) a RESALE item with resalePayoutReleaseAt: null (legacy row) adds no hold", async () => {
      const h = makeHarness({
        order: resaleOrder("RESALE"),
        items: [
          {
            id: "item-1",
            kind: "ticket",
            amountCents: 5000,
            resalePayoutReleaseAt: null,
          },
        ],
      });
      await createCreditsFromOrder(h.deps, { orderId: ORDER_ID });

      expect(availableAtOf(h.settlementCredit).toISOString()).toBe(SCHEDULE_AT);
    });

    it("(f) takes the LATEST release across a multi-item RESALE order, skipping nulls", async () => {
      const h = makeHarness({
        order: resaleOrder("RESALE"),
        items: [
          {
            id: "item-1",
            kind: "ticket",
            amountCents: 2500,
            resalePayoutReleaseAt: RELEASE_BEFORE_SCHEDULE,
          },
          {
            id: "item-2",
            kind: "ticket",
            amountCents: 2500,
            resalePayoutReleaseAt: null,
          },
          {
            id: "item-3",
            kind: "ticket",
            amountCents: 2500,
            resalePayoutReleaseAt: RELEASE_AFTER_SCHEDULE,
          },
        ],
      });
      await createCreditsFromOrder(h.deps, { orderId: ORDER_ID });

      expect(availableAtOf(h.settlementCredit).toISOString()).toBe(
        "2026-03-20T12:00:00.000Z",
      );
    });

    // ── Claim-window floor ────────────────────────────────────────────────
    // An organiser's release window used to accept 0 days, so a listing can
    // carry a `resalePayoutReleaseAt` BEFORE the claim window (endsAt + 3d)
    // closes. The credit must still not mature until the window closes, or
    // the seller is paid while the buyer can still file.
    //
    // Default fixture endsAt Wed 2026-03-11T20:00Z → window closes
    // Sat 2026-03-14T20:00Z. A DAILY schedule matures well before that.
    const CLAIM_CLOSE = "2026-03-14T20:00:00.000Z";

    it("(g) floors a release stamped BEFORE the claim window at the window's close", async () => {
      const h = makeHarness({
        order: resaleOrder("RESALE"),
        // Charged long before the event so the availability floor is moot.
        now: new Date("2026-03-01T12:00:00.000Z"),
        payoutTerms: { id: TERMS_ID, payoutSchedule: "ASAP" },
        items: [
          {
            id: "item-1",
            kind: "ticket",
            amountCents: 5000,
            // A 0-day policy: release == event end, inside the claim window.
            resalePayoutReleaseAt: EVENT_ENDS_AT,
          },
        ],
      });
      await createCreditsFromOrder(h.deps, { orderId: ORDER_ID });

      expect(availableAtOf(h.settlementCredit).toISOString()).toBe(CLAIM_CLOSE);
      expect(h.tx.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            availableAt: CLAIM_CLOSE,
            resaleReleaseAt: CLAIM_CLOSE,
          }),
        }),
      );
    });

    it("(h) instantPayouts + a legacy NULL release still holds a RESALE credit to the claim window's close", async () => {
      const h = makeHarness({
        order: resaleOrder("RESALE"),
        instantPayouts: true,
        items: [
          {
            id: "item-1",
            kind: "ticket",
            amountCents: 5000,
            resalePayoutReleaseAt: null,
          },
        ],
      });
      await createCreditsFromOrder(h.deps, { orderId: ORDER_ID });

      expect(availableAtOf(h.settlementCredit).toISOString()).toBe(CLAIM_CLOSE);
    });

    it("(i) the floor applies to EVERY payee on the order — seller and organiser mature together", async () => {
      const h = makeHarness({
        order: resaleOrder("RESALE"),
        instantPayouts: true,
        splits: [
          { orderSplitId: "split-seller", payeeId: PAYEE_A, amountCents: 5000 },
          { orderSplitId: "split-org", payeeId: PAYEE_B, amountCents: 1000 },
        ],
        items: [
          {
            id: "item-1",
            kind: "ticket",
            amountCents: 6000,
            resalePayoutReleaseAt: EVENT_ENDS_AT,
          },
        ],
      });
      await createCreditsFromOrder(h.deps, { orderId: ORDER_ID });

      const availableAts = h.settlementCredit.mock.calls.map((call) =>
        (call[0] as { availableAt: Date }).availableAt.toISOString(),
      );
      expect(availableAts).toEqual([CLAIM_CLOSE, CLAIM_CLOSE]);
    });

    it("(j) a PRIMARY order gets no claim-window floor", async () => {
      const h = makeHarness({
        order: resaleOrder("PRIMARY"),
        instantPayouts: true,
      });
      await createCreditsFromOrder(h.deps, { orderId: ORDER_ID });

      expect(availableAtOf(h.settlementCredit).toISOString()).toBe(
        NOW.toISOString(),
      );
    });
  });
});

describe("attributeCreditToItems", () => {
  it("distributes proportionally with the last item absorbing the remainder", () => {
    expect(
      attributeCreditToItems(
        [
          { id: "a", amountCents: 600 },
          { id: "b", amountCents: 400 },
        ],
        1001,
      ),
    ).toEqual({ a: 601, b: 400 });
  });

  it("returns {} for no items or a zero item total", () => {
    expect(attributeCreditToItems([], 500)).toEqual({});
    expect(attributeCreditToItems([{ id: "a", amountCents: 0 }], 500)).toEqual(
      {},
    );
  });

  it("omits items whose share rounds to zero", () => {
    // 1-cent credit over a 60/40 basis: round(0.6) = 1 to the first item,
    // remainder 0 to the last — which is omitted, not written as 0.
    expect(
      attributeCreditToItems(
        [
          { id: "a", amountCents: 600 },
          { id: "b", amountCents: 400 },
        ],
        1,
      ),
    ).toEqual({ a: 1 });
  });

  // Review finding, 2026-10-11: the remainder used to go to the LAST item
  // whatever it weighed. A ticket a discount brought down to $0 weighs 0
  // (`refundFaceWeightCents`); the leftover cent put it in the payout plan and
  // made its $0 refund write a 1¢ REFUND_DEBIT.
  it("gives the rounding remainder to the last item that weighs anything, never to a zero-weight item", () => {
    // Three 5000 tickets, the last one freed by a code; credit 14851. Each
    // paid ticket's rounded share is 7426, which overshoots by 1: the second
    // paid ticket absorbs it and the freed ticket gets nothing.
    const freedLast = attributeCreditToItems(
      [
        { id: "paid-1", amountCents: 5000 },
        { id: "paid-2", amountCents: 5000 },
        { id: "freed", amountCents: 0 },
      ],
      14851,
    );
    expect(freedLast).toEqual({ "paid-1": 7426, "paid-2": 7425 });
    expect(freedLast).not.toHaveProperty("freed");

    // The shape the finding measured: an undershoot, where the last item was
    // handed the cent the rounding left over.
    const undershoot = attributeCreditToItems(
      [
        { id: "paid-1", amountCents: 5000 },
        { id: "paid-2", amountCents: 5000 },
        { id: "paid-3", amountCents: 5000 },
        { id: "freed", amountCents: 0 },
      ],
      14851,
    );
    expect(undershoot).toEqual({
      "paid-1": 4950,
      "paid-2": 4950,
      "paid-3": 4951,
    });
    expect(undershoot).not.toHaveProperty("freed");

    // Zero-weight items in the middle and at the end.
    expect(
      attributeCreditToItems(
        [
          { id: "freed-1", amountCents: 0 },
          { id: "paid", amountCents: 5000 },
          { id: "freed-2", amountCents: 0 },
          { id: "freed-3", amountCents: 0 },
        ],
        4950,
      ),
    ).toEqual({ paid: 4950 });
  });

  it("returns {} when every item weighs 0 (unchanged: nothing to attribute against)", () => {
    expect(
      attributeCreditToItems(
        [
          { id: "freed-1", amountCents: 0 },
          { id: "freed-2", amountCents: 0 },
        ],
        500,
      ),
    ).toEqual({});
  });

  // Regression pins (Step B review): unclamped Math.round overshot on small
  // amounts, writing Σ(items) > amount into FROZEN append-only metadata that
  // Step C's partial-refund math reads. Σ === amount is a hard invariant.
  it("never over-attributes when rounded shares overshoot ([1,1,1,1] / 2)", () => {
    const out = attributeCreditToItems(
      [
        { id: "a", amountCents: 1 },
        { id: "b", amountCents: 1 },
        { id: "c", amountCents: 1 },
        { id: "d", amountCents: 1 },
      ],
      2,
    );
    expect(Object.values(out).reduce((s, v) => s + v, 0)).toBe(2);
    expect(out).toEqual({ a: 1, b: 1 });
  });

  it("never over-attributes on the [3,3,3,3,2] / 7 shape", () => {
    const out = attributeCreditToItems(
      [
        { id: "a", amountCents: 3 },
        { id: "b", amountCents: 3 },
        { id: "c", amountCents: 3 },
        { id: "d", amountCents: 3 },
        { id: "e", amountCents: 2 },
      ],
      7,
    );
    // Unclamped: four non-last shares of round(1.5)=2 → Σ 8 ≠ 7.
    expect(Object.values(out).reduce((s, v) => s + v, 0)).toBe(7);
  });

  it("Σ(items) === amount holds across a randomized sweep", () => {
    // Cheap property pin: 500 random shapes, exact conservation every time.
    let seed = 424242;
    const rand = (max: number) => {
      // LCG — deterministic, no Math.random in tests that assert money math.
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return (seed % max) + 1;
    };
    for (let n = 0; n < 500; n++) {
      const items = Array.from({ length: rand(6) }, (_, i) => ({
        id: `i${i}`,
        amountCents: rand(500),
      }));
      const amount = rand(2000);
      const out = attributeCreditToItems(items, amount);
      const sum = Object.values(out).reduce((s, v) => s + v, 0);
      expect(sum).toBe(amount);
    }
  });
});
