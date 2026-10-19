-- Push the default payout schedule for NEW payout terms from "week of event"
-- to "two weeks after". This only changes the column default — existing
-- PayoutTerms rows keep their stored value (the system uses copy-on-write
-- terms, so historical agreements are intentionally NOT backfilled).
ALTER TABLE "PayoutTerms"
  ALTER COLUMN "payoutSchedule" SET DEFAULT 'TWO_WEEKS_AFTER';
