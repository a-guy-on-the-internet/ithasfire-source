-- Venue → inquirer outreach (booking-inquirer-outreach, 2026-09-05).
--
-- Until now a venue reply on an ANONYMOUS embed inquiry reached nobody: the
-- notifier resolved zero recipients for a sender with no humanId, and the
-- notify() email channel refuses to send to an unverified identity anyway. The
-- fix mints a shadow Human on the venue's first reply and mails the inquirer
-- through a dedicated mailer. Two things have to be persisted for that.
--
-- 1. Threading. The FIRST outbound Message-ID is quoted by every later send in
--    In-Reply-To + References, so the whole booking reads as ONE chain in the
--    inquirer's mailbox instead of N unrelated emails. Deliberately NOT
--    unique: we mint the value ourselves, and a unique index would add a P2002
--    failure path to a best-effort post-commit send.
--
-- 2. Undeliverability. The platform-wide signal lives on
--    "AuthUser"."email_delivery_status", but the deliverability adapter
--    DELIBERATELY never flags an UNVERIFIED account (an unverified user may
--    have fat-fingered their address at sign-up; suppressing them would lock
--    them out forever). Every inquirer shadow is unverified by construction,
--    so a bounced venue reply would otherwise leave no trace the venue can
--    see. Reuses the existing "EmailDeliveryStatus" enum; only its two
--    suppressing values (BOUNCED | COMPLAINED) are ever written here.
--
-- All additive and nullable — nothing to backfill, no CHECK touched. The
-- sender-identity CHECK ("BookingRequest_sender_identity_check", migration
-- 20260713120000) already permits the shadow flip: it requires the owner pair
-- to be all-or-nothing and only demands contact fields when the row is
-- OWNERLESS, so an owned row that retains contactName/contactEmail passes.
ALTER TABLE "BookingRequest"
  ADD COLUMN "inquirerEmailMessageId" TEXT,
  ADD COLUMN "inquirerEmailUndeliverableAt" TIMESTAMP(3),
  ADD COLUMN "inquirerEmailUndeliverableStatus" "EmailDeliveryStatus";

-- The Resend bounce/complaint webhook only knows the ADDRESS, so it marks
-- affected inquiries by contactEmail alone. The existing composite
-- "BookingRequest_placeId_contactEmail_idx" cannot serve a leading-column-less
-- lookup. contactEmail is lowercased at rest, so plain equality matches.
CREATE INDEX "BookingRequest_contactEmail_idx" ON "BookingRequest"("contactEmail");
