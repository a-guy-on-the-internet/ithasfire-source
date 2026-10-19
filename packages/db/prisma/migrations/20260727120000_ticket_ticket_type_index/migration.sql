-- Index for `countIssuedForTicketType`, the issued half of ticket-type
-- capacity accounting.
--
-- The existing unique index leads with "orderId" so it cannot serve a lookup
-- by "ticketTypeId" alone, and Postgres does not auto-index foreign keys. POS
-- capacity checks now run this count while holding the per-ticket-type
-- advisory lock, so a sequential scan here serialises every concurrent seller
-- at the door behind a full scan of the Ticket table.

-- CreateIndex
CREATE INDEX "Ticket_ticketTypeId_idx" ON "Ticket"("ticketTypeId");
