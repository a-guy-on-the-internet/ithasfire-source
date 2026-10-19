-- ABSORB is removed (owner ruling 2026-10-01, docs/decisions/absorb-removed.md).
-- Step 3 of 3: every FeePolicy row that says ABSORB now says PASS_THROUGH,
-- whatever its scope or status.
--
-- Flipped in place rather than archived and re-pointed at the GLOBAL row:
--   * Terms pin a policy VERSION so a deal keeps the rates it was agreed
--     under. An EVENT or ORG policy can carry negotiated rates (fee %, caps,
--     fixed fee); re-pointing its pins at GLOBAL would change those rates as
--     well as the mode. The owner ruling changes only who pays the fees.
--   * Archiving an ACTIVE EVENT/ORG row would also move every UNPINNED event
--     in that scope onto GLOBAL rates at its next checkout.
--   * ARCHIVED rows are converted too: a pin to an archived row still
--     resolves (`feePolicies.getById` does not filter on status).
--
-- Past orders are unaffected. Each order snapshots the policy it was priced
-- under into `Order."feePolicySnapshot"` (id, version AND `feeMode`) and
-- stores its own amounts; refunds, settlement, net-kept, the buyer charge
-- breakdown and dispute evidence read those, never the live FeePolicy row.
-- The row's version history does lose the fact that it once said ABSORB;
-- the orders sold under it keep it.
--
-- ONE-WAY, for the reason given in 20261001230001: nothing afterwards records
-- which rows said ABSORB, and restoring them would reopen the mode.
--
-- Single statement. Idempotent: a second run matches nothing.
UPDATE "FeePolicy"
SET "feeMode" = 'PASS_THROUGH',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "feeMode" = 'ABSORB';
