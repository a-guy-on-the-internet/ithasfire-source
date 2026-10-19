-- Order.stripeInvoiceId — the idempotency key for membership invoice orders.
--
-- Membership invoices are materialised as Orders (kind = MEMBERSHIP, eventId
-- NULL) so settlement, refunds, the ledger and dispute holds work unchanged.
-- `invoice.payment_succeeded` is the event that mints one, and Stripe redelivers
-- webhooks freely — so the column is UNIQUE, which makes a replay collide in the
-- database rather than mint a second order against the same invoice.
--
-- Belt and braces on purpose. The use case ALSO checks an idempotency key on the
-- Stripe event id and re-reads by invoice id inside the transaction; this index
-- is the last line of defence, the one that holds when two deliveries race past
-- both application-level checks concurrently.
--
-- Nullable with no backfill: every existing row is a ticketing order and has no
-- invoice. NULLs do not participate in a Postgres unique index, so ticketing
-- orders are unconstrained by it no matter how many there are.
--
-- Both statements are cheap:
--   * ADD COLUMN of a nullable column with no default does not rewrite the table.
--   * The unique index is built over an all-NULL column on existing rows.
--
-- NOTE for the eventual production run: CREATE UNIQUE INDEX takes an ACCESS
-- EXCLUSIVE lock. On a large Order table prefer CREATE UNIQUE INDEX
-- CONCURRENTLY, which cannot run inside Prisma's per-migration transaction and
-- therefore needs to be applied out-of-band.

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "stripeInvoiceId" VARCHAR(255);

-- CreateIndex
CREATE UNIQUE INDEX "Order_stripeInvoiceId_key" ON "Order"("stripeInvoiceId");
