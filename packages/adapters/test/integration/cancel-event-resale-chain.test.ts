/**
 * Cancelling an event whose ticket changed hands on resale more than once.
 *
 *   A bought from the organizer (O_A), listed; B bought (O_B); B listed;
 *   C bought (O_C).
 *
 * The REAL `cancelEvent` runs over the real Prisma repos against Postgres
 * with every migration applied: the ticket row locks, the listing
 * compare-and-swaps and the ledger's idempotency keys are the database's
 * own. Only the payment processor, the clock and the idempotency port are
 * fakes.
 *
 * The rule (docs/decisions/cancellation-refunds-gifted-tickets-to-the-payer.md,
 * applied to every hop, last buyer first): each buyer gets back what they
 * paid less that order's processing fee, each seller gives back what the
 * sale credited them, and the ticket walks back down the chain to the
 * primary order, where it is voided. A hop that cannot be refunded stops
 * every hop before it.
 *
 * `sibling: resale-chain-refund.test.ts` drives the unwind alone, hop by hop.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import { setListedNowPointer } from "@th/core/use-cases/_helpers/order-item-listing-pointer";
import {
  cancelEvent,
  type CancelEventDeps,
} from "@th/core/use-cases/events/cancel-event";
import { finalizeResalePurchase } from "@th/core/use-cases/resale/finalize-resale-purchase";
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

/** What each buyer paid, and the processing fee on that charge. */
const PAID = { a: 2500, b: 3000, c: 4000 } as const;
const STRIPE_FEE = { a: 103, b: 117, c: 146 } as const;

describe("Prisma integration – cancelEvent over a resale chain", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient | undefined;
  let repos: Repos | undefined;
  let runtimeError: Error | null = null;

  let orgId: string;
  let actorHumanId: string;
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
        data: {
          name: `Cancel Chain Org ${tag}`,
          slug: `cancel-chain-org-${tag}`,
          status: "ACTIVE",
        },
      });
      orgId = org.id;
      actorHumanId = (
        await prisma.human.create({ data: { name: "Chain Organizer" } })
      ).id;
      await prisma.orgMember.create({
        data: { orgId, humanId: actorHumanId, role: "OWNER" },
      });
      humanA = (await prisma.human.create({ data: { name: "Chain A" } })).id;
      humanB = (await prisma.human.create({ data: { name: "Chain B" } })).id;
      humanC = (await prisma.human.create({ data: { name: "Chain C" } })).id;
    } catch (err) {
      runtimeError = err as Error;
      console.error("[cancel-event-resale-chain] setup failed:", err);
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

  async function createEvent() {
    const { prisma } = ready();
    const tag = randomUUID().slice(0, 8);
    const event = await prisma.event.create({
      data: {
        orgId,
        title: `Cancel Chain Event ${tag}`,
        startsAt: new Date("2027-03-01T20:00:00Z"),
        endsAt: new Date("2027-03-01T23:00:00Z"),
        status: "PUBLISHED",
        timezone: "America/Chicago",
        addressText: "123 Test St",
      },
    });
    const ticketType = await prisma.ticketType.create({
      data: { eventId: event.id, name: "GA", priceCents: PAID.a, capacity: 100 },
    });
    return { eventId: event.id, ticketTypeId: ticketType.id };
  }

  type Scene = { eventId: string; ticketTypeId: string };

  /** A buyer's paid order from the organizer, one ticket. */
  async function primaryPurchase(
    scene: Scene,
    buyerHumanId: string,
    paymentIntentId: string,
  ) {
    const { prisma } = ready();
    const order = await prisma.order.create({
      data: {
        eventId: scene.eventId,
        buyerHumanId,
        amountGrossCents: PAID.a,
        feesPlatformCents: 0,
        currency: "usd",
        status: "SUCCEEDED",
        source: "PRIMARY",
        feePolicySnapshot: {},
        stripePaymentIntentId: paymentIntentId,
      },
    });
    const item = await prisma.orderItem.create({
      data: {
        orderId: order.id,
        kind: "ticket",
        ticketTypeId: scene.ticketTypeId,
        qty: 1,
        unitPriceCents: PAID.a,
        amountCents: PAID.a,
      },
    });
    const ticket = await prisma.ticket.create({
      data: {
        eventId: scene.eventId,
        ticketTypeId: scene.ticketTypeId,
        ownerHumanId: buyerHumanId,
        orderId: order.id,
        orderItemId: item.id,
        code: `CCHAIN-${randomUUID()}`,
        status: "VALID",
      },
    });
    return { ticketId: ticket.id, orderId: order.id, itemId: item.id };
  }

  /** The writes `createResaleListing` makes, in one transaction. */
  async function list(scene: Scene, ticketId: string, sellerHumanId: string, askPriceCents: number) {
    const { repos } = ready();
    return repos.tx(async (tx) => {
      const ticket = (await tx.tickets.getById(ticketId))!;
      const listing = await tx.resaleListings.create({
        ticketId,
        eventId: scene.eventId,
        sellerHumanId,
        askPriceCents,
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

  /** A paid resale purchase: the order `createResaleCheckout` writes, held and finalized. */
  async function buy(
    scene: Scene,
    ticketId: string,
    listingId: string,
    buyerHumanId: string,
    priceCents: number,
    paymentIntentId: string,
  ) {
    const { prisma, repos } = ready();
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
    const order = await prisma.order.create({
      data: {
        eventId: scene.eventId,
        buyerHumanId,
        amountGrossCents: priceCents,
        feesPlatformCents: 0,
        currency: "usd",
        status: "SUCCEEDED",
        source: "RESALE",
        parentOrderId: ticket.orderId,
        feePolicySnapshot: {},
        stripePaymentIntentId: paymentIntentId,
      },
    });
    const item = await prisma.orderItem.create({
      data: {
        orderId: order.id,
        kind: "ticket",
        ticketTypeId: scene.ticketTypeId,
        qty: 1,
        unitPriceCents: priceCents,
        amountCents: priceCents,
        resaleListingId: listingId,
        meta: {
          resaleListingId: listingId,
          resaleOriginalOrderId: ticket.orderId,
          resaleOriginalOrderItemId: ticket.orderItemId,
        },
      },
    });
    expect(
      (
        await repos.resaleListings.hold(
          listingId,
          buyerHumanId,
          new Date(Date.now() + 600_000),
        )
      ).ok,
    ).toBe(true);
    await repos.tx(async (tx) => {
      await finalizeResalePurchase(tx, {
        order: (await tx.orders.getById(order.id))!,
        clock,
      });
    });
    return { orderId: order.id, itemId: item.id };
  }

  /**
   * The credit a sale left with whoever was paid for it, as the ledger holds
   * it once the sale settles (`metadata.items` attributes it to the order's
   * item). The refund's REFUND_DEBIT is written against it.
   */
  async function seedCredit(orderId: string, itemId: string, amountCents: number) {
    const { prisma } = ready();
    const payee = await prisma.payee.create({
      data: {
        subjectType: "ORGANIZATION",
        subjectId: `cancel-chain-payee-${randomUUID()}`,
        stripeAccountId: null,
        payoutsEnabled: false,
      },
    });
    await prisma.payeeLedgerEntry.create({
      data: {
        idempotencyKey: `test:cancel-chain-credit:${orderId}`,
        payeeId: payee.id,
        type: "SETTLEMENT_CREDIT",
        amountCents,
        currency: "usd",
        sourceKind: "test",
        sourceId: orderId,
        orderId,
        description: "sale credit (test)",
        availableAt: NOW,
        metadata: { items: { [itemId]: amountCents } },
      },
    });
    return payee.id;
  }

  /** A → B → C on one ticket, with each sale's credit in the ledger. */
  async function buildChain(scene: Scene, tag: string) {
    const a = await primaryPurchase(scene, humanA, `pi_${tag}_a`);
    const l1 = await list(scene, a.ticketId, humanA, PAID.b);
    const b = await buy(scene, a.ticketId, l1, humanB, PAID.b, `pi_${tag}_b`);
    const l2 = await list(scene, a.ticketId, humanB, PAID.c);
    const c = await buy(scene, a.ticketId, l2, humanC, PAID.c, `pi_${tag}_c`);
    const payees = {
      organizer: await seedCredit(a.orderId, a.itemId, PAID.a),
      sellerA: await seedCredit(b.orderId, b.itemId, PAID.b),
      sellerB: await seedCredit(c.orderId, c.itemId, PAID.c),
    };
    return { a, b, c, l1, l2, payees };
  }

  type Payments = {
    refunds: Array<{ paymentIntentId: string; amountCents: number }>;
    port: CancelEventDeps["payments"];
  };

  /**
   * Stripe, as far as a cancellation with no paid-out item uses it: the
   * charge's processing fee and the refund. `failRefundFor` makes one
   * PaymentIntent's refund fail the way a declined refund does.
   */
  function fakePayments(feeByPaymentIntent: Record<string, number>, failRefundFor?: string): Payments {
    const refunds: Payments["refunds"] = [];
    const port = {
      getProcessingFeeForPaymentIntent: vi.fn(
        async ({ paymentIntentId }: { paymentIntentId: string }) => ({
          feeCents: feeByPaymentIntent[paymentIntentId] ?? 0,
        }),
      ),
      refundPaymentIntent: vi.fn(
        async (input: { paymentIntentId: string; amountCents: number }) => {
          if (input.paymentIntentId === failRefundFor) {
            throw new Error("stripe_refund_declined");
          }
          refunds.push({
            paymentIntentId: input.paymentIntentId,
            amountCents: input.amountCents,
          });
          return {
            refundId: `re_${input.paymentIntentId}`,
            status: "succeeded" as const,
          };
        },
      ),
    } as unknown as CancelEventDeps["payments"];
    return { refunds, port };
  }

  async function cancel(scene: Scene, payments: Payments, reportError = vi.fn()) {
    const { repos } = ready();
    const result = await cancelEvent(
      {
        repos,
        authz: { hasStaffRole: async () => ({ allowed: false }) },
        payments: payments.port,
        idempotency: createFakeIdempotencyPort(),
        clock,
        reportError: reportError as never,
      } as CancelEventDeps,
      {
        actorHumanId,
        eventId: scene.eventId,
        clientKey: `cancel-chain-${randomUUID()}`,
      },
    );
    return { result, reportError };
  }

  /** Everything a person would look at afterwards, by name. */
  async function observe(
    scene: Scene,
    chain: Awaited<ReturnType<typeof buildChain>>,
    payments: Payments,
  ) {
    const { prisma } = ready();
    const orderStatus = async (id: string) =>
      (await prisma.order.findUniqueOrThrow({ where: { id } })).status;
    const itemStatus = async (id: string) =>
      (await prisma.orderItem.findUniqueOrThrow({ where: { id } })).status;
    const ticket = await prisma.ticket.findUniqueOrThrow({
      where: { id: chain.a.ticketId },
    });
    const holder =
      ticket.ownerHumanId === humanA
        ? "A"
        : ticket.ownerHumanId === humanB
          ? "B"
          : ticket.ownerHumanId === humanC
            ? "C"
            : ticket.ownerHumanId;
    const onItem =
      ticket.orderItemId === chain.a.itemId
        ? "O_A"
        : ticket.orderItemId === chain.b.itemId
          ? "O_B"
          : ticket.orderItemId === chain.c.itemId
            ? "O_C"
            : ticket.orderItemId;
    const debits = await prisma.payeeLedgerEntry.findMany({
      where: {
        type: "REFUND_DEBIT",
        orderId: { in: [chain.a.orderId, chain.b.orderId, chain.c.orderId] },
      },
    });
    const debitFor = (payeeId: string) =>
      debits
        .filter((d) => d.payeeId === payeeId)
        .reduce((sum, d) => sum + d.amountCents, 0);
    const listingStatus = async (id: string) =>
      (await prisma.resaleListing.findUniqueOrThrow({ where: { id } })).status;
    const audit = await prisma.auditLog.findFirst({
      where: { entity: "event", entityId: scene.eventId, action: "cancelled" },
    });
    const refundedTo = (suffix: string) =>
      payments.refunds
        .filter((r) => r.paymentIntentId.endsWith(suffix))
        .reduce((sum, r) => sum + r.amountCents, 0);
    return {
      event: (await prisma.event.findUniqueOrThrow({ where: { id: scene.eventId } })).status,
      stripeRefundCents: {
        A: refundedTo("_a"),
        B: refundedTo("_b"),
        C: refundedTo("_c"),
      },
      refundOrder: payments.refunds.map((r) => r.paymentIntentId.slice(-1).toUpperCase()),
      orders: {
        O_A: await orderStatus(chain.a.orderId),
        O_B: await orderStatus(chain.b.orderId),
        O_C: await orderStatus(chain.c.orderId),
      },
      items: {
        iA: await itemStatus(chain.a.itemId),
        iB: await itemStatus(chain.b.itemId),
        iC: await itemStatus(chain.c.itemId),
      },
      ticket: { holder, onItem, status: ticket.status },
      listings: {
        L1: await listingStatus(chain.l1),
        L2: await listingStatus(chain.l2),
      },
      refundDebitCents: {
        organizer: debitFor(chain.payees.organizer),
        A: debitFor(chain.payees.sellerA),
        B: debitFor(chain.payees.sellerB),
      },
      refundDebitRows: debits.length,
      audit: audit?.data as Record<string, unknown> | undefined,
    };
  }

  const feesFor = (tag: string) => ({
    [`pi_${tag}_a`]: STRIPE_FEE.a,
    [`pi_${tag}_b`]: STRIPE_FEE.b,
    [`pi_${tag}_c`]: STRIPE_FEE.c,
  });

  // ── 1. Every hop refunded, last buyer first ──────────────────────────────

  test("A → B → C: every buyer is refunded, every seller debited once, and the ticket is voided on A's order", async () => {
    const scene = await createEvent();
    const tag = randomUUID().slice(0, 8);
    const chain = await buildChain(scene, tag);
    const payments = fakePayments(feesFor(tag));

    const { result, reportError } = await cancel(scene, payments);
    const seen = await observe(scene, chain, payments);

    expect(result).toMatchObject({ refundedOrderCount: 3, failedRefundCount: 0 });
    // Each buyer: what they paid less that charge's processing fee.
    expect(seen.stripeRefundCents).toEqual({
      A: PAID.a - STRIPE_FEE.a,
      B: PAID.b - STRIPE_FEE.b,
      C: PAID.c - STRIPE_FEE.c,
    });
    // Last buyer first.
    expect(seen.refundOrder).toEqual(["C", "B", "A"]);
    expect(seen.orders).toEqual({ O_A: "REFUNDED", O_B: "REFUNDED", O_C: "REFUNDED" });
    expect(seen.items).toEqual({ iA: "refunded", iB: "refunded", iC: "refunded" });
    // The ticket walked back to A's order and died with it.
    expect(seen.ticket).toEqual({ holder: "A", onItem: "O_A", status: "REFUNDED" });
    expect(seen.listings).toEqual({ L1: "CANCELLED", L2: "CANCELLED" });
    // Each seller gives back exactly what their sale credited, once.
    expect(seen.refundDebitCents).toEqual({
      organizer: PAID.a,
      A: PAID.b,
      B: PAID.c,
    });
    expect(seen.refundDebitRows).toBe(3);
    expect(seen.audit).toMatchObject({
      refundedOrderCount: 3,
      failedRefundCount: 0,
    });
    expect(reportError).not.toHaveBeenCalled();
  }, 120_000);

  // ── 2. The last hop's refund fails ───────────────────────────────────────

  test("A → B → C with C's refund declined: nobody before C is refunded, the ticket stays with C, and each order says why", async () => {
    const scene = await createEvent();
    const tag = randomUUID().slice(0, 8);
    const chain = await buildChain(scene, tag);
    const payments = fakePayments(feesFor(tag), `pi_${tag}_c`);

    const { result } = await cancel(scene, payments);
    const seen = await observe(scene, chain, payments);

    expect(seen.event).toBe("CANCELLED");
    expect(seen.stripeRefundCents).toEqual({ A: 0, B: 0, C: 0 });
    expect(seen.orders).toEqual({ O_A: "SUCCEEDED", O_B: "SUCCEEDED", O_C: "SUCCEEDED" });
    expect(seen.items).toEqual({ iA: "transferred", iB: "transferred", iC: "active" });
    expect(seen.ticket).toMatchObject({ holder: "C", onItem: "O_C" });
    expect(seen.refundDebitRows).toBe(0);
    // O_C failed at Stripe; O_B is held back because of it. O_A carries no
    // refundable item (its one item is a resale parent that was not
    // refunded), so it is skipped, as with one hop.
    expect(result).toMatchObject({ refundedOrderCount: 0, failedRefundCount: 2 });
    expect(seen.audit).toMatchObject({
      failedOrderIds: expect.arrayContaining([chain.c.orderId, chain.b.orderId]),
      failedRefundReasons: [
        { orderId: chain.b.orderId, reason: "later_resale_not_refunded" },
      ],
    });
  }, 120_000);

  // ── 3. Replay ────────────────────────────────────────────────────────────

  test("a second cancellation of the same event is refused and moves nothing", async () => {
    const scene = await createEvent();
    const tag = randomUUID().slice(0, 8);
    const chain = await buildChain(scene, tag);
    const payments = fakePayments(feesFor(tag));
    await cancel(scene, payments);
    const first = await observe(scene, chain, payments);

    await expect(cancel(scene, payments)).rejects.toMatchObject({
      code: "EVENT_ALREADY_CANCELLED",
    });
    const second = await observe(scene, chain, payments);

    expect(second).toEqual(first);
    expect(second.refundDebitRows).toBe(3);
  }, 120_000);
});
