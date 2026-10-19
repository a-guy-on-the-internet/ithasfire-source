-- Spec v1.3 follow-up to 20260426000000_add_pos_tap_to_pay.
--
--   * Drop `TicketType.sellableAtDoor` — door visibility is derived from
--     existing on-sale predicates (active, in sale window, capacity > 0)
--     instead of a per-row opt-in flag. See spec FR-001 / FR-002.
--   * Add `CASH` to the `PaymentChannel` enum so `recordCashSale` can
--     write Order.paymentChannel = 'CASH' for in-person cash + comp sales.
--     See spec FR-015.
--
-- No backfill needed: nothing reads sellableAtDoor yet (M1 just landed
-- today) and CASH is a new enum value with no existing rows referencing it.

-- AlterEnum
ALTER TYPE "PaymentChannel" ADD VALUE 'CASH';

-- AlterTable
ALTER TABLE "TicketType" DROP COLUMN "sellableAtDoor";
