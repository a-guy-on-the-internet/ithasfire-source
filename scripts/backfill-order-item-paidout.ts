import "dotenv/config";
import { prisma } from "@th/db";

async function main() {
  const dryRun =
    process.argv.includes("--dry-run") || process.argv.includes("-n");

  console.log(`Dry run: ${dryRun}`);

  // Count orders that have a paidOutAt set
  const ordersWithPaidOut = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT count(*) FROM "Order" WHERE "paidOutAt" IS NOT NULL
  `;
  const ordersCount = Number(ordersWithPaidOut[0]?.count ?? 0);

  // Count order items that already have paidOutAt set
  const itemsAlreadyPaidOut = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT count(*) FROM "OrderItem" WHERE "paidOutAt" IS NOT NULL
  `;
  const itemsAlreadyCount = Number(itemsAlreadyPaidOut[0]?.count ?? 0);

  console.log(`Orders with paidOutAt: ${ordersCount}`);
  console.log(`Order items already with paidOutAt: ${itemsAlreadyCount}`);

  // Count items that would be backfilled by the operation
  const wouldBackfill = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT count(*) FROM "OrderItem" oi
    JOIN "Order" o ON o.id = oi."orderId"
    WHERE o."paidOutAt" IS NOT NULL AND oi."paidOutAt" IS NULL
  `;
  const wouldBackfillCount = Number(wouldBackfill[0]?.count ?? 0);

  console.log(`OrderItems that would be backfilled: ${wouldBackfillCount}`);

  if (dryRun) {
    console.log("Dry run complete. No changes made.");
    process.exit(0);
  }

  if (wouldBackfillCount === 0) {
    console.log("Nothing to backfill. Exiting.");
    process.exit(0);
  }

  console.log("Running backfill update...");

  const res = await prisma.$executeRaw`
    UPDATE "OrderItem" SET "paidOutAt" = o."paidOutAt"
    FROM "Order" o
    WHERE "OrderItem"."orderId" = o.id
      AND o."paidOutAt" IS NOT NULL
      AND "OrderItem"."paidOutAt" IS NULL
  `;

  console.log(`Backfill complete. Rows affected (approx): ${res}`);

  // Recount to confirm
  const itemsAfter = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT count(*) FROM "OrderItem" WHERE "paidOutAt" IS NOT NULL
  `;
  console.log(
    `Order items with paidOutAt after backfill: ${Number(itemsAfter[0]?.count ?? 0)}`,
  );

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
