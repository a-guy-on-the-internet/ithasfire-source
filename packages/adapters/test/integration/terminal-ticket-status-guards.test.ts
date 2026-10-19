/**
 * REFUNDED and INVALID are TERMINAL (refunds-restock spec 2026-10-09, fix
 * round 1). Refunds restock: a ticket in either status has given its capacity
 * place back, so a write that moved it into VALID, SCANNED or LISTED again
 * would retake the place without the capacity lock and oversell the tier.
 *
 * The guards live in SQL (status predicates on the update), so a mocked repo
 * cannot show them. This file drives the real use cases and the real adapter
 * against Postgres:
 *
 *   1. A LISTED comp that is revoked has its ACTIVE listing closed in the
 *      same transaction; cancelling afterwards cannot bring the ticket back.
 *      A comp that has PASSED ON (resold, or its listing HELD by a buyer's
 *      checkout) is not voided at all: the grant is revoked and the sale can
 *      finish (fix round 2).
 *   2. `cancelResaleListing` on an INVALID ticket under an ACTIVE listing
 *      cancels the listing and leaves the ticket INVALID; on a listing a
 *      buyer has HELD it refuses and leaves the ticket LISTED.
 *   2b. A refund of a resale order whose ticket is already INVALID still
 *      reconciles: order REFUNDED, REFUND_DEBIT written, listing CANCELLED.
 *   3. `reassignForResale` (LISTED only) and `restoreAfterResale`
 *      (place-holding only) throw on a terminal ticket and change nothing.
 *   4. `setStatus` with `expectedStatus` is a compare-and-swap.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import { reconcileStripeFullRefund } from "@th/core/use-cases/orders/reconcile-stripe-full-refund";
import { cancelResaleListing } from "@th/core/use-cases/resale/cancel-resale-listing";
import { revokeVolunteerReward } from "@th/core/use-cases/volunteering/revoke-volunteer-reward";
import type { Repos } from "@th/ports/repos";
import { createFakeIdempotencyPort } from "@th/test-utils";
import {
  runPrismaMigrateDeploy,
  startPostgresContainer,
  type PostgresTestContainer,
} from "@th/test-utils/testcontainers";

import { createPrismaRepos } from "../../src/db/prisma";
import { makeResaleListingsRepo } from "../../src/db/prisma/resale-listings";
import { makeTicketsRepo } from "../../src/db/prisma/tickets";
import { makeVolunteeringRepo } from "../../src/db/prisma/volunteering";

const NOW = new Date("2027-02-01T12:00:00.000Z");
const clock = { now: () => NOW };

type Status = "VALID" | "SCANNED" | "LISTED" | "REFUNDED" | "INVALID";

describe("Prisma integration – terminal ticket statuses stay terminal", () => {
  let pgContainer: PostgresTestContainer | undefined;
  let pool: pg.Pool | undefined;
  let prisma: PrismaClient | undefined;
  let repos: Repos | undefined;
  let runtimeError: Error | null = null;

  let orgId: string;
  let eventId: string;
  let ticketTypeId: string;
  let sellerId: string;
  let buyerId: string;
  let payeeId: string;

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
        data: { name: `Terminal Org ${tag}`, slug: `terminal-org-${tag}`, status: "ACTIVE" },
      });
      orgId = org.id;
      const event = await prisma.event.create({
        data: {
          orgId,
          title: `Terminal Event ${tag}`,
          startsAt: new Date("2027-03-01T20:00:00Z"),
          endsAt: new Date("2027-03-01T23:00:00Z"),
          status: "PUBLISHED",
          volunteeringEnabled: true,
          timezone: "America/Chicago",
          addressText: "123 Test St",
        },
      });
      eventId = event.id;
      const ticketType = await prisma.ticketType.create({
        data: { eventId, name: "GA", priceCents: 2500, capacity: 100 },
      });
      ticketTypeId = ticketType.id;
      const seller = await prisma.human.create({ data: { name: "Volunteer Seller" } });
      sellerId = seller.id;
      const buyer = await prisma.human.create({ data: { name: "Resale Buyer" } });
      buyerId = buyer.id;
      const payee = await prisma.payee.create({
        data: { subjectType: "ORGANIZATION", subjectId: orgId },
      });
      payeeId = payee.id;
    } catch (err) {
      runtimeError = err as Error;
      console.error("[terminal-ticket-status-guards] setup failed:", err);
    }
  }, 300_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (pool) await pool.end();
    if (pgContainer) await pgContainer.stop();
  });

  test("integration environment is up (canary — do not skip)", () => {
    expect(runtimeError).toBeNull();
    expect(prisma).toBeDefined();
  });

  async function seedTicket(
    status: Status,
    on: { orderId?: string; orderItemId?: string; ownerHumanId?: string } = {},
  ) {
    return prisma!.ticket.create({
      data: {
        eventId,
        ticketTypeId,
        ownerHumanId: on.ownerHumanId ?? sellerId,
        orderId: on.orderId,
        orderItemId: on.orderItemId,
        code: `TERM-${randomUUID()}`,
        status,
      },
    });
  }

  /** An order with one ticket line. COMP = the volunteer's $0 comp order. */
  async function seedOrder(
    source: "COMP" | "RESALE",
    buyerHumanId: string,
    extra: { stripePaymentIntentId?: string; resaleListingId?: string } = {},
  ) {
    const cents = source === "COMP" ? 0 : 2500;
    const order = await prisma!.order.create({
      data: {
        eventId,
        buyerHumanId,
        amountGrossCents: cents,
        feesPlatformCents: 0,
        currency: "usd",
        status: "SUCCEEDED",
        source,
        feePolicySnapshot: {},
        stripePaymentIntentId: extra.stripePaymentIntentId,
      },
    });
    const item = await prisma!.orderItem.create({
      data: {
        orderId: order.id,
        kind: "ticket",
        ticketTypeId,
        qty: 1,
        unitPriceCents: cents,
        amountCents: cents,
        resaleListingId: extra.resaleListingId,
        meta: extra.resaleListingId
          ? { resaleListingId: extra.resaleListingId }
          : {},
      },
    });
    return { order, item };
  }

  /** A comp ticket still the volunteer's: on the comp order, owned by its buyer. */
  async function seedComp(status: Status) {
    const comp = await seedOrder("COMP", sellerId);
    const ticket = await seedTicket(status, {
      orderId: comp.order.id,
      orderItemId: comp.item.id,
    });
    return { ticket, compOrderId: comp.order.id };
  }

  async function grantOf(grantId: string) {
    return prisma!.volunteerRewardGrant.findUniqueOrThrow({ where: { id: grantId } });
  }

  async function orderStatusOf(orderId: string) {
    return (await prisma!.order.findUniqueOrThrow({ where: { id: orderId } })).status;
  }

  async function seedListing(ticketId: string, status: "ACTIVE" | "HELD" = "ACTIVE") {
    const listing = await repos!.resaleListings.create({
      ticketId,
      eventId,
      sellerHumanId: sellerId,
      askPriceCents: 2500,
    });
    if (status !== "ACTIVE") {
      await prisma!.resaleListing.update({ where: { id: listing.id }, data: { status } });
    }
    return listing;
  }

  async function statusOf(ticketId: string) {
    return (await prisma!.ticket.findUniqueOrThrow({ where: { id: ticketId } })).status;
  }

  async function listingStatusOf(listingId: string) {
    return (await prisma!.resaleListing.findUniqueOrThrow({ where: { id: listingId } }))
      .status;
  }

  /** One ask per event (unique), so the ask, role and reward are made once. */
  let rewardFixture: { askId: string; roleId: string; rewardId: string } | undefined;

  /** A GRANTED comp reward grant whose ticket is `ticketId`. */
  async function seedGrant(ticketId: string, compOrderId: string) {
    const volunteering = makeVolunteeringRepo(prisma!);
    if (!rewardFixture) {
      const ask = await volunteering.createAsk({
        subjectType: "EVENT",
        subjectId: eventId,
        orgId,
        title: "Crew",
        status: "OPEN",
      });
      const role = await volunteering.createEventRole({ askId: ask.id, name: "Door" });
      const reward = await volunteering.upsertReward({
        askId: ask.id,
        roleId: role.id,
        ticketTypeId,
      });
      rewardFixture = { askId: ask.id, roleId: role.id, rewardId: reward.id };
    }
    const { askId, roleId, rewardId } = rewardFixture;
    const ask = { id: askId };
    const role = { id: roleId };
    const reward = { id: rewardId };
    const signup = await volunteering.createSignup({
      askId: ask.id,
      roleId: role.id,
      contactEmail: `vol-${randomUUID()}@example.test`,
      status: "APPROVED",
    });
    return volunteering.createGrant({
      rewardId: reward.id,
      signupId: signup.id,
      humanId: sellerId,
      contactEmail: signup.contactEmail,
      ticketId,
      compOrderId,
      faceValueCents: 2500,
    });
  }

  test("revoking a LISTED comp closes its listing; a later cancel cannot revive the ticket", async ({
    skip,
  }) => {
    if (runtimeError || !prisma || !repos) return skip();
    const { ticket, compOrderId } = await seedComp("LISTED");
    const listing = await seedListing(ticket.id);
    const grant = await seedGrant(ticket.id, compOrderId);

    await expect(
      revokeVolunteerReward({ repos, clock }, { grantId: grant.id, reason: "withdrawn" }),
    ).resolves.toEqual({ ok: true });

    expect(await statusOf(ticket.id)).toBe("INVALID");
    expect(await listingStatusOf(listing.id)).toBe("CANCELLED");
    expect(await orderStatusOf(compOrderId)).toBe("CANCELLED");
    expect((await grantOf(grant.id)).status).toBe("REVOKED");

    // The seller tries to cancel the listing afterwards: it is closed, so the
    // cancel is refused, and the ticket stays voided.
    await expect(
      cancelResaleListing(
        { repos, clock },
        { actorHumanId: sellerId, listingId: listing.id },
      ),
    ).rejects.toMatchObject({ code: "LISTING_NOT_ACTIVE" });
    expect(await statusOf(ticket.id)).toBe("INVALID");
  }, 120_000);

  // BLOCKING 2: the buyer's checkout is in flight and may already be paid.
  // Voiding here made finalize's `reassignForResale` throw: a charged buyer
  // with no ticket and nothing to refund them.
  test("revoking while the listing is HELD does NOT void the ticket, and the buyer's finalize still succeeds", async ({
    skip,
  }) => {
    if (runtimeError || !prisma || !repos) return skip();
    const { ticket, compOrderId } = await seedComp("LISTED");
    const listing = await seedListing(ticket.id, "HELD");
    const grant = await seedGrant(ticket.id, compOrderId);
    const reports: unknown[] = [];

    await expect(
      revokeVolunteerReward(
        { repos, clock, reportError: (err) => reports.push(err) },
        { grantId: grant.id, reason: "withdrawn" },
      ),
    ).resolves.toEqual({ ok: true });

    expect(await statusOf(ticket.id)).toBe("LISTED");
    expect(await listingStatusOf(listing.id)).toBe("HELD");
    expect((await grantOf(grant.id)).status).toBe("REVOKED");
    // The comp order still backs a live ticket.
    expect(await orderStatusOf(compOrderId)).toBe("SUCCEEDED");
    expect(reports).toHaveLength(1);

    // The buyer pays: finalize's reassign finds the ticket LISTED and moves it.
    const resale = await seedOrder("RESALE", buyerId);
    await makeTicketsRepo(prisma).reassignForResale({
      ticketId: ticket.id,
      newOrderId: resale.order.id,
      newOrderItemId: resale.item.id,
      newCode: `TERM-${randomUUID()}`,
    });
    expect(await statusOf(ticket.id)).toBe("VALID");
  }, 120_000);

  // BLOCKING 2, the race itself: two real transactions. The buyer's `hold`
  // has flipped the listing to HELD but not committed; the revoke reads it
  // ACTIVE. Its cancel compare-and-swap must wait on the listing row, lose
  // once the hold commits, and then leave the ticket alone.
  test("a revoke racing an uncommitted hold waits on the listing row, loses the cancel, and does not void", async ({
    skip,
  }) => {
    if (runtimeError || !prisma || !repos) return skip();
    const { ticket, compOrderId } = await seedComp("LISTED");
    const listing = await seedListing(ticket.id);
    const grant = await seedGrant(ticket.id, compOrderId);

    let releaseHold!: () => void;
    const holdOpen = new Promise<void>((resolve) => (releaseHold = resolve));
    let holdReached!: () => void;
    const holdFlipped = new Promise<void>((resolve) => (holdReached = resolve));
    const holdTx = prisma.$transaction(
      async (tx) => {
        const held = await makeResaleListingsRepo(tx).hold(
          listing.id,
          buyerId,
          new Date(NOW.getTime() + 10 * 60_000),
        );
        holdReached();
        await holdOpen;
        return held;
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
    await holdFlipped;

    const revoke = revokeVolunteerReward(
      { repos, clock },
      { grantId: grant.id, reason: "withdrawn" },
    );
    const raced = await Promise.race([
      revoke.then(
        () => "settled",
        () => "settled",
      ),
      new Promise((resolve) => setTimeout(() => resolve("still-blocked"), 750)),
    ]);
    expect(raced).toBe("still-blocked");

    releaseHold();
    await expect(holdTx).resolves.toEqual({ ok: true });
    await expect(revoke).resolves.toEqual({ ok: true });

    expect(await listingStatusOf(listing.id)).toBe("HELD");
    expect(await statusOf(ticket.id)).toBe("LISTED");
    expect((await grantOf(grant.id)).status).toBe("REVOKED");
    expect(await orderStatusOf(compOrderId)).toBe("SUCCEEDED");
  }, 120_000);

  // BLOCKING 1(a): the comp was resold; the buyer holds a VALID ticket on
  // their own RESALE order. The revoke must not take it from them.
  test("revoking a comp that was RESOLD leaves the buyer's ticket VALID and revokes the grant", async ({
    skip,
  }) => {
    if (runtimeError || !prisma || !repos) return skip();
    const comp = await seedOrder("COMP", sellerId);
    const resale = await seedOrder("RESALE", buyerId);
    const ticket = await seedTicket("VALID", {
      orderId: resale.order.id,
      orderItemId: resale.item.id,
      ownerHumanId: buyerId,
    });
    const grant = await seedGrant(ticket.id, comp.order.id);
    const rewardBefore = await prisma.volunteerReward.findUniqueOrThrow({
      where: { id: grant.rewardId },
    });
    const reports: unknown[] = [];

    await expect(
      revokeVolunteerReward(
        { repos, clock, reportError: (err) => reports.push(err) },
        { grantId: grant.id, reason: "withdrawn" },
      ),
    ).resolves.toEqual({ ok: true });

    expect(await statusOf(ticket.id)).toBe("VALID");
    expect((await grantOf(grant.id)).status).toBe("REVOKED");
    expect(await orderStatusOf(comp.order.id)).toBe("SUCCEEDED");
    // The place is still taken, so the budget slot stays used.
    const rewardAfter = await prisma.volunteerReward.findUniqueOrThrow({
      where: { id: grant.rewardId },
    });
    expect(rewardAfter.grantsUsed).toBe(rewardBefore.grantsUsed);
    expect(reports).toHaveLength(1);
  }, 120_000);

  // BLOCKING 1(b): rows already voided in prod. The real webhook reconcile
  // runs against Postgres: before the fix `restoreAfterResale` threw
  // `resale_restore_ticket_terminal` and rolled the whole transaction back.
  test("a full refund of a resale order whose ticket is already INVALID reconciles: REFUNDED, REFUND_DEBIT, listing CANCELLED", async ({
    skip,
  }) => {
    if (runtimeError || !prisma || !repos) return skip();
    const pi = `pi_${randomUUID().replace(/-/g, "")}`;
    // Listing first (its id goes on the resale order's item), SOLD to the order.
    const stub = await seedTicket("LISTED");
    const listing = await seedListing(stub.id);
    const resale = await seedOrder("RESALE", buyerId, {
      stripePaymentIntentId: pi,
      resaleListingId: listing.id,
    });
    await prisma.resaleListing.update({
      where: { id: listing.id },
      data: { status: "SOLD", buyerOrderId: resale.order.id },
    });
    // The buyer's ticket, voided while they held it.
    await prisma.ticket.update({
      where: { id: stub.id },
      data: {
        status: "INVALID",
        ownerHumanId: buyerId,
        orderId: resale.order.id,
        orderItemId: resale.item.id,
      },
    });
    // The seller was credited for the sale.
    await repos.payeeLedger.settlementCredit({
      idempotencyKey: `settlement-credit:${resale.order.id}:${payeeId}`,
      payeeId,
      amountCents: 2500,
      currency: "usd",
      orderId: resale.order.id,
      availableAt: NOW,
      description: "resale sale",
      metadata: { items: { [resale.item.id]: 2500 } },
      sourceKind: "order",
      sourceId: resale.order.id,
    });
    const reports: unknown[] = [];

    const result = await reconcileStripeFullRefund(
      {
        repos,
        clock,
        idempotency: createFakeIdempotencyPort(),
        reportError: (err) => reports.push(err),
      },
      {
        paymentIntentId: pi,
        amountRefundedCents: 2500,
        sourceEventType: "charge.refund.updated",
        refundId: `re_${randomUUID().replace(/-/g, "")}`,
      },
    );

    expect(result.outcome).toBe("reconciled_resale");
    expect(await orderStatusOf(resale.order.id)).toBe("REFUNDED");
    expect(await listingStatusOf(listing.id)).toBe("CANCELLED");
    // The dead ticket stays dead and is not handed back.
    const after = await prisma.ticket.findUniqueOrThrow({ where: { id: stub.id } });
    expect(after.status).toBe("INVALID");
    expect(after.ownerHumanId).toBe(buyerId);
    const debits = await prisma.payeeLedgerEntry.findMany({
      where: { orderId: resale.order.id, type: "REFUND_DEBIT" },
    });
    expect(debits).toHaveLength(1);
    expect(
      reports.some(
        (err) =>
          err instanceof Error &&
          err.message === "resale_unwind_ticket_already_terminal",
      ),
    ).toBe(true);
  }, 120_000);

  // WARNING 4: the listing was read ACTIVE, then a buyer's hold landed.
  test("cancelling a listing a buyer has HELD refuses with LISTING_NOT_ACTIVE and leaves the ticket LISTED", async ({
    skip,
  }) => {
    if (runtimeError || !prisma || !repos) return skip();
    const ticket = await seedTicket("LISTED");
    const listing = await seedListing(ticket.id);
    // The use case's own unlocked read sees ACTIVE; the hold commits before
    // its cancel CAS. Reproduced by flipping the row from inside the
    // listing read the use case makes.
    const racing: Repos = {
      ...repos,
      tx: (fn) =>
        repos!.tx(async (tx) => {
          const wrapped = {
            ...tx,
            resaleListings: {
              ...tx.resaleListings,
              getById: async (id: string) => {
                const row = await tx.resaleListings.getById(id);
                // A buyer's hold commits right after the read (autocommit).
                await prisma!.resaleListing.update({
                  where: { id },
                  data: { status: "HELD" },
                });
                return row;
              },
            },
          };
          return fn(wrapped as typeof tx);
        }),
    };

    await expect(
      cancelResaleListing(
        { repos: racing, clock },
        { actorHumanId: sellerId, listingId: listing.id },
      ),
    ).rejects.toMatchObject({ code: "LISTING_NOT_ACTIVE" });

    expect(await listingStatusOf(listing.id)).toBe("HELD");
    expect(await statusOf(ticket.id)).toBe("LISTED");
  }, 120_000);

  test("cancelling an ACTIVE listing over an already-INVALID ticket leaves it INVALID", async ({
    skip,
  }) => {
    if (runtimeError || !prisma || !repos) return skip();
    // The state the pre-fix revoke left behind.
    const ticket = await seedTicket("INVALID");
    const listing = await seedListing(ticket.id);

    await cancelResaleListing(
      { repos, clock },
      { actorHumanId: sellerId, listingId: listing.id },
    );

    expect(await listingStatusOf(listing.id)).toBe("CANCELLED");
    expect(await statusOf(ticket.id)).toBe("INVALID");
  }, 120_000);

  test("cancelling an ACTIVE listing over a LISTED ticket still restores VALID", async ({
    skip,
  }) => {
    if (runtimeError || !prisma || !repos) return skip();
    const ticket = await seedTicket("LISTED");
    const listing = await seedListing(ticket.id);

    await cancelResaleListing(
      { repos, clock },
      { actorHumanId: sellerId, listingId: listing.id },
    );

    expect(await statusOf(ticket.id)).toBe("VALID");
  }, 120_000);

  test.each(["REFUNDED", "INVALID", "VALID"] as const)(
    "reassignForResale refuses a %s ticket and changes nothing",
    async (status) => {
      if (runtimeError || !prisma) return;
      const tickets = makeTicketsRepo(prisma);
      const ticket = await seedTicket(status);

      await expect(
        tickets.reassignForResale({
          ticketId: ticket.id,
          newOrderId: randomUUID(),
          newOrderItemId: randomUUID(),
          newCode: `TERM-${randomUUID()}`,
        }),
      ).rejects.toMatchObject({ code: "conflict", message: "resale_reassign_ticket_not_listed" });
      const after = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
      expect(after.status).toBe(status);
      expect(after.code).toBe(ticket.code);
    },
    120_000,
  );

  test.each(["REFUNDED", "INVALID"] as const)(
    "restoreAfterResale refuses a %s ticket and changes nothing",
    async (status) => {
      if (runtimeError || !prisma) return;
      const tickets = makeTicketsRepo(prisma);
      const ticket = await seedTicket(status);

      await expect(
        tickets.restoreAfterResale({
          ticketId: ticket.id,
          restoredOrderId: null,
          restoredOrderItemId: null,
          newCode: `TERM-${randomUUID()}`,
        }),
      ).rejects.toMatchObject({ code: "conflict", message: "resale_restore_ticket_terminal" });
      const after = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
      expect(after.status).toBe(status);
      expect(after.code).toBe(ticket.code);
    },
    120_000,
  );

  test.each(["VALID", "SCANNED", "LISTED"] as const)(
    "restoreAfterResale hands a %s ticket back as VALID (today's unwind inputs)",
    async (status) => {
      if (runtimeError || !prisma) return;
      const tickets = makeTicketsRepo(prisma);
      const ticket = await seedTicket(status);

      await tickets.restoreAfterResale({
        ticketId: ticket.id,
        restoredOrderId: null,
        restoredOrderItemId: null,
        newCode: `TERM-${randomUUID()}`,
      });
      expect(await statusOf(ticket.id)).toBe("VALID");
    },
    120_000,
  );

  test("reassignForResale moves a LISTED ticket to VALID", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const tickets = makeTicketsRepo(prisma);
    const ticket = await seedTicket("LISTED");
    // FKs: a real order + item to point at.
    const order = await prisma.order.create({
      data: {
        eventId,
        buyerHumanId: sellerId,
        amountGrossCents: 2500,
        feesPlatformCents: 0,
        currency: "usd",
        status: "SUCCEEDED",
        source: "RESALE",
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
        meta: {},
      },
    });

    await tickets.reassignForResale({
      ticketId: ticket.id,
      newOrderId: order.id,
      newOrderItemId: item.id,
      newCode: `TERM-${randomUUID()}`,
    });
    expect(await statusOf(ticket.id)).toBe("VALID");
  }, 120_000);

  test("setStatus with expectedStatus is a compare-and-swap", async ({ skip }) => {
    if (runtimeError || !prisma) return skip();
    const tickets = makeTicketsRepo(prisma);
    const voided = await seedTicket("INVALID");
    const live = await seedTicket("VALID");

    await expect(
      tickets.setStatus(voided.id, "LISTED", { expectedStatus: "VALID" }),
    ).resolves.toBe(false);
    expect(await statusOf(voided.id)).toBe("INVALID");

    await expect(
      tickets.setStatus(live.id, "LISTED", { expectedStatus: "VALID" }),
    ).resolves.toBe(true);
    expect(await statusOf(live.id)).toBe("LISTED");
  }, 120_000);
});
