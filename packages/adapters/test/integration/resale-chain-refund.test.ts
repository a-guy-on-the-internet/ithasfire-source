/**
 * A ticket bought on resale can be listed and sold again, any number of times
 * (owner ruling 2026-10-11). This file drives the REAL sale and refund code
 * (`finalizeResalePurchase`, `unwindResaleOrderAfterRefund`, the pointer rule)
 * through the real Prisma repos against Postgres, with every migration
 * applied, so the one-live-listing index and the status compare-and-swaps are
 * the database's own.
 *
 *   A bought from the organizer, lists; B buys; B lists; C buys.
 *
 *   1. Refund of C's order returns the ticket to B; a refund of B's order
 *      then closes B's listing and returns the ticket to A. Each resale
 *      item keeps the listing it was bought through the whole way.
 *   2. Refund of B's order while C's checkout HOLDS B's listing: the refund
 *      commits, the ticket goes back to A, B's held listing is closed, the
 *      sale is CANCELLED (not put back on sale), and C's finalize is then
 *      refused without touching the ticket.
 *   3. Refund of B's order after C bought: the refund commits and nothing is
 *      taken from C. When C is refunded later the ticket goes back to B,
 *      whose purchase was already refunded: reported, and B's listing is
 *      not put back on sale.
 *
 * `sibling: resale-listings-relist.test.ts` proves the index itself.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import { setListedNowPointer } from "@th/core/use-cases/_helpers/order-item-listing-pointer";
import { finalizePaymentIntent } from "@th/core/use-cases/orders/finalize-from-payment-intent";
import { writeRefundDebitsForOrder } from "@th/core/use-cases/orders/_shared/write-refund-debits";
import { createResaleCheckout } from "@th/core/use-cases/resale/create-resale-checkout";
import { cancelLegacyResaleListings } from "@th/core/use-cases/resale/cancel-legacy-resale-listings";
import { sendLegacyRelistNotices } from "@th/core/use-cases/resale/_shared/send-legacy-relist-notices";
import { createResaleListing } from "@th/core/use-cases/resale/create-resale-listing";
import {
  fillResaleTermsOnce,
  type ResaleTicketTerms,
} from "@th/core/use-cases/resale/_shared/resale-ticket-terms";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import { reconcileStripeFullRefund } from "@th/core/use-cases/orders/reconcile-stripe-full-refund";
import { finalizeResalePurchase } from "@th/core/use-cases/resale/finalize-resale-purchase";
import {
  assertResaleOrderCanBeUnwound,
  unwindResaleOrderAfterRefund,
} from "@th/core/use-cases/resale/unwind-resale-order-after-refund";
import type { Repos } from "@th/ports/repos";
import { createFakeIdempotencyPort } from "@th/test-utils";
import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { createPrismaRepos } from "../../src/db/prisma";

const NOW = new Date("2027-02-01T12:00:00.000Z");
const clock = { now: () => NOW };

describe("Prisma integration – refunds along a resale chain", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient | undefined;
  let repos: Repos | undefined;
  let runtimeError: Error | null = null;

  let eventId: string;
  let ticketTypeId: string;
  let humanA: string;
  let humanB: string;
  let humanC: string;

  beforeAll(async () => {
    try {
      pgContainer = await startPostgresContainer();
      await runPrismaMigrateDeploy(pgContainer.databaseUrl);
      process.env.DATABASE_URL = pgContainer.databaseUrl;
      pool = new pg.Pool({ connectionString: pgContainer.databaseUrl });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
      repos = createPrismaRepos(prisma);

      const tag = randomUUID().slice(0, 8);
      const org = await prisma.organization.create({
        data: { name: `Chain Org ${tag}`, slug: `chain-org-${tag}`, status: "ACTIVE" },
      });
      const event = await prisma.event.create({
        data: {
          orgId: org.id,
          title: `Chain Event ${tag}`,
          startsAt: new Date("2027-03-01T20:00:00Z"),
          endsAt: new Date("2027-03-01T23:00:00Z"),
          status: "PUBLISHED",
          timezone: "America/Chicago",
          addressText: "123 Test St",
        },
      });
      eventId = event.id;
      const ticketType = await prisma.ticketType.create({
        data: { eventId, name: "GA", priceCents: 2500, capacity: 100 },
      });
      ticketTypeId = ticketType.id;
      humanA = (await prisma.human.create({ data: { name: "Chain A" } })).id;
      humanB = (await prisma.human.create({ data: { name: "Chain B" } })).id;
      humanC = (await prisma.human.create({ data: { name: "Chain C" } })).id;
    } catch (err) {
      runtimeError = err as Error;
      console.error("[resale-chain-refund] setup failed:", err);
    }
  }, 300_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (pool) await pool.end();
    if (pgContainer) await pgContainer.stop();
  });

  /** No skip guards: a failed setup makes every test fail, naming the error. */
  function ready() {
    if (runtimeError) throw runtimeError;
    if (!prisma || !repos) throw new Error("integration setup did not run");
    return { prisma, repos };
  }

  test("integration environment is up (canary — do not skip)", () => {
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
  });

  // ── Scenario steps ───────────────────────────────────────────────────────

  /** A buys one ticket from the organizer. */
  async function primaryPurchase() {
    const { prisma } = ready();
    const order = await prisma.order.create({
      data: {
        eventId,
        buyerHumanId: humanA,
        amountGrossCents: 2500,
        feesPlatformCents: 0,
        currency: "usd",
        status: "SUCCEEDED",
        source: "PRIMARY",
        feePolicySnapshot: {},
      },
    });
    const item = await prisma.orderItem.create({
      data: {
        orderId: order.id,
        kind: "ticket",
        ticketTypeId,
        qty: 1,
        unitPriceCents: 2500,
        amountCents: 2500,
      },
    });
    const ticket = await prisma.ticket.create({
      data: {
        eventId,
        ticketTypeId,
        ownerHumanId: humanA,
        orderId: order.id,
        orderItemId: item.id,
        code: `CHAIN-${randomUUID()}`,
        status: "VALID",
      },
    });
    return { ticketId: ticket.id, orderId: order.id, itemId: item.id };
  }

  /**
   * The ticket's holder lists it: the writes `createResaleListing` makes, in
   * one transaction (listing row, the purchase item's pointer through the one
   * rule, ticket VALID → LISTED).
   */
  async function list(
    ticketId: string,
    sellerHumanId: string,
    opts: { legacy?: boolean } = {},
  ) {
    const { repos } = ready();
    return repos.tx(async (tx) => {
      const ticket = (await tx.tickets.getById(ticketId))!;
      const listing = await tx.resaleListings.create({
        ticketId,
        eventId,
        sellerHumanId,
        askPriceCents: 2500,
        // Priced under the share (a share of 0): a listing with none is
        // closed, not relisted, when its sale is refunded (FR-015).
        // `legacy`: what a pre-B4 listing wrote, no share.
        ...(opts.legacy ? {} : { eventShareCents: 0, sharePayer: "SELLER" as const }),
      });
      await setListedNowPointer(tx, {
        orderItemId: ticket.orderItemId!,
        listingId: listing.id,
      });
      expect(
        await tx.tickets.setStatus(ticketId, "LISTED", { expectedStatus: "VALID" }),
      ).toBe(true);
      return listing.id;
    });
  }

  /** A buyer's checkout: the PENDING→paid RESALE order and the hold. */
  async function startCheckout(
    ticketId: string,
    listingId: string,
    buyerHumanId: string,
    stripePaymentIntentId?: string,
  ) {
    const { prisma, repos } = ready();
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
    const order = await prisma.order.create({
      data: {
        eventId,
        buyerHumanId,
        amountGrossCents: 2500,
        feesPlatformCents: 0,
        currency: "usd",
        status: "SUCCEEDED",
        source: "RESALE",
        parentOrderId: ticket.orderId,
        feePolicySnapshot: {},
        stripePaymentIntentId,
      },
    });
    const item = await prisma.orderItem.create({
      data: {
        orderId: order.id,
        kind: "ticket",
        ticketTypeId,
        qty: 1,
        unitPriceCents: 2500,
        amountCents: 2500,
        // What `createResaleCheckout` writes.
        resaleListingId: listingId,
        meta: {
          resaleListingId: listingId,
          resaleOriginalOrderId: ticket.orderId,
          resaleOriginalOrderItemId: ticket.orderItemId,
        },
      },
    });
    expect(
      (await repos.resaleListings.hold(
        listingId,
        buyerHumanId,
        new Date(Date.now() + 600_000),
      )).ok,
    ).toBe(true);
    return { orderId: order.id, itemId: item.id };
  }

  async function finalize(orderId: string) {
    const { repos } = ready();
    await repos.tx(async (tx) => {
      await finalizeResalePurchase(tx, {
        order: (await tx.orders.getById(orderId))!,
        clock,
      });
    });
  }

  async function buy(
    ticketId: string,
    listingId: string,
    buyerHumanId: string,
    stripePaymentIntentId?: string,
  ) {
    const purchase = await startCheckout(
      ticketId,
      listingId,
      buyerHumanId,
      stripePaymentIntentId,
    );
    await finalize(purchase.orderId);
    return purchase;
  }

  /**
   * A BARE marking transaction around the unwind: the pre-check, then one
   * transaction that flips the order's live ticket items, marks the order
   * REFUNDED and unwinds.
   *
   * This is NOT the Stripe webhook: it has no transferred-item check and no
   * ledger. For an order whose ticket was sold on, the product goes to
   * manual review instead (see the tests that call the real
   * `reconcileStripeFullRefund`); a test that pushes such an order through
   * this helper exercises the unwind's defence branch only, and says so.
   */
  async function refund(
    orderId: string,
    reportError: ReturnType<typeof vi.fn> = vi.fn(),
    publicAppUrl?: string,
  ) {
    const { repos } = ready();
    const order = (await repos.orders.getById(orderId))!;
    await assertResaleOrderCanBeUnwound(repos, order, {
      allowAlreadyUnwound: true,
      allowSoldOn: true,
    });
    const { relistNotices } = await repos.tx(async (tx) => {
      const fresh = (await tx.orders.getById(orderId))!;
      for (const item of fresh.items) {
        if (item.kind === "ticket" && item.status === "active") {
          await tx.orderItems.updateStatus(item.id, "refunded", NOW);
        }
      }
      await tx.orders.markRefunded(orderId);
      return unwindResaleOrderAfterRefund(tx, {
        order: fresh,
        clock,
        reportError: reportError as never,
      });
    });
    // After the commit, as the real refund paths do.
    if (publicAppUrl) {
      await sendLegacyRelistNotices(
        { repos, clock, publicAppUrl, reportError: reportError as never },
        relistNotices,
      );
    }
    return reportError;
  }

  async function state(ticketId: string) {
    const { prisma } = ready();
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
    const listings = await prisma.resaleListing.findMany({ where: { ticketId } });
    return {
      ticket: {
        ownerHumanId: ticket.ownerHumanId,
        orderId: ticket.orderId,
        orderItemId: ticket.orderItemId,
        status: ticket.status,
      },
      listings: Object.fromEntries(
        listings.map((l) => [
          l.id,
          { status: l.status, buyerOrderId: l.buyerOrderId },
        ]),
      ),
    };
  }

  const pointerOf = async (itemId: string) =>
    (await ready().prisma.orderItem.findUniqueOrThrow({ where: { id: itemId } }))
      .resaleListingId;
  /**
   * The seller's credit for a resale order, as the ledger holds it once the
   * sale settles (`metadata.items` attributes it to the order's item). With
   * it in place a committed refund writes a REFUND_DEBIT, so "no debit row"
   * is a real observation and not an empty ledger.
   */
  async function seedSellerCredit(orderId: string, itemId: string) {
    const { prisma } = ready();
    const payee = await prisma.payee.create({
      data: {
        subjectType: "ORGANIZATION",
        subjectId: `chain-seller-${randomUUID()}`,
        stripeAccountId: null,
        payoutsEnabled: false,
      },
    });
    await prisma.payeeLedgerEntry.create({
      data: {
        idempotencyKey: `test:chain-credit:${orderId}`,
        payeeId: payee.id,
        type: "SETTLEMENT_CREDIT",
        amountCents: 2500,
        currency: "usd",
        sourceKind: "test",
        sourceId: orderId,
        orderId,
        description: "seller credit (test)",
        availableAt: NOW,
        metadata: { items: { [itemId]: 2500 } },
      },
    });
  }
  const refundDebitCount = async (orderId: string) =>
    ready().prisma.payeeLedgerEntry.count({
      where: { orderId, type: "REFUND_DEBIT" },
    });
  const orderStatusOf = async (orderId: string) =>
    (await ready().prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status;
  const itemStatusOf = async (itemId: string) =>
    (await ready().prisma.orderItem.findUniqueOrThrow({ where: { id: itemId } })).status;
  const unwindAudit = async (listingId: string) =>
    (
      await ready().prisma.auditLog.findMany({
        where: {
          entity: "resale_listing",
          entityId: listingId,
          action: "purchase_unwound_after_refund",
        },
      })
    ).map((row) => row.data as Record<string, unknown>);

  // ── 1. The chain, refunded hop by hop ────────────────────────────────────

  test("refund of a sale priced under the removed markup split: the listing is closed, not relisted, and the seller is told to list again (FR-015)", async () => {
    const { prisma } = ready();
    const a = await primaryPurchase();
    const l1 = await list(a.ticketId, humanA, { legacy: true });
    const b = await buy(a.ticketId, l1, humanB);

    const report = await refund(b.orderId, vi.fn(), "https://ithas.fire");

    expect(report).not.toHaveBeenCalled();
    expect(await orderStatusOf(b.orderId)).toBe("REFUNDED");
    expect(await pointerOf(a.itemId)).toBeNull();
    expect(await state(a.ticketId)).toEqual({
      ticket: {
        ownerHumanId: humanA,
        orderId: a.orderId,
        orderItemId: a.itemId,
        status: "VALID",
      },
      listings: { [l1]: { status: "CANCELLED", buyerOrderId: null } },
    });
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: l1, action: "purchase_unwound_after_refund" },
    });
    expect(audit.data).toMatchObject({
      listingStatusAfterRefund: "CANCELLED",
      legacyListingClosed: true,
    });
    const notice = await prisma.notification.findFirstOrThrow({
      where: { humanId: humanA, title: "Your resale was refunded" },
    });
    expect(notice.actionHref).toBe(
      `https://ithas.fire/sell/listings/new?orderId=${a.orderId}`,
    );
  });

  test("A → B → C: refund of C returns the ticket to B, then refund of B closes B's listing and returns it to A", async () => {
    const a = await primaryPurchase();
    const l1 = await list(a.ticketId, humanA);
    expect(await pointerOf(a.itemId)).toBe(l1);

    const b = await buy(a.ticketId, l1, humanB);
    expect(await pointerOf(b.itemId)).toBe(l1);
    // A's PRIMARY item was unlinked when its listing sold.
    expect(await pointerOf(a.itemId)).toBeNull();

    // B lists the ticket they bought on resale. The live index allows it
    // (L1 is SOLD), and B's item keeps the listing it was bought through.
    const l2 = await list(a.ticketId, humanB);
    expect(await pointerOf(b.itemId)).toBe(l1);

    const c = await buy(a.ticketId, l2, humanC);
    expect(await pointerOf(b.itemId)).toBe(l1);
    expect(await pointerOf(c.itemId)).toBe(l2);
    expect(await itemStatusOf(b.itemId)).toBe("transferred");
    expect(await state(a.ticketId)).toEqual({
      ticket: {
        ownerHumanId: humanC,
        orderId: c.orderId,
        orderItemId: c.itemId,
        status: "VALID",
      },
      listings: {
        [l1]: { status: "SOLD", buyerOrderId: b.orderId },
        [l2]: { status: "SOLD", buyerOrderId: c.orderId },
      },
    });

    // ── Refund of C's order ──
    const reportC = await refund(c.orderId);

    expect(reportC).not.toHaveBeenCalled();
    expect(await orderStatusOf(c.orderId)).toBe("REFUNDED");
    expect(await itemStatusOf(b.itemId)).toBe("active");
    expect(await pointerOf(b.itemId)).toBe(l1);
    expect(await state(a.ticketId)).toEqual({
      ticket: {
        ownerHumanId: humanB,
        orderId: b.orderId,
        orderItemId: b.itemId,
        status: "LISTED",
      },
      listings: {
        [l1]: { status: "SOLD", buyerOrderId: b.orderId },
        [l2]: { status: "ACTIVE", buyerOrderId: null },
      },
    });

    // ── Refund of B's order, with B's listing live again (case a) ──
    const reportB = await refund(b.orderId);

    expect(reportB).not.toHaveBeenCalled();
    expect(await orderStatusOf(b.orderId)).toBe("REFUNDED");
    expect(await state(a.ticketId)).toEqual({
      ticket: {
        ownerHumanId: humanA,
        orderId: a.orderId,
        orderItemId: a.itemId,
        status: "LISTED",
      },
      listings: {
        [l1]: { status: "ACTIVE", buyerOrderId: null },
        [l2]: { status: "CANCELLED", buyerOrderId: null },
      },
    });
    expect(await itemStatusOf(a.itemId)).toBe("active");
    expect(await pointerOf(a.itemId)).toBe(l1);
    expect(await pointerOf(b.itemId)).toBe(l1);
    expect(await unwindAudit(l1)).toEqual([
      expect.objectContaining({
        refundedOrderId: b.orderId,
        closedBuyerListingId: l2,
        listingStatusAfterRefund: "ACTIVE",
      }),
    ]);
    expect(
      await ready().prisma.auditLog.count({
        where: { entity: "resale_listing", entityId: l2, action: "cancelled" },
      }),
    ).toBe(1);
  }, 120_000);

  // ── 2. Case b ────────────────────────────────────────────────────────────

  /** Live (ACTIVE / HELD) listings of the ticket: the index allows one. */
  const liveListingCount = async (ticketId: string) =>
    ready().prisma.resaleListing.count({
      where: { ticketId, status: { in: ["ACTIVE", "HELD"] } },
    });

  test("refund of B while C's checkout holds B's listing: the ticket goes back to A, the held listing is closed, C's finalize is refused", async () => {
    const { prisma } = ready();
    const a = await primaryPurchase();
    const l1 = await list(a.ticketId, humanA);
    expect(await liveListingCount(a.ticketId)).toBe(1);
    const b = await buy(a.ticketId, l1, humanB);
    expect(await liveListingCount(a.ticketId)).toBe(0);
    const l2 = await list(a.ticketId, humanB);
    const c = await startCheckout(a.ticketId, l2, humanC);
    expect(await liveListingCount(a.ticketId)).toBe(1);
    expect((await state(a.ticketId)).listings[l2]).toEqual({
      status: "HELD",
      buyerOrderId: null,
    });
    expect(await prisma.resaleListingHold.count({ where: { listingId: l2 } })).toBe(1);

    // The refund's transaction commits on the real index: no second live row
    // at any point, or this would have thrown a P2002 and rolled back.
    const reportError = await refund(b.orderId);

    expect(await orderStatusOf(b.orderId)).toBe("REFUNDED");
    expect(await itemStatusOf(b.itemId)).toBe("refunded");
    const after = await state(a.ticketId);
    expect(after).toEqual({
      ticket: {
        ownerHumanId: humanA,
        orderId: a.orderId,
        orderItemId: a.itemId,
        status: "VALID",
      },
      listings: {
        [l1]: { status: "CANCELLED", buyerOrderId: null },
        [l2]: { status: "CANCELLED", buyerOrderId: null },
      },
    });
    expect(await liveListingCount(a.ticketId)).toBe(0);
    expect(await prisma.resaleListingHold.count({ where: { listingId: l2 } })).toBe(0);
    expect(await itemStatusOf(a.itemId)).toBe("active");
    expect(await pointerOf(a.itemId)).toBeNull();
    expect(await pointerOf(b.itemId)).toBe(l1);
    // C's pending item still names the listing it was checking out.
    expect(await pointerOf(c.itemId)).toBe(l2);

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "resale_unwind_ticket_relisted_checkout_in_flight",
      }),
      expect.objectContaining({
        extra: expect.objectContaining({
          ticketRestoredToSeller: true,
          checkoutInFlight: expect.objectContaining({
            listingId: l2,
            listingClosed: true,
            listingStatusAfter: "CANCELLED",
            holdBuyerHumanId: humanC,
            orders: [expect.objectContaining({ id: c.orderId })],
          }),
        }),
      }),
    );
    expect(await unwindAudit(l1)).toEqual([
      expect.objectContaining({
        refundedOrderId: b.orderId,
        restoredOrderItemId: a.itemId,
        listingStatusAfterRefund: "CANCELLED",
        ticketRestoredToSeller: true,
        checkoutInFlight: expect.objectContaining({
          listingId: l2,
          holdBuyerHumanId: humanC,
        }),
      }),
    ]);
    expect(
      await prisma.auditLog.count({
        where: { entity: "resale_listing", entityId: l2, action: "cancelled" },
      }),
    ).toBe(1);

    // C's paid checkout cannot take the ticket: `commit` meets a CANCELLED
    // listing and throws, and the finalize transaction rolls back whole.
    await expect(finalize(c.orderId)).rejects.toMatchObject({
      code: "conflict",
      message: "resale_listing_not_sellable",
    });
    expect(await state(a.ticketId)).toEqual(after);
    expect(
      await prisma.ticketTransfer.count({
        where: { ticketId: a.ticketId, toHumanId: humanC },
      }),
    ).toBe(0);

    // A holds a VALID ticket and can list it again; the live slot is free.
    const l3 = await list(a.ticketId, humanA);
    expect(await liveListingCount(a.ticketId)).toBe(1);
    expect(await pointerOf(a.itemId)).toBe(l3);
  }, 120_000);

  // ── 2b. The race itself ──────────────────────────────────────────────────

  // The REAL Stripe refund webhook for B's order and the REAL finalize of
  // C's checkout, started together on separate connections. Whichever takes
  // the ticket row first wins; the other must see what the winner committed.
  // Neither may leave the ticket with two claims on it, and the refund must
  // not fail (its money has already moved).
  test("a refund of B racing C's finalize ends in one of two consistent states, never both, and the refund does not fail", async () => {
    const { repos } = ready();
    const outcomes: string[] = [];
    const refundWonDebits: number[] = [];

    for (let round = 0; round < 8; round++) {
      const a = await primaryPurchase();
      const l1 = await list(a.ticketId, humanA);
      const pi = `pi_race_${randomUUID().replace(/-/g, "")}`;
      const b = await buy(a.ticketId, l1, humanB, pi);
      await seedSellerCredit(b.orderId, b.itemId);
      const l2 = await list(a.ticketId, humanB);
      const c = await startCheckout(a.ticketId, l2, humanC);
      const reports: Error[] = [];

      // Alternate which side gets a growing head start, so both orders of
      // arrival at the ticket row are exercised.
      const lag = (ms: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, ms));
      const headStart = Math.floor(round / 2) * 8;
      const [refunded, finalized] = await Promise.allSettled([
        lag(round % 2 === 0 ? headStart : 0).then(() =>
         reconcileStripeFullRefund(
          {
            repos,
            clock,
            idempotency: createFakeIdempotencyPort(),
            reportError: (err) => reports.push(err as Error),
          },
          {
            paymentIntentId: pi,
            amountRefundedCents: 2500,
            sourceEventType: "charge.refund.updated",
            refundId: `re_${randomUUID().replace(/-/g, "")}`,
          },
         ),
        ),
        lag(round % 2 === 1 ? headStart : 0).then(() => finalize(c.orderId)),
      ]);

      // The refund never fails, whoever won.
      if (refunded.status === "rejected") {
        throw new Error(
          `round ${round}: refund reconcile rejected: ${JSON.stringify(refunded.reason)} / ${String(refunded.reason)}`,
        );
      }
      const after = await state(a.ticketId);
      expect(await liveListingCount(a.ticketId)).toBeLessThanOrEqual(1);

      if (finalized.status === "fulfilled") {
        // C's finalize won: C holds the ticket and B's sale to C stands.
        expect(after.ticket).toEqual({
          ownerHumanId: humanC,
          orderId: c.orderId,
          orderItemId: c.itemId,
          status: "VALID",
        });
        expect(after.listings[l2]).toEqual({
          status: "SOLD",
          buyerOrderId: c.orderId,
        });
        expect(after.listings[l1]).toEqual({
          status: "SOLD",
          buyerOrderId: b.orderId,
        });
        // The refund read the order under the ticket lock, saw B's item
        // sold on, and wrote NOTHING: manual review, whether C's sale
        // committed before the refund's transaction or while it waited.
        // (Acting on the earlier read marked B refunded over `transferred`
        // and debited A for a ticket A never got back.)
        expect(refunded.value.outcome).toBe("manual_review_required");
        expect(await itemStatusOf(b.itemId)).toBe("transferred");
        expect(await orderStatusOf(b.orderId)).toBe("SUCCEEDED");
        expect(await refundDebitCount(b.orderId)).toBe(0);
        expect(await unwindAudit(l1)).toEqual([]);
        expect(reports.map((r) => r.message)).toEqual([
          "stripe_full_refund_needs_manual_review",
        ]);
        outcomes.push(`finalize_won:${refunded.value.outcome}`);
      } else {
        // The refund won: A holds the ticket, both listings are closed, and
        // C's finalize took nothing.
        expect(after).toEqual({
          ticket: {
            ownerHumanId: humanA,
            orderId: a.orderId,
            orderItemId: a.itemId,
            status: "VALID",
          },
          listings: {
            [l1]: { status: "CANCELLED", buyerOrderId: null },
            [l2]: { status: "CANCELLED", buyerOrderId: null },
          },
        });
        expect(refunded.value.outcome).toBe("reconciled_resale");
        expect(await orderStatusOf(b.orderId)).toBe("REFUNDED");
        expect(await itemStatusOf(b.itemId)).toBe("refunded");
        // The seller's credit is clawed back: this is what makes the zero
        // in the other branch mean something.
        expect(await refundDebitCount(b.orderId)).toBe(1);
        refundWonDebits.push(await refundDebitCount(b.orderId));
        expect(reports.map((r) => r.message)).toContain(
          "resale_unwind_ticket_relisted_checkout_in_flight",
        );
        outcomes.push(
          `refund_won:${(finalized.reason as { message?: string; code?: string }).message ?? (finalized.reason as { code?: string }).code}`,
        );
      }
    }

    // eslint-disable-next-line no-console
    console.log("[resale-chain-refund] race outcomes:", outcomes.join(" | "));
    // eslint-disable-next-line no-console
    console.log("[resale-chain-refund] REFUND_DEBIT rows when the refund won:", refundWonDebits.join(","));
    expect(outcomes).toHaveLength(8);
    expect(outcomes.some((o) => o.startsWith("finalize_won"))).toBe(true);
    expect(outcomes.some((o) => o.startsWith("refund_won"))).toBe(true);
  }, 300_000);

  // ── 2c. The refund WAITS behind C's finalize ─────────────────────────────

  // The window the race above only sometimes hits, made certain: C's
  // finalize has done all its writes and holds the ticket row, uncommitted,
  // when the refund's transaction starts. The refund reads B's order (item
  // still `active`: C's writes are not visible yet), then blocks on the
  // ticket lock. C commits. The refund must decide on what is true NOW.
  test("the refund blocks on the ticket row behind C's uncommitted finalize, and on waking goes to manual review with nothing written", async () => {
    const { repos } = ready();
    const a = await primaryPurchase();
    const l1 = await list(a.ticketId, humanA);
    const pi = `pi_wait_${randomUUID().replace(/-/g, "")}`;
    const b = await buy(a.ticketId, l1, humanB, pi);
    await seedSellerCredit(b.orderId, b.itemId);
    const l2 = await list(a.ticketId, humanB);
    const c = await startCheckout(a.ticketId, l2, humanC);
    const reports: Error[] = [];

    let finalizeWritesDone!: () => void;
    const writesDone = new Promise<void>((resolve) => {
      finalizeWritesDone = resolve;
    });
    let letFinalizeCommit!: () => void;
    const mayCommit = new Promise<void>((resolve) => {
      letFinalizeCommit = resolve;
    });
    const finalizing = repos.tx(async (tx) => {
      await finalizeResalePurchase(tx, {
        order: (await tx.orders.getById(c.orderId))!,
        clock,
      });
      finalizeWritesDone();
      await mayCommit;
    });
    await writesDone;

    let refundSettled = false;
    const refunding = reconcileStripeFullRefund(
      {
        repos,
        clock,
        idempotency: createFakeIdempotencyPort(),
        reportError: (err) => reports.push(err as Error),
      },
      {
        paymentIntentId: pi,
        amountRefundedCents: 2500,
        sourceEventType: "charge.refund.updated",
        refundId: `re_${randomUUID().replace(/-/g, "")}`,
      },
    ).finally(() => {
      refundSettled = true;
    });

    // The refund is parked on the ticket row: it has not returned, and to
    // every other connection B's item still reads `active`.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(refundSettled).toBe(false);
    expect(await itemStatusOf(b.itemId)).toBe("active");

    letFinalizeCommit();
    await finalizing;
    const result = await refunding;

    expect(result.outcome).toBe("manual_review_required");
    expect(await itemStatusOf(b.itemId)).toBe("transferred");
    expect(await orderStatusOf(b.orderId)).toBe("SUCCEEDED");
    expect(await refundDebitCount(b.orderId)).toBe(0);
    expect(await unwindAudit(l1)).toEqual([]);
    expect(await state(a.ticketId)).toEqual({
      ticket: {
        ownerHumanId: humanC,
        orderId: c.orderId,
        orderItemId: c.itemId,
        status: "VALID",
      },
      listings: {
        [l1]: { status: "SOLD", buyerOrderId: b.orderId },
        [l2]: { status: "SOLD", buyerOrderId: c.orderId },
      },
    });
    expect(reports.map((r) => r.message)).toEqual([
      "stripe_full_refund_needs_manual_review",
    ]);
  }, 120_000);

  // ── 3. Case c ────────────────────────────────────────────────────────────

  // What the product does: the Stripe webhook is the one refund path that
  // runs with money already moved, and it sends a ticket sold on to manual
  // review. Nothing is written and nobody is debited; a person settles it.
  test("refund of B after C bought, through the real webhook reconcile: manual review, nothing written, nobody debited", async () => {
    const { repos } = ready();
    const a = await primaryPurchase();
    const l1 = await list(a.ticketId, humanA);
    const pi = `pi_soldon_${randomUUID().replace(/-/g, "")}`;
    const b = await buy(a.ticketId, l1, humanB, pi);
    await seedSellerCredit(b.orderId, b.itemId);
    const l2 = await list(a.ticketId, humanB);
    const c = await buy(a.ticketId, l2, humanC);
    const before = await state(a.ticketId);
    const reports: Error[] = [];

    const result = await reconcileStripeFullRefund(
      {
        repos,
        clock,
        idempotency: createFakeIdempotencyPort(),
        reportError: (err) => reports.push(err as Error),
      },
      {
        paymentIntentId: pi,
        amountRefundedCents: 2500,
        sourceEventType: "charge.refund.updated",
        refundId: `re_${randomUUID().replace(/-/g, "")}`,
      },
    );

    expect(result.outcome).toBe("manual_review_required");
    expect(await state(a.ticketId)).toEqual(before);
    expect(before.ticket).toEqual({
      ownerHumanId: humanC,
      orderId: c.orderId,
      orderItemId: c.itemId,
      status: "VALID",
    });
    expect(await orderStatusOf(b.orderId)).toBe("SUCCEEDED");
    expect(await itemStatusOf(b.itemId)).toBe("transferred");
    expect(await refundDebitCount(b.orderId)).toBe(0);
    expect(await unwindAudit(l1)).toEqual([]);
    expect(reports.map((r) => r.message)).toEqual([
      "stripe_full_refund_needs_manual_review",
    ]);
  }, 120_000);

  // DEFENCE ONLY, not product behaviour. No refund path reaches the unwind
  // with a ticket sold on (the webhook goes to manual review, above; the
  // others refuse it before money moves). This pushes that state through
  // the bare `refund()` helper to pin what the unwind's sold-on branch and
  // its "returned to an already refunded buyer" branch do on real Postgres
  // if a caller ever does get there: no throw, nothing taken from C, the
  // live index respected, a report each time.
  test("DEFENCE ONLY (unwind branch, bare helper): a sold-on ticket is left with C; a later refund of C hands it to the refunded B, who cannot list it", async () => {
    const a = await primaryPurchase();
    const l1 = await list(a.ticketId, humanA);
    const b = await buy(a.ticketId, l1, humanB);
    const l2 = await list(a.ticketId, humanB);
    const c = await buy(a.ticketId, l2, humanC);
    const before = await state(a.ticketId);

    const reportError = await refund(b.orderId);

    expect(await orderStatusOf(b.orderId)).toBe("REFUNDED");
    expect(await state(a.ticketId)).toEqual(before);
    expect(before.ticket).toEqual({
      ownerHumanId: humanC,
      orderId: c.orderId,
      orderItemId: c.itemId,
      status: "VALID",
    });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "resale_unwind_ticket_sold_on" }),
      expect.anything(),
    );
    expect(await unwindAudit(l1)).toEqual([
      expect.objectContaining({
        ticketRestoredToSeller: false,
        ticketNotRestoredReason: "sold_on",
        refundedOrderId: b.orderId,
        purchasedListingId: l1,
        laterListingId: l2,
        laterListingStatus: "SOLD",
        currentHolderHumanId: humanC,
        currentHolderOrderItemId: c.itemId,
        currentHolderOrderId: c.orderId,
      }),
    ]);

    // C is refunded too. The ticket leaves C and goes back to B, the seller
    // of that sale, but B's own purchase was already refunded: B's listing
    // is NOT put back on sale, and a person is told.
    const reportC = await refund(c.orderId);

    expect(await orderStatusOf(c.orderId)).toBe("REFUNDED");
    expect(await state(a.ticketId)).toEqual({
      ticket: {
        ownerHumanId: humanB,
        orderId: b.orderId,
        orderItemId: b.itemId,
        status: "VALID",
      },
      listings: {
        [l1]: { status: "SOLD", buyerOrderId: b.orderId },
        [l2]: { status: "CANCELLED", buyerOrderId: null },
      },
    });
    expect(reportC).toHaveBeenCalledTimes(1);
    expect(reportC).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "resale_unwind_ticket_returned_to_refunded_buyer",
      }),
      expect.anything(),
    );

    // B holds a VALID ticket on an `active` item under a REFUNDED order,
    // and has the money back. That is the state `createResaleListing`
    // refuses (`purchase_refunded`; its own tests in core, since `list()`
    // here is a bare helper and not the use case): the order's status is
    // the one thing on these rows that still says B was refunded.
    expect(await orderStatusOf(b.orderId)).toBe("REFUNDED");
    expect(await itemStatusOf(b.itemId)).toBe("active");
    expect(await liveListingCount(a.ticketId)).toBe(0);
  }, 120_000);

  // ── The organiser's resale share, through the REAL use cases ─────────────
  //
  // organiser-resale-share B4: createResaleListing → createResaleCheckout →
  // finalizePaymentIntent against Postgres, with every migration's CHECKs in
  // force. A ticket sold before the record existed gets the event's clause at
  // its first listing (FR-004); every hop keeps it and its original price;
  // the share runs over the event's RESALE lines and the platform takes
  // nothing (the order's splits add up to its gross, none to the platform).
  describe("the organiser's resale share (organiser-resale-share B4)", () => {
    let shareEventId: string;
    let shareTypeId: string;
    let resaleTermsId: string;
    let orgPayeeId: string;
    let placePayeeId: string;
    const humans: Record<"A" | "B" | "C" | "D" | "E", string> = {
      A: "",
      B: "",
      C: "",
      D: "",
      E: "",
    };
    const payeeOf: Record<string, string> = {};
    const idempotency = createFakeIdempotencyPort();
    const reportError = vi.fn();

    let piSeq = 0;
    const piAmounts = new Map<string, number>();
    const payments = {
      createPaymentIntent: vi.fn(async (req: { amountCents: number }) => {
        piSeq += 1;
        const id = `pi_share_${piSeq}_${randomUUID().slice(0, 8)}`;
        piAmounts.set(id, req.amountCents);
        return { id, clientSecret: `${id}_secret` };
      }),
      cancelPaymentIntent: vi.fn(async () => ({ canceled: true })),
      retrievePaymentIntent: vi.fn(async (input: { paymentIntentId: string }) => ({
        id: input.paymentIntentId,
        status: "canceled",
        amountReceived: 0,
        currency: "usd",
        metadata: {},
      })),
    } as unknown as PaymentProcessorPort;

    beforeAll(async () => {
      if (runtimeError || !prisma) return;
      const tag = randomUUID().slice(0, 8);
      const org = await prisma.organization.create({
        data: { name: `Share Org ${tag}`, slug: `share-org-${tag}`, status: "ACTIVE" },
      });
      const place = await prisma.organization.create({
        data: { name: `Share Place ${tag}`, slug: `share-place-${tag}`, status: "ACTIVE" },
      });
      const feePolicy = await prisma.feePolicy.create({
        data: {
          scopeType: "GLOBAL",
          version: 1,
          effectiveFrom: new Date("2026-01-01T00:00:00Z"),
          buyerFeePct: 0.04,
          processsorFeePct: 0.029,
          processorFixedCents: 30,
          payoutPct: 0,
          payoutFixedCents: 0,
          monthlyPayoutCents: 0,
          createdBy: "integration-test",
        },
      });
      orgPayeeId = (
        await prisma.payee.create({
          data: { subjectType: "ORGANIZATION", subjectId: org.id },
        })
      ).id;
      placePayeeId = (
        await prisma.payee.create({
          data: { subjectType: "ORGANIZATION", subjectId: place.id },
        })
      ).id;
      // The PRIMARY terms pin the fee policy a primary sale uses; resale
      // processing is priced from it (FR-013). The RESALE terms carry no fee
      // policy of their own, and a 10% seller-paid clause.
      const primary = await prisma.payoutTerms.create({
        data: { kind: "PRIMARY", status: "ACTIVE", feePolicyId: feePolicy.id },
      });
      await prisma.payoutTermsLine.create({
        data: { payoutTermsId: primary.id, payeeId: orgPayeeId, percent: 100 },
      });
      const resale = await prisma.payoutTerms.create({
        data: {
          kind: "RESALE",
          status: "ACTIVE",
          resaleShareType: "PERCENT",
          resaleShareBps: 1000,
          resaleSharePayer: "SELLER",
          resalePayoutReleaseDays: 7,
        },
      });
      resaleTermsId = resale.id;
      // The night's two payees split the share: organiser 70%, place 30%.
      await prisma.payoutTermsLine.create({
        data: {
          payoutTermsId: resale.id,
          payeeId: orgPayeeId,
          percent: 70,
          rounding: "FLOOR",
          priority: 1,
        },
      });
      await prisma.payoutTermsLine.create({
        data: {
          payoutTermsId: resale.id,
          payeeId: placePayeeId,
          percent: 30,
          rounding: "NEAREST",
          priority: 0,
        },
      });
      const event = await prisma.event.create({
        data: {
          orgId: org.id,
          title: `Share Event ${tag}`,
          startsAt: new Date("2027-03-01T20:00:00Z"),
          endsAt: new Date("2027-03-01T23:00:00Z"),
          status: "PUBLISHED",
          timezone: "America/Chicago",
          addressText: "123 Test St",
          payoutTermsId: primary.id,
          resalePayoutTermsId: resale.id,
        },
      });
      shareEventId = event.id;
      shareTypeId = (
        await prisma.ticketType.create({
          data: {
            eventId: shareEventId,
            name: "GA",
            priceCents: 4000,
            capacity: 100,
            resaleAllowed: true,
          },
        })
      ).id;
      for (const key of Object.keys(humans) as Array<keyof typeof humans>) {
        const id = (await prisma.human.create({ data: { name: `Share ${key}` } })).id;
        humans[key] = id;
        payeeOf[id] = (
          await prisma.payee.create({
            data: {
              subjectType: "HUMAN",
              subjectId: id,
              stripeAccountId: `acct_share_${tag}_${key}`,
              status: "ACTIVE",
              payoutsEnabled: true,
            },
          })
        ).id;
      }
    }, 300_000);

    /** A ticket sold at $40 BEFORE the record existed: no clause on its item. */
    async function legacyPrimaryTicket(ownerHumanId: string) {
      const { prisma } = ready();
      const order = await prisma.order.create({
        data: {
          eventId: shareEventId,
          buyerHumanId: ownerHumanId,
          amountGrossCents: 4000,
          feesPlatformCents: 0,
          currency: "usd",
          status: "SUCCEEDED",
          source: "PRIMARY",
          feePolicySnapshot: {},
        },
      });
      const item = await prisma.orderItem.create({
        data: {
          orderId: order.id,
          kind: "ticket",
          ticketTypeId: shareTypeId,
          qty: 1,
          unitPriceCents: 4000,
          amountCents: 4000,
        },
      });
      const ticket = await prisma.ticket.create({
        data: {
          eventId: shareEventId,
          ticketTypeId: shareTypeId,
          ownerHumanId,
          orderId: order.id,
          orderItemId: item.id,
          code: `SHARE-${randomUUID()}`,
          status: "VALID",
        },
      });
      return { ticketId: ticket.id, itemId: item.id };
    }

    const listTicket = (ticketId: string, seller: string, askPriceCents: number) =>
      createResaleListing(
        { repos: ready().repos, idempotency, clock, reportError },
        {
          actorHumanId: seller,
          ticketId,
          askPriceCents,
          clientKey: `ck_${randomUUID()}`,
        },
      );

    /** The buyer's checkout, then the PaymentIntent's success webhook. */
    async function buyListing(listingId: string, buyer: string) {
      const { repos } = ready();
      const checkout = await createResaleCheckout(
        { repos, payments, idempotency, clock, reportError },
        {
          actorHumanId: buyer,
          buyerHumanId: buyer,
          listingId,
          clientKey: `ck_${randomUUID()}`,
          termsAccepted: true,
          refundPolicyAccepted: true,
        },
      );
      const order = (await repos.orders.getById(checkout.orderId))!;
      const pi = order.stripePaymentIntentId!;
      await finalizePaymentIntent(
        { repos, idempotency, clock, reportError },
        {
          stripeEvent: {
            id: `evt_${randomUUID()}`,
            type: "payment_intent.succeeded",
            data: {
              object: {
                id: pi,
                status: "succeeded",
                amount_received: piAmounts.get(pi)!,
                currency: "usd",
                metadata: {
                  orderId: checkout.orderId,
                  eventId: shareEventId,
                  source: "resale",
                },
              },
            },
          },
        } as never,
      );
      return { checkout, orderId: checkout.orderId, chargedCents: piAmounts.get(pi)! };
    }

    async function creditsOf(orderId: string) {
      const rows = await ready().prisma.payeeLedgerEntry.findMany({
        where: { orderId, type: "SETTLEMENT_CREDIT" },
      });
      return Object.fromEntries(rows.map((r) => [r.payeeId, r.amountCents]));
    }

    async function recordOf(itemId: string) {
      const item = await ready().prisma.orderItem.findUniqueOrThrow({
        where: { id: itemId },
      });
      return {
        resaleClauseType: item.resaleClauseType,
        resaleClauseBps: item.resaleClauseBps,
        resaleClauseCents: item.resaleClauseCents,
        resaleClausePayer: item.resaleClausePayer,
        resaleClauseTermsId: item.resaleClauseTermsId,
        originalUnitPriceCents: item.originalUnitPriceCents,
      };
    }

    async function buyerItemOf(orderId: string) {
      return ready().prisma.orderItem.findFirstOrThrow({
        where: { orderId, kind: "ticket" },
      });
    }

    /**
     * The platform takes nothing on a resale: the order's OrderSplit rows (the
     * seller's credit plus the event side's payees) add up to exactly its
     * gross, and every row belongs to the seller or the event's RESALE-line
     * payees, never to anyone else. (`getPlatformRevenue` cannot show this: it
     * excludes resale orders, so it cannot fail.)
     */
    async function expectSplitsCoverGross(
      orderId: string,
      sellerPayeeId: string,
    ) {
      const { prisma } = ready();
      const order = await prisma.order.findUniqueOrThrow({
        where: { id: orderId },
      });
      const splits = await prisma.orderSplit.findMany({ where: { orderId } });
      expect(splits.reduce((acc, r) => acc + r.amountCents, 0)).toBe(
        order.amountGrossCents,
      );
      const allowed = new Set([sellerPayeeId, orgPayeeId, placePayeeId]);
      for (const split of splits) {
        expect(allowed.has(split.payeeId)).toBe(true);
      }
      expect(order.feesPlatformCents).toBe(0);
    }

    test("a legacy $40 ticket resold three times: the FR-004 fill, the first clause on every hop, the share to the night's payees, nothing to the platform, and an approved claim returns it", async () => {
      const { prisma } = ready();
      const a = await legacyPrimaryTicket(humans.A);

      // ── Hop 1: A lists at $50. The first listing fills the record. ──
      const l1 = await listTicket(a.ticketId, humans.A, 5000);
      const firstRecord = {
        resaleClauseType: "PERCENT",
        resaleClauseBps: 1000,
        resaleClauseCents: null,
        resaleClausePayer: "SELLER",
        resaleClauseTermsId: resaleTermsId,
        originalUnitPriceCents: 4000,
      };
      expect(await recordOf(a.itemId)).toEqual(firstRecord);
      expect(
        await prisma.resaleListing.findUniqueOrThrow({ where: { id: l1.listingId } }),
      ).toMatchObject({ eventShareCents: 500, sharePayer: "SELLER" });

      const o1 = await buyListing(l1.listingId, humans.B);
      // The buyer pays $50 + processing (2.9% + 30¢ grossed up over the
      // whole charge, as a primary sale's) + tax (none here).
      expect(o1.chargedCents).toBe(5000 + 181);
      const order1 = await prisma.order.findUniqueOrThrow({ where: { id: o1.orderId } });
      expect(order1).toMatchObject({ amountGrossCents: 5000, feesPlatformCents: 0 });
      // Seller $45; the event's payees $5 split 70/30 by the resale lines.
      expect(await creditsOf(o1.orderId)).toEqual({
        [payeeOf[humans.A]!]: 4500,
        [orgPayeeId]: 350,
        [placePayeeId]: 150,
      });
      const b = await buyerItemOf(o1.orderId);
      expect(await recordOf(b.id)).toEqual(firstRecord);

      // ── The organiser changes the clause to 5%. Sold tickets keep 10%. ──
      await prisma.payoutTerms.update({
        where: { id: resaleTermsId },
        data: { resaleShareBps: 500, version: { increment: 1 } },
      });

      // ── Hop 2: B lists at $70 → still 10%: $7. ──
      const l2 = await listTicket(a.ticketId, humans.B, 7000);
      expect(
        await prisma.resaleListing.findUniqueOrThrow({ where: { id: l2.listingId } }),
      ).toMatchObject({ eventShareCents: 700, sharePayer: "SELLER" });
      // Nothing was filled on B's item: it carried the record already.
      expect(await recordOf(b.id)).toEqual(firstRecord);
      const o2 = await buyListing(l2.listingId, humans.C);
      // $70 + processing (2.9% + 30¢ grossed up over $70); the charge is
      // basis + processing.
      expect(o2.chargedCents).toBe(7000 + 240);
      expect(await creditsOf(o2.orderId)).toEqual({
        [payeeOf[humans.B]!]: 6300,
        [orgPayeeId]: 490,
        [placePayeeId]: 210,
      });
      const c = await buyerItemOf(o2.orderId);
      // Original price $40 on hop 2, never the $50 B paid.
      expect(await recordOf(c.id)).toEqual(firstRecord);

      // ── Hop 3: C lists at $60 → $6. ──
      const l3 = await listTicket(a.ticketId, humans.C, 6000);
      const o3 = await buyListing(l3.listingId, humans.D);
      // $60 + processing (2.9% + 30¢ grossed up over $60).
      expect(o3.chargedCents).toBe(6000 + 211);
      expect(await creditsOf(o3.orderId)).toEqual({
        [payeeOf[humans.C]!]: 5400,
        [orgPayeeId]: 420,
        [placePayeeId]: 180,
      });
      const d = await buyerItemOf(o3.orderId);
      expect(await recordOf(d.id)).toEqual(firstRecord);

      // ── The platform took nothing from any of the three: each order's
      // splits (seller + event side) add up to its gross. ──
      await expectSplitsCoverGross(o1.orderId, payeeOf[humans.A]!);
      await expectSplitsCoverGross(o2.orderId, payeeOf[humans.B]!);
      await expectSplitsCoverGross(o3.orderId, payeeOf[humans.C]!);

      // ── An approved claim on hop 3 (a full refund) returns every payee's
      // credit, the share included, through the per-payee debits. ──
      const debits = await ready().repos.tx((tx) =>
        writeRefundDebitsForOrder(tx, {
          order: { id: o3.orderId, currency: "usd" },
          refundedItemIds: [d.id],
          refundKey: `claim-${o3.orderId}`,
          attemptedFullRefund: true,
          useCase: "reviewClaim",
          reportError,
        }),
      );
      expect(
        Object.fromEntries(debits.map((x) => [x.payeeId, x.debitCents])),
      ).toEqual({
        [payeeOf[humans.C]!]: 5400,
        [orgPayeeId]: 420,
        [placePayeeId]: 180,
      });
      const stored = await prisma.payeeLedgerEntry.findMany({
        where: { orderId: o3.orderId, type: "REFUND_DEBIT" },
      });
      expect(stored.reduce((acc, r) => acc + r.amountCents, 0)).toBe(6000);

      // Put the clause back for the tests below.
      await prisma.payoutTerms.update({
        where: { id: resaleTermsId },
        data: { resaleShareBps: 1000, version: { increment: 1 } },
      });
      expect(reportError).not.toHaveBeenCalled();
    }, 300_000);

    test("a BUYER clause at a $40 cap: $40 is refused offering $36.37 (and the refused listing's fill rolls back); $36.37 sells for a $40.00 basis", async () => {
      const { prisma } = ready();
      await prisma.payoutTerms.update({
        where: { id: resaleTermsId },
        data: {
          resaleShareBps: 1000,
          resaleSharePayer: "BUYER",
          version: { increment: 1 },
        },
      });
      await prisma.ticketType.update({
        where: { id: shareTypeId },
        data: { resaleCapCents: 4000 },
      });
      try {
        const e = await legacyPrimaryTicket(humans.E);

        await expect(listTicket(e.ticketId, humans.E, 4000)).rejects.toMatchObject({
          code: "RESALE_PRICE_EXCEEDS_CAP",
          meta: expect.objectContaining({ highestFittingAskCents: 3637 }),
        });
        // The refusal rolled the FR-004 fill back with the listing.
        expect((await recordOf(e.itemId)).resaleClauseType).toBeNull();

        const listing = await listTicket(e.ticketId, humans.E, 3637);
        expect((await recordOf(e.itemId)).resaleClausePayer).toBe("BUYER");
        const sale = await buyListing(listing.listingId, humans.A);
        const order = await prisma.order.findUniqueOrThrow({
          where: { id: sale.orderId },
        });
        // The buyer pays $36.37 + $3.63 = $40.00, + processing grossed up
        // over $40.00.
        expect(order.amountGrossCents).toBe(4000);
        expect(sale.chargedCents).toBe(4000 + 151);
        expect(await creditsOf(sale.orderId)).toEqual({
          [payeeOf[humans.E]!]: 3637,
          [orgPayeeId]: 254,
          [placePayeeId]: 109,
        });
        const item = await buyerItemOf(sale.orderId);
        expect(item).toMatchObject({
          unitPriceCents: 4000,
          eventShareCents: 363,
          sharePayer: "BUYER",
        });
      } finally {
        await prisma.payoutTerms.update({
          where: { id: resaleTermsId },
          data: { resaleSharePayer: "SELLER", version: { increment: 1 } },
        });
        await prisma.ticketType.update({
          where: { id: shareTypeId },
          data: { resaleCapCents: null },
        });
      }
    }, 300_000);

    test("FR-004 under two concurrent listings: the second blocks on the row, finds the first's record, and both price under it", async () => {
      const { prisma, repos } = ready();
      const t = await legacyPrimaryTicket(humans.B);
      const fillFor = (
        clause: ResaleTicketTerms["clause"],
        record: Omit<NonNullable<ResaleTicketTerms["fill"]>, "originalUnitPriceCents">,
      ): ResaleTicketTerms => ({
        clause,
        originalUnitPriceCents: 4000,
        fill: { ...record, originalUnitPriceCents: 4000 },
      });
      const first = fillFor(
        { type: "PERCENT", bps: 1000, payer: "SELLER" },
        {
          resaleClauseType: "PERCENT",
          resaleClauseBps: 1000,
          resaleClauseCents: null,
          resaleClausePayer: "SELLER",
          resaleClauseTermsId: resaleTermsId,
          resaleClauseTermsVersion: 1,
        },
      );
      const second = fillFor(
        { type: "FLAT", cents: 300, payer: "BUYER" },
        {
          resaleClauseType: "FLAT",
          resaleClauseBps: null,
          resaleClauseCents: 300,
          resaleClausePayer: "BUYER",
          resaleClauseTermsId: resaleTermsId,
          resaleClauseTermsVersion: 2,
        },
      );

      let releaseFirst!: () => void;
      const firstMayCommit = new Promise<void>((r) => (releaseFirst = r));
      let firstWrote!: () => void;
      const firstHasWritten = new Promise<void>((r) => (firstWrote = r));

      const t1 = repos.tx(async (tx) => {
        const terms = await fillResaleTermsOnce(tx, t.itemId, first);
        firstWrote();
        await firstMayCommit;
        return terms;
      });
      await firstHasWritten;
      let secondSettled = false;
      const t2 = repos
        .tx((tx) => fillResaleTermsOnce(tx, t.itemId, second))
        .finally(() => {
          secondSettled = true;
        });
      await new Promise((r) => setTimeout(r, 750));
      // Blocked on the row lock the first write holds.
      expect(secondSettled).toBe(false);
      releaseFirst();

      const [won, lost] = await Promise.all([t1, t2]);
      expect(won.clause).toEqual(first.clause);
      expect(lost.clause).toEqual(first.clause);
      expect(lost.fill).toBeNull();
      const row = await prisma.orderItem.findUniqueOrThrow({ where: { id: t.itemId } });
      expect(row).toMatchObject({
        resaleClauseType: "PERCENT",
        resaleClauseBps: 1000,
        resaleClausePayer: "SELLER",
        resaleClauseTermsVersion: 1,
        originalUnitPriceCents: 4000,
      });
    }, 120_000);

    test("a listing made before the share (no share recorded) is refused at checkout before any hold or charge, and the FR-015 cancel closes it", async () => {
      const { prisma, repos } = ready();
      const t = await legacyPrimaryTicket(humans.C);
      // What a pre-B4 `createResaleListing` wrote: no share. The markup split
      // it was priced under is gone (FR-014).
      const listingId = await repos.tx(async (tx) => {
        const listing = await tx.resaleListings.create({
          ticketId: t.ticketId,
          eventId: shareEventId,
          sellerHumanId: humans.C,
          askPriceCents: 6000,
          faceValueCents: 4000,
          processingPassThroughCents: 204,
          processingFeeConfigRef: "pre-share-policy",
          saleCutoffAt: new Date("2027-03-01T20:00:00Z"),
          payoutReleaseAt: new Date("2027-03-08T23:00:00Z"),
          resalePayoutTermsId: resaleTermsId,
        });
        await setListedNowPointer(tx, {
          orderItemId: t.itemId,
          listingId: listing.id,
        });
        expect(
          await tx.tickets.setStatus(t.ticketId, "LISTED", { expectedStatus: "VALID" }),
        ).toBe(true);
        return listing.id;
      });
      const intentsBefore = piAmounts.size;
      const ordersBefore = await prisma.order.count({ where: { buyerHumanId: humans.D } });

      await expect(buyListing(listingId, humans.D)).rejects.toMatchObject({
        code: "RESALE_TERMS_MISSING",
        meta: expect.objectContaining({ reason: "listing_predates_resale_share" }),
      });
      expect(piAmounts.size).toBe(intentsBefore);
      expect(await prisma.order.count({ where: { buyerHumanId: humans.D } })).toBe(ordersBefore);
      expect(
        await prisma.resaleListing.findUniqueOrThrow({ where: { id: listingId } }),
      ).toMatchObject({ status: "ACTIVE" });

      // FR-015: the admin cancel closes it, with the seller's own cancel.
      const deps = {
        repos,
        authz: { hasStaffRole: async () => ({ allowed: true }) },
        clock,
        reportError,
      };
      const out = await cancelLegacyResaleListings(deps as never, {
        actorHumanId: humans.A,
        dryRun: false,
      });
      expect(out.cancelledListingIds).toContain(listingId);
      expect(out.failedListingIds).toEqual([]);
      expect(
        await prisma.resaleListing.findUniqueOrThrow({ where: { id: listingId } }),
      ).toMatchObject({ status: "CANCELLED" });
      expect(
        await prisma.ticket.findUniqueOrThrow({ where: { id: t.ticketId } }),
      ).toMatchObject({ status: "VALID" });
      expect(
        await prisma.orderItem.findUniqueOrThrow({ where: { id: t.itemId } }),
      ).toMatchObject({ resaleListingId: null });
      expect(
        await prisma.auditLog.count({
          where: { entityId: listingId, action: "cancelled_markup_split_removed" },
        }),
      ).toBe(1);

      // Idempotent: nothing left to cancel, nothing audited twice.
      const again = await cancelLegacyResaleListings(deps as never, {
        actorHumanId: humans.A,
        dryRun: false,
      });
      expect(again.cancelledListingIds).not.toContain(listingId);
      expect(
        await prisma.auditLog.count({
          where: { entityId: listingId, action: "cancelled_markup_split_removed" },
        }),
      ).toBe(1);
    }, 300_000);
  });
});
