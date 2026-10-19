-- BookingHold.grantId: ON DELETE RESTRICT → NO ACTION
-- (holds-without-a-request, plan step 2; reviewer finding on step 1).
--
-- RESTRICT is checked for each row the moment it is deleted. An org delete
-- runs two cascades that meet at a BOOKER hold: holderOrgId CASCADE deletes
-- the hold, granteeOrgId CASCADE deletes its grant. If the grant's row goes
-- first, RESTRICT sees the hold still pointing at it and fails the whole
-- delete; if the hold goes first, it passes. Which one Postgres fires first
-- is not something to depend on. NO ACTION runs the same check at the end of
-- the statement, after both cascades have run, so the org delete passes
-- whatever the order, and deleting a grant that a surviving hold still rides
-- fails exactly as before.
--
-- Same SQL `prisma migrate diff` emits for `onDelete: NoAction`.

-- DropForeignKey
ALTER TABLE "BookingHold" DROP CONSTRAINT "BookingHold_grantId_fkey";

-- AddForeignKey
ALTER TABLE "BookingHold" ADD CONSTRAINT "BookingHold_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "PlaceBookingGrant"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
