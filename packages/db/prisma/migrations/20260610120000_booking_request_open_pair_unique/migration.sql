-- DB backstop for the one-open-request-per-(performer, place) rule
-- (booking-request-and-agreement-editor.spec.yaml FR-001). The use-case
-- pre-check in create-booking-request races under concurrency; this partial
-- unique index makes the loser fail with P2002, which the adapter maps to
-- the same `duplicate_open_request` domain error.
--
-- Partial indexes are not expressible in the Prisma schema — this index is
-- SQL-only (noted on the BookingRequest model in agreement.prisma).
CREATE UNIQUE INDEX "BookingRequest_open_pair_key" ON "BookingRequest"("performerOwnerType","performerOwnerId","placeId") WHERE status IN ('PENDING','VIEWED');
