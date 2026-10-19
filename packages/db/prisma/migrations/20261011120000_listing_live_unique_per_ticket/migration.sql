-- A ticket can be listed for resale again once its previous listing is over.
--
-- "Listing"."ticketId" carried a plain UNIQUE index ("Listing_ticketId_key"),
-- so a ticket could have ONE listing row for its whole life. A ticket whose
-- listing was CANCELLED, EXPIRED or SOLD could never be listed again: the
-- use-case pre-check in create-resale-listing only refuses a live listing,
-- the insert then violated the index, and the seller got a 500.
--
-- What this opens: a seller relisting after their own CANCELLED or EXPIRED
-- listing. What it does NOT open: a resale BUYER reselling the ticket they
-- bought. The old index refused that too (the SOLD listing they bought
-- through held the ticket's one row); create-resale-listing now refuses it
-- itself (TICKET_NOT_ELIGIBLE_FOR_RESALE, reason "bought_on_resale"),
-- because a second listing would break the refund unwind of the first sale.
-- At the index level a SOLD row no longer blocks an insert; the use case is
-- what keeps that door shut.
--
-- The rule that matters is "one LIVE listing per ticket", where live is
-- ACTIVE or HELD. Every past listing stays as its own row: it is the record
-- of what the ticket was offered for, what it sold for, and to whom.
--
-- The partial unique index below is the DB backstop for that rule. Two
-- relists racing past the use-case pre-check leave exactly one live row; the
-- loser fails with P2002, which the adapter (resale-listings.ts `create`)
-- maps to a `resale_listing_live_exists` conflict and create-resale-listing
-- turns into TICKET_NOT_ELIGIBLE_FOR_RESALE.
--
-- Partial indexes are not expressible in the Prisma schema — this index is
-- SQL-only (noted on the ResaleListing model in resale.prisma).
--
-- No down path: once any ticket has two listing rows, the old
-- one-row-per-ticket unique index cannot be put back.

-- Guard: the old index forbade two rows per ticket, so no ticket can have two
-- live listings today. If one somehow does, stop here. Never pick a winner:
-- which listing is real is a money question a person has to answer.
-- (Belt and braces: it runs while the old index still exists, so it cannot
-- fire on a database that index has been enforced on.)
DO $$
DECLARE
  offending integer;
BEGIN
  SELECT count(*) INTO offending
  FROM (
    SELECT "ticketId"
    FROM "Listing"
    WHERE status IN ('ACTIVE', 'HELD')
    GROUP BY "ticketId"
    HAVING count(*) > 1
  ) AS duplicates;

  IF offending > 0 THEN
    RAISE EXCEPTION
      'listing_live_unique_per_ticket: % ticket(s) have more than one ACTIVE/HELD resale listing. Resolve them by hand before applying this migration; it will not pick a winner.',
      offending;
  END IF;
END $$;

DROP INDEX "Listing_ticketId_key";

CREATE UNIQUE INDEX "Listing_ticketId_live_key" ON "Listing"("ticketId") WHERE status IN ('ACTIVE','HELD');

-- The dropped unique index also served every lookup by ticket and the
-- Ticket -> Listing foreign key's cascade scan. This one takes that over.
CREATE INDEX "Listing_ticketId_idx" ON "Listing"("ticketId");
