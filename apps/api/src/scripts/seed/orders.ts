import type { PrismaClient } from "@prisma/client";
import { type OrderStatus } from "@prisma/client";
import { hashPassword } from "better-auth/crypto";
import Stripe from "stripe";
import { createPrismaRepos } from "@th/adapters/db/prisma";
import { DEMO_IDS } from "./ids.js";
import { BUYER_FIXTURES } from "./fixtures.js";
import {
  STRIPE_MIN_AMOUNT_CENTS,
  createConfirmedPaymentIntent,
  priceSeedCart,
  priceSeedOrder,
  pricedOrderColumns,
  refundSeedOrderOnStripe,
  refundStampsFor,
  seedRefundedAt,
  seedStripeFromEnv,
  tryLoadSeedEventPricing,
  writeSeedTaxLines,
  type SeedEventPricing,
  type SeedOrderPricing,
  type SeedTicketItem,
} from "./order-pricing.js";
import { pMap } from "./utils.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The status a generated web order may carry, and the shape it is written in.
 *
 * Every product path that writes PART_REFUNDED refunds a ticket item first
 * and leaves another live, so it needs 2+ tickets and a real charge to
 * refund; otherwise the order is SUCCEEDED. (Order.status DISPUTED is never
 * rolled: no production path writes it — the dispute lifecycle only sets the
 * `disputeStatus` / `disputedAt` mirror columns.)
 *
 * PENDING and CANCELLED are carts: `updateOrderItems` holds them (no charge,
 * no tax persisted) and every cancel path only flips the status, so they take
 * `priceSeedCart`'s shape. Everything else took the checkout charge.
 */
const planWebOrder = (
  pricing: SeedEventPricing,
  lines: Array<{ ticketTypeId: string; qty: number }>,
  occurredAt: Date,
  rolled: OrderStatus,
): { status: OrderStatus; priced: SeedOrderPricing } => {
  const qty = lines.reduce((sum, line) => sum + line.qty, 0);
  const checkout = priceSeedOrder(pricing, lines, occurredAt);
  if (rolled === "PENDING" || rolled === "CANCELLED") {
    return { status: rolled, priced: priceSeedCart(pricing, lines, occurredAt) };
  }
  const charged = checkout.chargeCents >= STRIPE_MIN_AMOUNT_CENTS;
  if (rolled === "PART_REFUNDED" && (!charged || qty < 2)) {
    return { status: "SUCCEEDED", priced: checkout };
  }
  return { status: rolled, priced: checkout };
};

// ── Demo orders (random buyers against org-owned events) ─────────────────

/**
 * Seeds demo orders (with tickets) for published events so the attendee-search
 * UI has data to display and every order-status filter option has matching rows.
 *
 * Each published event gets 4-6 orders from random buyer humans.
 * Each order has 1-4 tickets. Statuses are distributed across SUCCEEDED,
 * PART_REFUNDED, PENDING and CANCELLED (see `planWebOrder` for which rolls
 * are demoted to SUCCEEDED and why DISPUTED is never written).
 *
 * When `stripeSecretKey` is provided, SUCCEEDED and PART_REFUNDED orders get
 * real Stripe PaymentIntents. Without it the function is **skipped entirely**
 * because downstream flows (refund quotes, fee lookups) would 500 against
 * fake `pi_seed_*` IDs.
 */
export const seedDemoOrders = async (
  prisma: PrismaClient,
  publishedEvents: Array<{ id: string; slug: string; title: string }>,
  opts?: { stripeSecretKey?: string },
) => {
  if (publishedEvents.length === 0) {
    console.log("  No published events -- skipping order seed.");
    return;
  }

  // ── Guard: require a real Stripe key ─────────────────────────────────
  if (!opts?.stripeSecretKey) {
    console.log("");
    console.log(
      "  ╔══════════════════════════════════════════════════════════════════╗",
    );
    console.log(
      "  ║  STRIPE_SECRET_KEY is NOT set — skipping demo orders.           ║",
    );
    console.log(
      "  ║                                                                  ║",
    );
    console.log(
      "  ║  Demo orders require real Stripe PaymentIntents so that          ║",
    );
    console.log(
      "  ║  refund quotes, fee lookups, and refund flows work correctly.    ║",
    );
    console.log(
      "  ║                                                                  ║",
    );
    console.log(
      "  ║  To seed demo orders, set STRIPE_SECRET_KEY in .env.local        ║",
    );
    console.log(
      "  ║  (use a Stripe test-mode key, e.g. sk_test_...) and re-run:     ║",
    );
    console.log(
      "  ║                                                                  ║",
    );
    console.log(
      "  ║    pnpm -F api seed:dev                                          ║",
    );
    console.log(
      "  ║                                                                  ║",
    );
    console.log(
      "  ╚══════════════════════════════════════════════════════════════════╝",
    );
    console.log("");
    return;
  }

  console.log(
    "Seeding demo orders & tickets (with real Stripe PaymentIntents)...",
  );

  const stripe = new Stripe(opts.stripeSecretKey, {
    apiVersion: "2025-08-27.basil" as any,
  });
  const passwordHash = await hashPassword("buyer1234");

  // Create buyer humans + auth users (parallel)
  const buyerIds = await Promise.all(
    BUYER_FIXTURES.map(async (fixture, i) => {
      const humanId = `00000000-0000-4000-8000-0000d1${String(i).padStart(2, "0")}0000`;
      const authUserId = `00000000-0000-4000-8000-0000b1${String(i).padStart(2, "0")}0000`;

      await prisma.human.upsert({
        where: { id: humanId },
        update: { name: fixture.name, status: "ACTIVE" },
        create: {
          id: humanId,
          name: fixture.name,
          status: "ACTIVE",
          locale: "en",
        },
      });

      const authUser = await prisma.authUser.upsert({
        where: { id: authUserId },
        update: {
          email: fixture.email,
          name: fixture.name,
          emailVerified: true,
          humanId,
        },
        create: {
          id: authUserId,
          email: fixture.email,
          name: fixture.name,
          emailVerified: true,
          humanId,
        },
      });

      await prisma.authAccount.upsert({
        where: {
          providerId_accountId: {
            providerId: "credential",
            accountId: authUser.id,
          },
        },
        update: { password: passwordHash, userId: authUser.id },
        create: {
          providerId: "credential",
          accountId: authUser.id,
          password: passwordHash,
          userId: authUser.id,
        },
      });

      return humanId;
    }),
  );

  console.log(`  Created ${buyerIds.length} buyer humans`);

  const repos = createPrismaRepos(prisma);

  // Deterministic seeded random (simple LCG so re-runs produce same data)
  let rngState = 42;
  const nextRng = () => {
    rngState = (rngState * 1664525 + 1013904223) & 0x7fffffff;
    return rngState / 0x7fffffff;
  };

  // Seed up to 8 published events with orders (covers multiple orgs)
  const eventsToSeed = publishedEvents.slice(0, 8);

  // Pre-fetch the sellable ticket types for all events in parallel
  const eventTicketTypes = await Promise.all(
    eventsToSeed.map((event) =>
      prisma.ticketType.findMany({
        where: { eventId: event.id, status: "ACTIVE" },
        select: { id: true, name: true, priceCents: true },
      }),
    ),
  );

  // Plan every order (checkout pricing is read once per event)
  type OrderPlan = {
    orderId: string;
    eventId: string;
    buyerHumanId: string;
    ticketTypeId: string;
    ticketCount: number;
    priced: SeedOrderPricing;
    status: OrderStatus;
    occurredAt: Date;
    evtHex: string;
    ordHex: string;
  };
  const orderPlans: OrderPlan[] = [];

  for (let evtIdx = 0; evtIdx < eventsToSeed.length; evtIdx++) {
    const event = eventsToSeed[evtIdx]!;
    const ticketTypes = eventTicketTypes[evtIdx]!;
    if (ticketTypes.length === 0) continue;
    const eventPricing = await tryLoadSeedEventPricing(prisma, repos, event.id);
    if (!eventPricing) continue;

    const orderCount = 4 + Math.floor(nextRng() * 3);
    for (let orderIdx = 0; orderIdx < orderCount; orderIdx++) {
      const buyerHumanId = buyerIds[Math.floor(nextRng() * buyerIds.length)]!;
      const ticketType =
        ticketTypes[Math.floor(nextRng() * ticketTypes.length)]!;
      const ticketCount = 1 + Math.floor(nextRng() * 4);

      const statusRoll = nextRng();
      let rolled: OrderStatus;
      if (statusRoll < 0.7) rolled = "SUCCEEDED";
      else if (statusRoll < 0.8) rolled = "PART_REFUNDED";
      else if (statusRoll < 0.88) rolled = "PENDING";
      else if (statusRoll < 0.94) rolled = "CANCELLED";
      else rolled = "SUCCEEDED"; // was DISPUTED — no product path writes it

      const daysAgo = Math.floor(nextRng() * 30);
      const occurredAt = new Date(Date.now() - daysAgo * DAY_MS);

      const evtHex = evtIdx.toString(16).padStart(2, "0");
      const ordHex = orderIdx.toString(16).padStart(3, "0");
      const orderId = `00000000-0000-4000-8000-e0${evtHex}0${ordHex}0000`;
      const { status, priced } = planWebOrder(
        eventPricing,
        [{ ticketTypeId: ticketType.id, qty: ticketCount }],
        occurredAt,
        rolled,
      );

      orderPlans.push({
        orderId,
        eventId: event.id,
        buyerHumanId,
        ticketTypeId: ticketType.id,
        ticketCount,
        priced,
        status,
        occurredAt,
        evtHex,
        ordHex,
      });
    }
  }

  // Insert all orders + items + tickets concurrently (cap at 5 for Stripe rate limits)
  let totalOrders = 0;
  let totalTickets = 0;

  await pMap(orderPlans, 5, async (plan) => {
    let status = plan.status;
    const totalChargeCents = plan.priced.chargeCents;
    let stripePaymentIntentId: string | null = null;

    // One OrderItem per ticket (qty:1 each). A PART_REFUNDED order had its
    // LAST ticket refunded by refundOrderItems; carts (PENDING / CANCELLED)
    // were never charged and no cancel path touches their items.
    const orderItems = plan.priced.items.map((item, t) => ({
      ...item,
      id: `00000000-0000-4000-8000-a1${plan.evtHex}0${plan.ordHex}${t.toString(16).padStart(2, "0")}00`,
      amountCents: item.unitPriceCents,
    }));
    let refundedItemIds = new Set<string>(
      status === "PART_REFUNDED" ? [orderItems[orderItems.length - 1]!.id] : [],
    );

    // Create a real Stripe PaymentIntent for charged orders
    const isCart = status === "PENDING" || status === "CANCELLED";
    if (!isCart && totalChargeCents >= STRIPE_MIN_AMOUNT_CENTS) {
      stripePaymentIntentId = await createConfirmedPaymentIntent(stripe, {
        amountCents: totalChargeCents,
        currency: "usd",
        metadata: {
          orderId: plan.orderId,
          eventId: plan.eventId,
          source: "demo-seed",
        },
      });
    }
    // Refund state is written only if Stripe actually refunded.
    if (refundedItemIds.size > 0) {
      const refunded =
        stripePaymentIntentId !== null &&
        (await refundSeedOrderOnStripe(stripe, {
          kind: "items",
          paymentIntentId: stripePaymentIntentId,
          orderId: plan.orderId,
          ticketItems: orderItems,
          order: plan.priced,
          refundedItemIds,
        }));
      if (!refunded) {
        status = "SUCCEEDED";
        refundedItemIds = new Set();
      }
    }

    await prisma.order.upsert({
      where: { id: plan.orderId },
      update: {},
      create: {
        id: plan.orderId,
        eventId: plan.eventId,
        buyerHumanId: plan.buyerHumanId,
        ...pricedOrderColumns(plan.priced),
        currency: "usd",
        status,
        occurredAt: plan.occurredAt,
        stripePaymentIntentId,
        source: "PRIMARY",
      },
    });
    await writeSeedTaxLines(prisma, repos, plan.orderId, plan.priced);

    const refundStamps = refundStampsFor(orderItems, plan.priced);
    for (const item of orderItems) {
      await prisma.orderItem.upsert({
        where: { id: item.id },
        update: {},
        create: {
          id: item.id,
          orderId: plan.orderId,
          kind: "ticket",
          ticketTypeId: item.ticketTypeId,
          qty: 1,
          unitPriceCents: item.unitPriceCents,
          amountCents: item.amountCents,
          meta: item.meta,
          ...(refundedItemIds.has(item.id)
            ? {
                status: "refunded",
                refundedAt: seedRefundedAt(plan.occurredAt, DAY_MS),
                ...refundStamps(item.id),
              }
            : {}),
        },
      });
    }

    // Skip ticket creation for PENDING orders (not yet paid) and CANCELLED orders
    if (isCart) {
      totalOrders++;
      return;
    }

    await Promise.all(
      Array.from({ length: plan.ticketCount }, (_, t) => {
        const tHex = t.toString(16);
        const tHexPad = t.toString(16).padStart(2, "0");
        const ticketId = `00000000-0000-4000-8000-b2${plan.evtHex}0${plan.ordHex}00${tHex}0`;
        const matchingOrderItemId = `00000000-0000-4000-8000-a1${plan.evtHex}0${plan.ordHex}${tHexPad}00`;
        const ticketCode = `SEED-E${plan.evtHex}-${String(parseInt(plan.ordHex, 16)).padStart(3, "0")}-${t}`;
        return prisma.ticket.upsert({
          where: { id: ticketId },
          update: {},
          create: {
            id: ticketId,
            eventId: plan.eventId,
            orderId: plan.orderId,
            orderItemId: matchingOrderItemId,
            ticketTypeId: plan.ticketTypeId,
            ownerHumanId: plan.buyerHumanId,
            code: ticketCode,
            // A refunded item's ticket is REFUNDED, as the refund paths set it.
            status: refundedItemIds.has(matchingOrderItemId)
              ? ("REFUNDED" as const)
              : ("VALID" as const),
            issuedAt: plan.occurredAt,
          },
        });
      }),
    );

    totalOrders++;
    totalTickets += plan.ticketCount;
  });

  console.log(
    `  Seeded ${totalOrders} orders with ${totalTickets} tickets across ${eventsToSeed.length} events`,
  );
};

// ── Dev-login user orders ────────────────────────────────────────────────

/**
 * Seeds orders specifically for the dev-login user so the "My Tickets" UI has
 * data to display and refund actions can be exercised.
 *
 * When `stripeSecretKey` is provided, SUCCEEDED and PART_REFUNDED orders get
 * real Stripe PaymentIntents (confirmed with `pm_card_visa`). This makes
 * refund-quote and refund flows work against actual Stripe objects.
 *
 * Without a key the dev-login orders are **skipped entirely** — no fake
 * PaymentIntent IDs are created because downstream flows (refund quotes,
 * fee lookups) would 500 against them.
 *
 * Events that receive real Stripe orders are tagged with `[STRIPE]` in their
 * title so devs can visually identify which events have working payment data.
 */
/** The dev-login PART_REFUNDED order's two ticket items, as the allocators read them. */
const partRefundItems = (
  priced: SeedOrderPricing,
  ordIdx: string,
): SeedTicketItem[] =>
  [
    `00000000-0000-4000-8000-c10500${ordIdx}0000`,
    `00000000-0000-4000-8000-c20500${ordIdx}0000`,
  ].map((id, t) => ({
    id,
    amountCents: priced.items[t]!.unitPriceCents,
    meta: priced.items[t]!.meta,
  }));

export const seedDevLoginOrders = async (
  prisma: PrismaClient,
  publishedEvents: Array<{ id: string; slug: string; title: string }>,
  opts?: { stripeSecretKey?: string },
) => {
  if (publishedEvents.length === 0) {
    console.log("  No published events -- skipping dev-login order seed.");
    return;
  }

  // ── Guard: require a real Stripe key ─────────────────────────────────
  if (!opts?.stripeSecretKey) {
    console.log("");
    console.log(
      "  ╔══════════════════════════════════════════════════════════════════╗",
    );
    console.log(
      "  ║  STRIPE_SECRET_KEY is NOT set — skipping dev-login orders.      ║",
    );
    console.log(
      "  ║                                                                  ║",
    );
    console.log(
      "  ║  Dev-login orders require real Stripe PaymentIntents so that     ║",
    );
    console.log(
      "  ║  refund quotes, fee lookups, and refund flows work correctly.    ║",
    );
    console.log(
      "  ║                                                                  ║",
    );
    console.log(
      "  ║  To seed dev-login orders, set STRIPE_SECRET_KEY in .env.local   ║",
    );
    console.log(
      "  ║  (use a Stripe test-mode key, e.g. sk_test_...) and re-run:     ║",
    );
    console.log(
      "  ║                                                                  ║",
    );
    console.log(
      "  ║    pnpm -F api seed:dev                                          ║",
    );
    console.log(
      "  ║                                                                  ║",
    );
    console.log(
      "  ╚══════════════════════════════════════════════════════════════════╝",
    );
    console.log("");
    return;
  }

  console.log(
    "Seeding dev-login user orders (with real Stripe PaymentIntents)...",
  );

  const stripe = new Stripe(opts.stripeSecretKey, {
    apiVersion: "2025-08-27.basil" as any,
  });

  const devHumanId = DEMO_IDS.devUser;
  const repos = createPrismaRepos(prisma);

  // Limit dev-login seeded events to 3 for a small, focused dev dataset
  const events = publishedEvents.slice(0, Math.min(3, publishedEvents.length));

  // Track which event IDs received real Stripe orders so we can tag them
  const stripeEnabledEventIds = new Set<string>();

  let totalOrders = 0;
  let totalTickets = 0;

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    const ticketTypes = await prisma.ticketType.findMany({
      where: { eventId: event.id, status: "ACTIVE" },
      select: { id: true, name: true, priceCents: true },
    });

    if (ticketTypes.length === 0) continue;
    const eventPricing = await tryLoadSeedEventPricing(prisma, repos, event.id);
    if (!eventPricing) continue;

    const ordIdx = i.toString(16).padStart(2, "0");
    const orderId = `00000000-0000-4000-8000-d00500${ordIdx}0000`;
    const ticketType = ticketTypes[0]!;
    const ticketCount = 2;

    const daysAgo = [3, 7, 14][i] ?? 5;
    const occurredAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);

    // With 3 events: SUCCEEDED, SUCCEEDED, PART_REFUNDED. The PART_REFUNDED
    // order is one ticket of each of the first two types (the second is
    // refunded below), so it needs two types; otherwise it is two of the
    // first type and SUCCEEDED.
    const isPartRefundCart = i === 2 && ticketTypes.length >= 2;
    const priced = priceSeedOrder(
      eventPricing,
      isPartRefundCart
        ? [
            { ticketTypeId: ticketTypes[0]!.id, qty: 1 },
            { ticketTypeId: ticketTypes[1]!.id, qty: 1 },
          ]
        : [{ ticketTypeId: ticketType.id, qty: ticketCount }],
      occurredAt,
    );
    let status: OrderStatus =
      isPartRefundCart && priced.chargeCents >= STRIPE_MIN_AMOUNT_CENTS
        ? "PART_REFUNDED"
        : "SUCCEEDED";

    // Every dev-login order gets a real Stripe PI — no fallback to fakes
    const totalChargeCents = priced.chargeCents;
    let stripePaymentIntentId: string | null = null;

    if (totalChargeCents >= STRIPE_MIN_AMOUNT_CENTS) {
      stripePaymentIntentId = await createConfirmedPaymentIntent(stripe, {
        amountCents: totalChargeCents,
        currency: "usd",
        metadata: { orderId, eventId: event.id, source: "seed" },
      });
      console.log(
        `    Order ${orderId.slice(-6)} → real PI ${stripePaymentIntentId}`,
      );
      if (status === "PART_REFUNDED") {
        // refundOrderItems on the second ticket — the stamps below come off
        // the same allocation. Refund state is written only if Stripe
        // actually refunded.
        const refunded = await refundSeedOrderOnStripe(stripe, {
          kind: "items",
          paymentIntentId: stripePaymentIntentId,
          orderId,
          ticketItems: partRefundItems(priced, ordIdx),
          order: priced,
          refundedItemIds: new Set([partRefundItems(priced, ordIdx)[1]!.id]),
        });
        if (!refunded) status = "SUCCEEDED";
      }
    } else {
      console.log(
        `    Order ${orderId.slice(-6)} → skipped Stripe PI (amount ${totalChargeCents}¢ < minimum ${STRIPE_MIN_AMOUNT_CENTS}¢)`,
      );
    }
    stripeEnabledEventIds.add(event.id);

    await prisma.order.upsert({
      where: { id: orderId },
      update: {},
      create: {
        id: orderId,
        eventId: event.id,
        buyerHumanId: devHumanId,
        ...pricedOrderColumns(priced),
        currency: "usd",
        status,
        occurredAt,
        stripePaymentIntentId,
        source: "PRIMARY",
      },
    });
    await writeSeedTaxLines(prisma, repos, orderId, priced);

    if (status === "PART_REFUNDED") {
      // PART_REFUNDED: 2 items (one refunded, one active)
      const item1Id = `00000000-0000-4000-8000-c10500${ordIdx}0000`;
      const item2Id = `00000000-0000-4000-8000-c20500${ordIdx}0000`;
      const item1 = priced.items[0]!;
      const item2 = priced.items[1]!;
      const refundStamps = refundStampsFor(
        partRefundItems(priced, ordIdx),
        priced,
      );

      await prisma.orderItem.upsert({
        where: { id: item1Id },
        update: {},
        create: {
          id: item1Id,
          orderId,
          kind: "ticket",
          ticketTypeId: item1.ticketTypeId,
          qty: 1,
          unitPriceCents: item1.unitPriceCents,
          amountCents: item1.unitPriceCents,
          meta: item1.meta,
        },
      });

      await prisma.orderItem.upsert({
        where: { id: item2Id },
        update: {},
        create: {
          id: item2Id,
          orderId,
          kind: "ticket",
          ticketTypeId: item2.ticketTypeId,
          qty: 1,
          unitPriceCents: item2.unitPriceCents,
          amountCents: item2.unitPriceCents,
          meta: item2.meta,
          // As refund-order-items stamps it via orderItems.updateStatus.
          status: "refunded",
          refundedAt: seedRefundedAt(occurredAt, 2 * DAY_MS),
          ...refundStamps(item2Id),
        },
      });

      const ticketId = `00000000-0000-4000-8000-d30500${ordIdx}0000`;
      await prisma.ticket.upsert({
        where: { id: ticketId },
        update: {},
        create: {
          id: ticketId,
          eventId: event.id,
          orderId,
          orderItemId: item1Id,
          ticketTypeId: ticketTypes[0]!.id,
          ownerHumanId: devHumanId,
          code: `DEV-${ordIdx}-0`,
          status: "VALID",
          issuedAt: occurredAt,
        },
      });

      const refTicketId = `00000000-0000-4000-8000-d40500${ordIdx}0000`;
      await prisma.ticket.upsert({
        where: { id: refTicketId },
        update: {},
        create: {
          id: refTicketId,
          eventId: event.id,
          orderId,
          orderItemId: item2Id,
          ticketTypeId: ticketTypes[1]!.id,
          ownerHumanId: devHumanId,
          code: `DEV-${ordIdx}-1-REF`,
          status: "REFUNDED",
          issuedAt: occurredAt,
        },
      });

      totalTickets += 2;
    } else {
      for (let t = 0; t < priced.items.length; t++) {
        const item = priced.items[t]!;
        const tHex = t.toString(16).padStart(2, "0");
        // 12 hex chars: c1050(5) + ord(2) + t(2) + 000(3) = 12. Drop one
        // leading zero from the prefix so the total length is correct
        // regardless of how many tickets are in the order.
        const orderItemId = `00000000-0000-4000-8000-c1050${ordIdx}${tHex}000`;
        await prisma.orderItem.upsert({
          where: { id: orderItemId },
          update: {},
          create: {
            id: orderItemId,
            orderId,
            kind: "ticket",
            ticketTypeId: item.ticketTypeId,
            qty: 1,
            unitPriceCents: item.unitPriceCents,
            amountCents: item.unitPriceCents,
            meta: item.meta,
          },
        });
      }

      // All dev-login orders are SUCCEEDED or PART_REFUNDED — always create tickets
      for (let t = 0; t < priced.items.length; t++) {
        const tHex = t.toString(16).padStart(2, "0");
        // Must match the OrderItem template above — both share the
        // `c1050${ordIdx}${tHex}000` shape so the Ticket FK resolves.
        const matchingOrderItemId = `00000000-0000-4000-8000-c1050${ordIdx}${tHex}000`;
        const ticketId = `00000000-0000-4000-8000-d3050${ordIdx}${tHex}000`;
        await prisma.ticket.upsert({
          where: { id: ticketId },
          update: {},
          create: {
            id: ticketId,
            eventId: event.id,
            orderId,
            orderItemId: matchingOrderItemId,
            ticketTypeId: priced.items[t]!.ticketTypeId,
            ownerHumanId: devHumanId,
            code: `DEV-${ordIdx}-${t}`,
            status: "VALID",
            issuedAt: occurredAt,
          },
        });
        totalTickets++;
      }
    }

    totalOrders++;
  }

  // ── Tag events that received real Stripe orders + slide them to "now" ──
  // Prepend "[STRIPE]" to the event title so devs can visually identify which
  // events have working payment data for refunds, fee lookups, etc.
  //
  // Also force their start window to "1 hour from now → 4 hours from now"
  // so they're immediately scannable for QA — without this, scanner gating
  // (admit window, etc.) would block any same-day testing on a fresh seed.
  // Set the window to start slightly in the past and end in a few hours so
  // events with Stripe demo data are immediately scannable in dev.
  const stripeStartsAt = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
  const stripeEndsAt = new Date(Date.now() + 3 * 60 * 60 * 1000); // +3h
  for (const eventId of stripeEnabledEventIds) {
    const evt = await prisma.event.findUnique({
      where: { id: eventId },
      select: { title: true },
    });
    if (!evt) continue;
    const titleUpdate = evt.title.includes("[STRIPE]")
      ? {}
      : { title: `[STRIPE] ${evt.title}` };
    await prisma.event.update({
      where: { id: eventId },
      data: {
        ...titleUpdate,
        startsAt: stripeStartsAt,
        endsAt: stripeEndsAt,
      },
    });
    console.log(
      `    Tagged event ${eventId.slice(-6)} → [STRIPE] ${evt.title.replace(/^\[STRIPE\] /, "")} (now scannable)`,
    );
  }

  console.log(
    `  Seeded ${totalOrders} dev-login orders with ${totalTickets} tickets (all real Stripe PIs)`,
  );
};

// ── Human-event orders ───────────────────────────────────────────────────

/**
 * Seeds orders from random buyers against the dev-login user's personal events
 * so the admin dashboard shows a non-zero "Pending Payout" figure.
 *
 * Requires `stripeSecretKey` for real PaymentIntents on SUCCEEDED/PART_REFUNDED
 * orders. Without it the function is skipped entirely to avoid fake PI IDs.
 */
export const seedHumanEventOrders = async (
  prisma: PrismaClient,
  humanEvents: Array<{ id: string; slug: string; title: string }>,
  opts?: { stripeSecretKey?: string },
) => {
  if (humanEvents.length === 0) {
    console.log("  No human-owned events -- skipping human-event order seed.");
    return;
  }

  // ── Guard: require a real Stripe key ─────────────────────────────────
  if (!opts?.stripeSecretKey) {
    console.log("");
    console.log(
      "  ╔══════════════════════════════════════════════════════════════════╗",
    );
    console.log(
      "  ║  STRIPE_SECRET_KEY is NOT set — skipping human-event orders.    ║",
    );
    console.log(
      "  ║                                                                  ║",
    );
    console.log(
      "  ║  Human-event orders require real Stripe PaymentIntents so that   ║",
    );
    console.log(
      "  ║  refund quotes, fee lookups, and payout flows work correctly.    ║",
    );
    console.log(
      "  ║                                                                  ║",
    );
    console.log(
      "  ║  To seed these orders, set STRIPE_SECRET_KEY in .env.local       ║",
    );
    console.log(
      "  ║  (use a Stripe test-mode key, e.g. sk_test_...) and re-run:     ║",
    );
    console.log(
      "  ║                                                                  ║",
    );
    console.log(
      "  ║    pnpm -F api seed:dev                                          ║",
    );
    console.log(
      "  ║                                                                  ║",
    );
    console.log(
      "  ╚══════════════════════════════════════════════════════════════════╝",
    );
    console.log("");
    return;
  }

  console.log(
    "Seeding orders for human-owned events (with real Stripe PaymentIntents)...",
  );

  const stripe = new Stripe(opts.stripeSecretKey, {
    apiVersion: "2025-08-27.basil" as any,
  });

  const repos = createPrismaRepos(prisma);

  // Re-use the buyer humans already created by seedDemoOrders
  const buyerIds = await prisma.human.findMany({
    where: { id: { startsWith: "00000000-0000-4000-8000-0000d1" } },
    select: { id: true },
  });

  if (buyerIds.length === 0) {
    console.log("  No buyer humans found -- skipping human-event orders.");
    return;
  }

  // Deterministic seeded random
  let rngState = 9999;
  const nextRng = () => {
    rngState = (rngState * 1664525 + 1013904223) & 0x7fffffff;
    return rngState / 0x7fffffff;
  };

  let totalOrders = 0;
  let totalTickets = 0;

  for (let evtIdx = 0; evtIdx < humanEvents.length; evtIdx++) {
    const event = humanEvents[evtIdx]!;
    const ticketTypes = await prisma.ticketType.findMany({
      where: { eventId: event.id, status: "ACTIVE" },
      select: { id: true, name: true, priceCents: true },
    });
    if (ticketTypes.length === 0) continue;
    const eventPricing = await tryLoadSeedEventPricing(prisma, repos, event.id);
    if (!eventPricing) continue;

    const orderCount = 3 + Math.floor(nextRng() * 3);
    for (let ordIdx = 0; ordIdx < orderCount; ordIdx++) {
      const buyerHumanId =
        buyerIds[Math.floor(nextRng() * buyerIds.length)]!.id;
      const ticketType =
        ticketTypes[Math.floor(nextRng() * ticketTypes.length)]!;
      const qty = 1 + Math.floor(nextRng() * 3);
      const statusRoll = nextRng();
      let rolledStatus: OrderStatus;
      if (statusRoll < 0.7) rolledStatus = "SUCCEEDED";
      else if (statusRoll < 0.8) rolledStatus = "PART_REFUNDED";
      else if (statusRoll < 0.88) rolledStatus = "PENDING";
      else if (statusRoll < 0.94) rolledStatus = "CANCELLED";
      else rolledStatus = "SUCCEEDED"; // was DISPUTED — no product path writes it

      const daysAgo = Math.floor(nextRng() * 20);
      const occurredAt = new Date(Date.now() - daysAgo * DAY_MS);

      const evtHex = evtIdx.toString(16).padStart(2, "0");
      const ordHex = ordIdx.toString(16).padStart(3, "0");
      const orderId = `00000000-0000-4000-8000-f0${evtHex}0${ordHex}0000`;
      const plan = planWebOrder(
        eventPricing,
        [{ ticketTypeId: ticketType.id, qty }],
        occurredAt,
        rolledStatus,
      );
      const priced = plan.priced;
      let status = plan.status;

      // One OrderItem per ticket (qty:1 each). A PART_REFUNDED order had its
      // LAST ticket refunded by refundOrderItems; carts (PENDING / CANCELLED)
      // were never charged and no cancel path touches their items.
      const orderItems = priced.items.map((item, t) => ({
        ...item,
        id: `00000000-0000-4000-8000-f1${evtHex}0${ordHex}${t.toString(16).padStart(2, "0")}00`,
        amountCents: item.unitPriceCents,
      }));
      let refundedItemIds = new Set<string>(
        status === "PART_REFUNDED"
          ? [orderItems[orderItems.length - 1]!.id]
          : [],
      );

      // Create a real Stripe PaymentIntent for charged orders
      const isCart = status === "PENDING" || status === "CANCELLED";
      const totalChargeCents = priced.chargeCents;
      let stripePaymentIntentId: string | null = null;

      if (!isCart && totalChargeCents >= STRIPE_MIN_AMOUNT_CENTS) {
        stripePaymentIntentId = await createConfirmedPaymentIntent(stripe, {
          amountCents: totalChargeCents,
          currency: "usd",
          metadata: { orderId, eventId: event.id, source: "human-event-seed" },
        });
      }
      // Refund state is written only if Stripe actually refunded.
      if (refundedItemIds.size > 0) {
        const refunded =
          stripePaymentIntentId !== null &&
          (await refundSeedOrderOnStripe(stripe, {
            kind: "items",
            paymentIntentId: stripePaymentIntentId,
            orderId,
            ticketItems: orderItems,
            order: priced,
            refundedItemIds,
          }));
        if (!refunded) {
          status = "SUCCEEDED";
          refundedItemIds = new Set();
        }
      }

      await prisma.order.upsert({
        where: { id: orderId },
        update: {},
        create: {
          id: orderId,
          eventId: event.id,
          buyerHumanId,
          ...pricedOrderColumns(priced),
          currency: "usd",
          status,
          occurredAt,
          stripePaymentIntentId,
          source: "PRIMARY",
        },
      });
      await writeSeedTaxLines(prisma, repos, orderId, priced);

      const refundStamps = refundStampsFor(orderItems, priced);
      for (const item of orderItems) {
        await prisma.orderItem.upsert({
          where: { id: item.id },
          update: {},
          create: {
            id: item.id,
            orderId,
            kind: "ticket",
            ticketTypeId: item.ticketTypeId,
            qty: 1,
            unitPriceCents: item.unitPriceCents,
            amountCents: item.amountCents,
            meta: item.meta,
            ...(refundedItemIds.has(item.id)
              ? {
                  status: "refunded",
                  refundedAt: seedRefundedAt(occurredAt, DAY_MS),
                  ...refundStamps(item.id),
                }
              : {}),
          },
        });
      }

      // Skip ticket creation for PENDING (not paid) and CANCELLED orders
      if (!isCart) {

        await Promise.all(
          Array.from({ length: qty }, (_, t) => {
            const tHex = t.toString(16);
            const tHexPad = t.toString(16).padStart(2, "0");
            const matchingOrderItemId = `00000000-0000-4000-8000-f1${evtHex}0${ordHex}${tHexPad}00`;
            const ticketId = `00000000-0000-4000-8000-f2${evtHex}0${ordHex}00${tHex}0`;
            const ticketCode = `HSEED-E${evtHex}-${String(parseInt(ordHex, 16)).padStart(3, "0")}-${t}`;
            return prisma.ticket.upsert({
              where: { id: ticketId },
              update: {},
              create: {
                id: ticketId,
                eventId: event.id,
                orderId,
                orderItemId: matchingOrderItemId,
                ticketTypeId: ticketType.id,
                ownerHumanId: buyerHumanId,
                code: ticketCode,
                // A refunded item's ticket is REFUNDED, as the refund paths set it.
                status: refundedItemIds.has(matchingOrderItemId)
                  ? ("REFUNDED" as const)
                  : ("VALID" as const),
                issuedAt: occurredAt,
              },
            });
          }),
        );

        totalTickets += qty;
      }

      totalOrders++;
    }
  }

  console.log(
    `  Seeded ${totalOrders} human-event orders with ${totalTickets} tickets across ${humanEvents.length} events`,
  );
};

// ── POS cash & comp sales (no Stripe required) ───────────────────────────

/**
 * Seeds a few in-person cash sales per spec FR-015 so the admin order list
 * and event reports show the new `paymentChannel="CASH"` channel in action.
 *
 * Includes one $0 "comp" sale per event to exercise the comp-as-cash path.
 * `recordCashSale` writes it like any other cash sale — `source: "PRIMARY"`
 * at $0 — so it is not a COMP-source order.
 *
 * No Stripe key required — cash sales never touch a payment processor.
 * Tickets are minted SCANNED with `scannedAt` and an ACCEPTED `TicketScan`
 * row (`message: "POS_CASH_AUTO_ADMIT"`), mirroring `recordCashSale`'s
 * FR-013 auto-admit. The row is what the venue track record counts as
 * attendance (R11), so without it these walk-ins vanish from dev stats.
 */
export const seedDemoCashSales = async (
  prisma: PrismaClient,
  publishedEvents: Array<{ id: string; slug: string; title: string }>,
) => {
  if (publishedEvents.length === 0) {
    console.log("  No published events -- skipping cash sale seed.");
    return;
  }

  console.log("Seeding demo POS cash + comp sales (no Stripe required)...");

  // `recordCashSale` records no platform fee and an EMPTY snapshot — there is
  // no fee mode on a cash sale — and its items carry no buyer totals.
  const feePolicySnapshot = {};

  // Use first 3 published events for cash demo data
  const events = publishedEvents.slice(0, 3);

  // Reuse the first buyer fixture as the operator-attributed buyer for seeded
  // cash sales. In production each cash sale creates a phantom POS_WALKUP
  // Human (FR-004); for seed simplicity we attach to a known human so admin
  // views render a name instead of "Walk-up".
  const operatorBuyerId = `00000000-0000-4000-8000-0000d100${"0".repeat(4)}`;
  await prisma.human.upsert({
    where: { id: operatorBuyerId },
    update: { name: "Seed Cash Buyer", status: "ACTIVE" },
    create: {
      id: operatorBuyerId,
      name: "Seed Cash Buyer",
      status: "ACTIVE",
      locale: "en",
    },
  });

  let totalOrders = 0;
  let totalTickets = 0;

  for (let evtIdx = 0; evtIdx < events.length; evtIdx++) {
    const event = events[evtIdx]!;
    const ticketTypes = await prisma.ticketType.findMany({
      where: { eventId: event.id },
      select: { id: true, name: true, priceCents: true },
    });
    if (ticketTypes.length === 0) continue;

    const evtHex = evtIdx.toString(16).padStart(2, "0");

    // Three sales per event: a single, a 2-ticket, and a $0 comp.
    const sales: Array<{ kind: "single" | "double" | "comp"; ttIdx: number }> =
      [
        { kind: "single", ttIdx: 0 },
        { kind: "double", ttIdx: Math.min(1, ticketTypes.length - 1) },
        { kind: "comp", ttIdx: 0 },
      ];

    for (let sIdx = 0; sIdx < sales.length; sIdx++) {
      const sale = sales[sIdx]!;
      const ticketType = ticketTypes[sale.ttIdx]!;
      const ticketCount = sale.kind === "double" ? 2 : 1;
      const unitPriceCents = sale.kind === "comp" ? 0 : ticketType.priceCents;
      const amountCents = unitPriceCents * ticketCount;

      const sHex = sIdx.toString(16).padStart(2, "0");
      // Last UUID segment must be exactly 12 hex chars. ca5(3)+evt(2)+0(1)+s(2)+0000(4) = 12.
      const orderId = `00000000-0000-4000-8000-ca5${evtHex}0${sHex}0000`;
      const occurredAt = new Date(Date.now() - (sIdx + 1) * 60 * 60 * 1000);

      await prisma.order.upsert({
        where: { id: orderId },
        update: {},
        create: {
          id: orderId,
          eventId: event.id,
          buyerHumanId: operatorBuyerId,
          amountGrossCents: amountCents,
          feesPlatformCents: 0,
          currency: "usd",
          status: "SUCCEEDED",
          paymentChannel: "CASH",
          feePolicySnapshot,
          occurredAt,
          stripePaymentIntentId: null,
          source: "PRIMARY",
        },
      });

      // One OrderItem per ticket (qty=1 each) — Ticket.orderItemId is
      // @unique, so multi-ticket sales need one OrderItem per ticket.
      // Matches the seedDemoOrders shape.
      for (let t = 0; t < ticketCount; t++) {
        const tHex = t.toString(16).padStart(2, "0");
        // 12 hex chars: cb5(3) + evt(2) + 0(1) + s(2) + t(2) + 00(2) = 12.
        // Prefix differentiates from the order row above (ca5 → cb5) so
        // OrderItem and Order IDs can't collide.
        const orderItemId = `00000000-0000-4000-8000-cb5${evtHex}0${sHex}${tHex}00`;
        await prisma.orderItem.upsert({
          where: { id: orderItemId },
          update: {},
          create: {
            id: orderItemId,
            orderId,
            kind: "ticket",
            ticketTypeId: ticketType.id,
            qty: 1,
            unitPriceCents,
            amountCents: unitPriceCents,
            meta: {},
          },
        });

        // 12 hex chars: cc5(3) + evt(2) + 0(1) + s(2) + t(2) + 00(2) = 12.
        // Prefix `cc5` keeps Ticket IDs distinct from the cash Order (ca5)
        // and OrderItem (cb5) IDs above so unique-id audits never collide.
        const ticketId = `00000000-0000-4000-8000-cc5${evtHex}0${sHex}${tHex}00`;
        const codeSuffix =
          sale.kind === "comp"
            ? "COMP"
            : sale.kind === "double"
              ? `D${t}`
              : "S";
        await prisma.ticket.upsert({
          where: { id: ticketId },
          update: {},
          create: {
            id: ticketId,
            eventId: event.id,
            orderId,
            orderItemId,
            ticketTypeId: ticketType.id,
            ownerHumanId: operatorBuyerId,
            code: `CASH-E${evtHex}-${sHex}-${codeSuffix}`,
            status: "SCANNED",
            issuedAt: occurredAt,
            scannedAt: occurredAt,
          },
        });
        // The auto-admit's scan-log row, as `recordCashSale` writes it. The
        // seed's buyer doubles as the operator (see `operatorBuyerId`).
        // 12 hex chars: cd5(3) + evt(2) + 0(1) + s(2) + t(2) + 00(2) = 12.
        const scanId = `00000000-0000-4000-8000-cd5${evtHex}0${sHex}${tHex}00`;
        await prisma.ticketScan.upsert({
          where: { id: scanId },
          update: {},
          create: {
            id: scanId,
            ticketId,
            eventId: event.id,
            actorHumanId: operatorBuyerId,
            scannedAt: occurredAt,
            outcome: "ACCEPTED",
            message: "POS_CASH_AUTO_ADMIT",
          },
        });
        totalTickets++;
      }

      totalOrders++;
    }
  }

  console.log(
    `  Seeded ${totalOrders} cash/comp sales with ${totalTickets} auto-admitted tickets across ${events.length} events`,
  );
};

// ── POS Tap-to-Pay sales (anonymous, paymentChannel=POS) ─────────────────

/**
 * Seeds a small number of in-person Tap-to-Pay sales per spec FR-004.
 *
 * Differs from seedDemoCashSales:
 *   - paymentChannel="POS" (Stripe-backed)
 *   - Each order creates a per-sale phantom Human (source=POS_WALKUP) to
 *     match the production walk-up flow exactly. ownerHumanId on the
 *     Ticket and buyerHumanId on the Order both point at this phantom row.
 *   - Includes one sale that is REFUNDED to populate the gate-refund UI.
 *
 * With a Stripe key each sale gets a real confirmed test-mode PaymentIntent
 * (the refunded one is refunded on Stripe too), so the processor-fee sweep
 * and refund flows see real objects. Without one `stripePaymentIntentId` is
 * null — never a fake `pi_seed_*`, which the sweep fails on and parks.
 */
export const seedDemoPosOrders = async (
  prisma: PrismaClient,
  publishedEvents: Array<{ id: string; slug: string; title: string }>,
  opts?: { stripeSecretKey?: string },
) => {
  if (publishedEvents.length === 0) {
    console.log("  No published events -- skipping POS order seed.");
    return;
  }

  console.log("Seeding demo POS Tap-to-Pay sales (paymentChannel=POS)...");

  // The caller does not pass the key yet; fall back to the env it loaded.
  const stripe = seedStripeFromEnv(opts?.stripeSecretKey);

  // `startPosSale` records no platform fee and an EMPTY snapshot — there is
  // no fee mode on a door sale — and its items carry no buyer totals.
  const feePolicySnapshot = {};

  // Use 3 events for variety; pick events 3-5 so they don't collide with
  // the cash-sales fixtures using events 0-2.
  const events = publishedEvents.slice(3, 6);
  if (events.length === 0) {
    console.log("  Not enough events for POS demo seed; skipping.");
    return;
  }

  // Three pre-allocated walk-up phantom Humans (DEMO_IDS.posWalkup1..3).
  // Each matches FR-004's contract: source=POS_WALKUP, no email, no name.
  const walkupIds = [
    DEMO_IDS.posWalkup1,
    DEMO_IDS.posWalkup2,
    DEMO_IDS.posWalkup3,
  ];

  for (const id of walkupIds) {
    await prisma.human.upsert({
      where: { id },
      update: { source: "POS_WALKUP" as never, status: "ACTIVE" },
      create: {
        id,
        name: null,
        status: "ACTIVE",
        source: "POS_WALKUP" as never,
      },
    });
  }

  let totalOrders = 0;
  let totalTickets = 0;
  let totalRefunds = 0;

  for (let evtIdx = 0; evtIdx < events.length; evtIdx++) {
    const event = events[evtIdx]!;
    const ticketTypes = await prisma.ticketType.findMany({
      where: { eventId: event.id, status: "ACTIVE" },
      select: { id: true, name: true, priceCents: true },
    });
    if (ticketTypes.length === 0) continue;

    const evtHex = evtIdx.toString(16).padStart(2, "0");
    const ticketType = ticketTypes[0]!;
    const unitPriceCents = ticketType.priceCents;

    // Three POS sales per event:
    //   - sale 0: single, walkup1, SCANNED (auto-admit)
    //   - sale 1: 2-pack, walkup2, SCANNED
    //   - sale 2: single, walkup3, REFUNDED (gate-refund demo)
    const sales: Array<{ qty: number; refunded: boolean; walkupId: string }> = [
      { qty: 1, refunded: false, walkupId: walkupIds[0]! },
      { qty: 2, refunded: false, walkupId: walkupIds[1]! },
      { qty: 1, refunded: true, walkupId: walkupIds[2]! },
    ];

    for (let sIdx = 0; sIdx < sales.length; sIdx++) {
      const sale = sales[sIdx]!;
      const amountCents = unitPriceCents * sale.qty;
      const sHex = sIdx.toString(16).padStart(2, "0");
      // Prefix `b05` (was `pos5` — non-hex). 12 hex chars: b05(3)+evt(2)+0(1)+s(2)+0000(4) = 12.
      const orderId = `00000000-0000-4000-8000-b05${evtHex}0${sHex}0000`;
      const occurredAt = new Date(Date.now() - (evtIdx + 1) * 30 * 60 * 1000);

      // The card-present charge is exactly the door total (no fee, no tax).
      let stripePaymentIntentId: string | null = null;
      const itemIdFor = (t: number) =>
        // Prefix `b06` (was `pos6` — non-hex). 12 hex chars: b06(3)+evt(2)+0(1)+s(2)+t(2)+00(2) = 12.
        `00000000-0000-4000-8000-b06${evtHex}0${sHex}${t.toString(16).padStart(2, "0")}00`;
      const ticketItems = Array.from({ length: sale.qty }, (_, t) => ({
        id: itemIdFor(t),
        amountCents: unitPriceCents,
        meta: {},
      }));
      const orderMoney = {
        amountGrossCents: amountCents,
        feesPlatformCents: 0,
        taxAmountCents: 0,
      };

      if (stripe && amountCents >= STRIPE_MIN_AMOUNT_CENTS) {
        stripePaymentIntentId = await createConfirmedPaymentIntent(stripe, {
          amountCents,
          currency: "usd",
          metadata: {
            orderId,
            eventId: event.id,
            paymentChannel: "POS",
            source: "pos-seed",
          },
        });
      }
      // The gate refund (refundPosSale → refundFullOrder: every item, less
      // Stripe's fee) is written only if Stripe actually refunded; keyless,
      // there is no charge to refund and the sale stays SUCCEEDED.
      const refunded =
        sale.refunded &&
        stripe !== null &&
        stripePaymentIntentId !== null &&
        (await refundSeedOrderOnStripe(stripe, {
          kind: "full",
          paymentIntentId: stripePaymentIntentId,
          orderId,
          ticketItems,
          order: orderMoney,
          refundedItemIds: new Set(ticketItems.map((item) => item.id)),
        }));

      await prisma.order.upsert({
        where: { id: orderId },
        update: {},
        create: {
          id: orderId,
          eventId: event.id,
          buyerHumanId: sale.walkupId,
          amountGrossCents: amountCents,
          feesPlatformCents: 0,
          currency: "usd",
          status: refunded ? "REFUNDED" : "SUCCEEDED",
          paymentChannel: "POS",
          feePolicySnapshot,
          occurredAt,
          stripePaymentIntentId,
          source: "PRIMARY",
        },
      });

      // One OrderItem per ticket — Ticket.orderItemId is @unique.
      const ticketStatus = refunded ? "REFUNDED" : "SCANNED";
      // refundPosSale delegates to refundFullOrder, which stamps every item.
      const refundStamps = refundStampsFor(ticketItems, orderMoney);
      for (let t = 0; t < sale.qty; t++) {
        const tHex = t.toString(16).padStart(2, "0");
        const orderItemId = itemIdFor(t);
        await prisma.orderItem.upsert({
          where: { id: orderItemId },
          update: {},
          create: {
            id: orderItemId,
            orderId,
            kind: "ticket",
            ticketTypeId: ticketType.id,
            qty: 1,
            unitPriceCents,
            amountCents: unitPriceCents,
            meta: {},
            ...(refunded
              ? {
                  status: "refunded",
                  refundedAt: seedRefundedAt(occurredAt, 5 * 60 * 1000),
                  ...refundStamps(orderItemId),
                }
              : {}),
          },
        });

        // Prefix `b07` (was `pos7` — non-hex). 12 hex chars: b07(3)+evt(2)+0(1)+s(2)+t(2)+00(2) = 12.
        const ticketId = `00000000-0000-4000-8000-b07${evtHex}0${sHex}${tHex}00`;
        await prisma.ticket.upsert({
          where: { id: ticketId },
          update: {},
          create: {
            id: ticketId,
            eventId: event.id,
            orderId,
            orderItemId,
            ticketTypeId: ticketType.id,
            ownerHumanId: sale.walkupId,
            code: `POS-E${evtHex}-${sHex}-T${t}`,
            status: ticketStatus as never,
            issuedAt: occurredAt,
            // A refund clears the stamp; the scan-log row below stays.
            scannedAt: refunded ? null : occurredAt,
          },
        });
        // Every POS card sale is auto-admitted on payment success
        // (`finalizeFromPaymentIntent`, `message: "POS_AUTO_ADMIT"`) — the
        // gate-refunded sale too, BEFORE its refund. Actor falls back to the
        // buyer exactly as the use case does without `metadata.actorHumanId`.
        // 12 hex chars: b08(3) + evt(2) + 0(1) + s(2) + t(2) + 00(2) = 12.
        const scanId = `00000000-0000-4000-8000-b08${evtHex}0${sHex}${tHex}00`;
        await prisma.ticketScan.upsert({
          where: { id: scanId },
          update: {},
          create: {
            id: scanId,
            ticketId,
            eventId: event.id,
            actorHumanId: sale.walkupId,
            scannedAt: occurredAt,
            outcome: "ACCEPTED",
            message: "POS_AUTO_ADMIT",
          },
        });
        totalTickets++;
      }

      totalOrders++;
      if (refunded) totalRefunds++;
    }
  }

  console.log(
    `  Seeded ${totalOrders} POS orders (${totalRefunds} refunded) with ${totalTickets} tickets across ${events.length} events`,
  );
};
