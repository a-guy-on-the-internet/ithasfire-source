-- Application-driven events, Phase 2 (docs/specs/2026-08-10/
-- application-driven-events.spec.md, item 1): application window, submission
-- cap, and auto-approve on the form.
--
--   opensAt        — window start; NULL = open immediately. Enforced
--                    server-side in submit-event-application
--                    (APPLICATION_WINDOW_NOT_OPEN before this instant).
--   closesAt       — window end; NULL = never closes
--                    (APPLICATION_WINDOW_CLOSED strictly after). Also the
--                    anchor for the nightly expiry sweep
--                    (events.expire-applications: PENDING past
--                    closesAt + grace → EXPIRED).
--   maxSubmissions — cap; NULL = uncapped. Counted over non-WITHDRAWN /
--                    non-EXPIRED submissions (APPLICATION_CAP_REACHED).
--   autoApprove    — "registration with questions" mode (parity with
--                    Event.volunteerAutoApprove): submissions land APPROVED
--                    with an unlock + approval token minted at submit.
--
-- Additive only. Instant on this table (ADD COLUMN with a NULL / non-volatile
-- default does not rewrite on PG 11+). Historical forms get NULL / false —
-- the correct values: no window, no cap, manual review. Reversible by
-- dropping the four columns.
ALTER TABLE "EventApplicationForm" ADD COLUMN "opensAt" TIMESTAMP(3),
ADD COLUMN "closesAt" TIMESTAMP(3),
ADD COLUMN "maxSubmissions" INTEGER,
ADD COLUMN "autoApprove" BOOLEAN NOT NULL DEFAULT false;
