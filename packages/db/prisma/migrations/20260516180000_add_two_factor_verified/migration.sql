-- Better Auth's twoFactor plugin (>=1.6) writes a `verified` column on
-- enable() and reads it back on subsequent calls. The original schema
-- omitted the field, causing 2FA enable to 500 with an empty body.
-- Defaults to true so existing rows (none in prod yet) stay valid.
ALTER TABLE "auth_two_factor"
ADD COLUMN IF NOT EXISTS "verified" BOOLEAN NOT NULL DEFAULT true;
