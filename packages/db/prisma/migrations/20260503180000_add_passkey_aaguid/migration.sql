-- Add the `aaguid` column to the Better Auth Passkey table.
--
-- Better Auth's passkey plugin started writing the AAGUID (Authenticator
-- Attestation GUID, identifying the authenticator family, e.g. iCloud
-- Keychain vs 1Password vs a hardware key) in a recent release. Without
-- the column, every `verify-registration` call fails with:
--   PrismaClientValidationError: Unknown argument `aaguid`
-- Existing rows get NULL; historical authenticators are unidentifiable
-- but still functional.

ALTER TABLE "passkey" ADD COLUMN "aaguid" TEXT;
