-- GDPR/CCPA right-to-erasure: make SupportThread.human_id nullable and switch
-- the FK from ON DELETE RESTRICT to ON DELETE SET NULL, mirroring the
-- event/order FKs on the same table. Deleting a Human now nulls each of their
-- threads' human_id (owner-less / staff-only) instead of blocking the delete.

-- DropForeignKey
ALTER TABLE "support_thread" DROP CONSTRAINT "support_thread_human_id_fkey";

-- AlterTable
ALTER TABLE "support_thread" ALTER COLUMN "human_id" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "support_thread" ADD CONSTRAINT "support_thread_human_id_fkey" FOREIGN KEY ("human_id") REFERENCES "Human"("id") ON DELETE SET NULL ON UPDATE CASCADE;
