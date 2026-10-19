-- Ban that sticks, round 3 (2026-09-29): community edit suggestions stop
-- storing the submitter's raw IP. The per-IP flood cap now counts a keyed
-- HMAC of the IP (its own HKDF key — packages/core/src/lib/security/
-- network-identity.ts), and the retention job clears it after ~30 days.
--
-- EXPAND step of an expand/contract change: add the hash column and NULL the
-- raw values, so no raw IP remains at rest from this migration on. The
-- now-unused "submitterIp" column is dropped by a separate CONTRACT migration
-- in a later release, once no running deploy can still write it.
--
-- The raw values cannot be re-hashed here (the key is server-side only), so
-- suggestions pending right now lose their contribution to the 24h per-IP
-- cap — a soft anti-flood count.

-- AlterTable
ALTER TABLE "EventEditSuggestion" ADD COLUMN "submitterIpHash" TEXT;

-- Clear every raw IP.
UPDATE "EventEditSuggestion" SET "submitterIp" = NULL WHERE "submitterIp" IS NOT NULL;

-- CreateIndex
CREATE INDEX "EventEditSuggestion_submitterIpHash_createdAt_idx" ON "EventEditSuggestion"("submitterIpHash", "createdAt");
