/**
 * Repair script: re-mint missing tickets for a specific order.
 *
 * Prior to the grouping fix in mint-tickets.ts, the idempotency check
 * used a per-type count but compared against a per-item quantity.
 * When computeOrderAmounts creates N items with qty=1 each (same ticketTypeId),
 * only the first item would get minted.  The fix groups items by ticketType
 * and uses the aggregate quantity, but orders finalised before the fix have
 * incomplete tickets.
 *
 * Usage (from repo root):
 *   DATABASE_URL=postgresql://... pnpm -F api exec tsx src/scripts/repair-mint-tickets.ts <orderId>
 */

import { getPrisma } from "@th/db";
import { createPrismaRepos } from "@th/adapters/db/prisma";
import { mintTicketsForOrder } from "@th/core/use-cases/tickets/mint-tickets";

async function main() {
  const orderId = process.argv[2];
  if (!orderId) {
    console.error(
      "Usage: pnpm -F api exec tsx src/scripts/repair-mint-tickets.ts <orderId>",
    );
    process.exit(1);
  }

  const prisma = getPrisma();
  const repos = createPrismaRepos(prisma);

  const result = await repos.tx(async (tx) => {
    const order = await tx.orders.getById(orderId);
    if (!order) {
      throw new Error(`Order ${orderId} not found`);
    }
    if (order.status !== "SUCCEEDED") {
      throw new Error(
        `Order ${orderId} status is ${order.status}, expected SUCCEEDED`,
      );
    }

    const ticketItems = order.items.filter((i) => i.kind === "ticket");
    console.log(`Order ${orderId}:`);
    console.log(`  status:       ${order.status}`);
    console.log(`  buyer:        ${order.buyerHumanId}`);
    console.log(`  items:        ${order.items.length}`);
    console.log(`  ticket items: ${ticketItems.length}`);

    const mintResult = await mintTicketsForOrder(tx, {
      order,
      issuedAt: new Date(),
      actor: { kind: "system", reason: "repair-mint-tickets script" },
    });

    return mintResult;
  });

  console.log(`\nMinted ${result.count} ticket(s):`);
  for (const ticket of result.tickets) {
    console.log(
      `  ${ticket.id}  code=${ticket.code}  orderItemId=${ticket.orderItemId}  seatId=${ticket.seatId ?? "(none)"}`,
    );
  }

  if (result.count === 0) {
    console.log(
      "  (all tickets were already issued — idempotent, no action taken)",
    );
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
