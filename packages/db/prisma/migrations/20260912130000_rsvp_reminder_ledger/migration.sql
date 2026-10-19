-- RsvpReminder — durable send-ledger for the 24h-before community RSVP
-- reminder (community.rsvp-reminders-24h).
--
-- One row per (RSVP subject × human × CHANNEL) the job has claimed. The two
-- unique indexes ARE the idempotency guarantee: the job claims BEFORE it sends
-- (mirroring VolunteerShiftNotification, whose ledger is likewise keyed per
-- channel), so an overlapping cron tick, a re-run, or a Cloud Scheduler retry
-- loses the insert race and sends nothing.
--
-- PER CHANNEL, not per reminder. `notify` fans one reminder out to in-app /
-- push / email / sms and reports each channel's outcome SEPARATELY — a mailer
-- outage returns `email: { status: "failed" }` while the in-app row is already
-- persisted. A subject-level row could only record "the whole thing happened",
-- which made a failed email indistinguishable from a delivered one and left it
-- permanently excluded from the due set. Per channel, the delivered in-app
-- stays settled (no duplicate nudge) while the email retries next tick.
--
-- EXACTLY ONE of "eventDateId" / "eventId" is set:
--   • "eventDateId" — a per-date RSVP on a recurring listing (EventDateRsvp).
--     "eventId" is NULL; the event is reachable through the date.
--   • "eventId"     — an event-level RSVP on a single-date listing (EventRsvp).
--     "eventDateId" is NULL.
--
-- Two single-subject unique indexes rather than one composite: Postgres treats
-- NULLs as DISTINCT in a unique index, so a composite
-- (eventId, eventDateId, humanId, channel) index could not enforce the
-- event-level case at all, while a single (eventId, humanId, channel) index
-- would wrongly collapse "RSVP'd to three Wednesdays" into one reminder. Each
-- index therefore constrains exactly the rows whose own subject column is
-- non-null, and the CHECK below keeps the other column NULL so neither index
-- can be bypassed.
--
-- "claimedAt" / "sentAt" are TWO columns on purpose:
--   • "sentAt" NOT NULL                      → settled (delivered, or declined
--     by the channel itself — no push device, no email identity). Never
--     retried.
--   • "sentAt" NULL, "claimedAt" recent      → in flight; a tick owns it.
--   • "sentAt" NULL, "claimedAt" stale       → outstanding: the send failed and
--     released its claim, or the worker died between claim and send.
--     Re-claimable, so the job self-heals inside the 2h catch-up tail instead
--     of losing the reminder to a Cloud Run eviction. A release sets
--     "claimedAt" to the UNIX epoch so the very next tick retries.
-- A single `"sentAt" DEFAULT CURRENT_TIMESTAMP` written at CLAIM time made a
-- claimed-never-sent row byte-identical to a delivered one: unqueryable,
-- unalertable, permanently excluded. `count(*) WHERE "sentAt" IS NULL AND
-- "claimedAt" < now() - interval '1 hour'` is the leak metric.
--
-- Additive and re-applicable: new table only, nothing backfilled, no existing
-- column or constraint touched.

-- CreateTable
CREATE TABLE IF NOT EXISTS "RsvpReminder" (
    "id" TEXT NOT NULL,
    "eventDateId" TEXT,
    "eventId" TEXT,
    "humanId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "RsvpReminder_pkey" PRIMARY KEY ("id")
);

-- Exactly one subject. Without this a row could set BOTH columns and slip past
-- both unique indexes' intent (two reminders for one date).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'RsvpReminder_exactly_one_subject'
    ) THEN
        ALTER TABLE "RsvpReminder" ADD CONSTRAINT "RsvpReminder_exactly_one_subject" CHECK (
            ("eventDateId" IS NOT NULL AND "eventId" IS NULL)
            OR ("eventDateId" IS NULL AND "eventId" IS NOT NULL)
        );
    END IF;
END $$;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "RsvpReminder_eventDateId_humanId_channel_key" ON "RsvpReminder"("eventDateId", "humanId", "channel");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "RsvpReminder_eventId_humanId_channel_key" ON "RsvpReminder"("eventId", "humanId", "channel");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RsvpReminder_humanId_idx" ON "RsvpReminder"("humanId");

-- CreateIndex
-- Serves the outstanding-claim scan the due-set query runs on every tick, and
-- the leak metric above.
CREATE INDEX IF NOT EXISTS "RsvpReminder_sentAt_claimedAt_idx" ON "RsvpReminder"("sentAt", "claimedAt");

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'RsvpReminder_eventDateId_fkey'
    ) THEN
        ALTER TABLE "RsvpReminder" ADD CONSTRAINT "RsvpReminder_eventDateId_fkey"
            FOREIGN KEY ("eventDateId") REFERENCES "EventDate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'RsvpReminder_eventId_fkey'
    ) THEN
        ALTER TABLE "RsvpReminder" ADD CONSTRAINT "RsvpReminder_eventId_fkey"
            FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'RsvpReminder_humanId_fkey'
    ) THEN
        ALTER TABLE "RsvpReminder" ADD CONSTRAINT "RsvpReminder_humanId_fkey"
            FOREIGN KEY ("humanId") REFERENCES "Human"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
