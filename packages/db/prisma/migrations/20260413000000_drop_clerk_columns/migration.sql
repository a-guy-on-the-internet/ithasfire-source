-- DropClerkColumns
-- Removes stale Clerk linkage columns from Organization and OrgMember.
-- These columns were part of the Clerk-to-Better-Auth migration and are
-- no longer read or written by any application code.

-- Drop unique indexes first
DROP INDEX IF EXISTS "Organization_clerkOrgId_key";
DROP INDEX IF EXISTS "OrgMember_clerkMembershipId_key";

-- Drop columns
ALTER TABLE "Organization" DROP COLUMN IF EXISTS "clerkOrgId";
ALTER TABLE "OrgMember" DROP COLUMN IF EXISTS "clerkMembershipId";
