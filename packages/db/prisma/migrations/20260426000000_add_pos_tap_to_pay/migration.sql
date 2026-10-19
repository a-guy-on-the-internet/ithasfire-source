-- Scanner POS / Tap to Pay groundwork.
--
-- Spec: docs/specs/2026-04-25/scanner-pos-tap-to-pay.spec.yaml
--
-- This migration is purely additive:
--   * `PaymentChannel` enum + `Order.paymentChannel` column (default WEB)
--     to tag in-person sales without forking the order/ledger pipelines.
--   * `HumanSource` enum + `Human.source` column (default WEB) so the
--     phantom Humans created by anonymous walk-up POS sales are
--     identifiable in audit / refund views and excluded from marketing
--     audiences by default.
--   * `TicketType.sellableAtDoor` + `TicketType.doorPriceCents` to let
--     orgs opt-in per ticket type and run advance/door price splits.
--   * `OrderItem.label` for freeform-amount merch sales at the POS
--     (kind="merch_freeform"). Stays nullable; ticket / discount /
--     fee lines don't use it.
--
-- No backfill is required — every defaulted value matches existing
-- semantics (all existing orders are WEB, all existing humans are WEB,
-- all existing ticket types are not sellable at the door yet).
--
-- The `OrderItem.kind` String column stays as-is. Conversion to a
-- proper Postgres enum is intentionally deferred to a dedicated
-- cleanup migration — the rename touches ~30 files of seeds + tests
-- and would gate this slice on a mechanical refactor.

-- CreateEnum
CREATE TYPE "PaymentChannel" AS ENUM ('WEB', 'POS');

-- CreateEnum
CREATE TYPE "HumanSource" AS ENUM ('WEB', 'POS_WALKUP', 'IMPORT');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "paymentChannel" "PaymentChannel" NOT NULL DEFAULT 'WEB';

-- AlterTable
ALTER TABLE "Human" ADD COLUMN "source" "HumanSource" NOT NULL DEFAULT 'WEB';

-- AlterTable
ALTER TABLE "TicketType" ADD COLUMN "sellableAtDoor" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "doorPriceCents" INTEGER;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN "label" VARCHAR(64);
