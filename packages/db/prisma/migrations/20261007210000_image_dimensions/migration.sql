-- Intrinsic pixel size of an uploaded image, so the event poster can reserve
-- its box before the bytes load. Nullable: existing rows are backfilled
-- separately, and an unreadable header leaves them null.
ALTER TABLE "event_images" ADD COLUMN "width" INTEGER,
ADD COLUMN "height" INTEGER;
