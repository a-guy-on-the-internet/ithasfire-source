-- freeze-the-deal (docs/specs/2026-10-14/freeze-the-deal.spec.yaml), review
-- round 1: index the FK added in 20261014120000_freeze_the_deal, so the
-- ON DELETE SET NULL from Human does not scan Event. Additive only.

-- CreateIndex
CREATE INDEX "Event_dealFrozenByHumanId_idx" ON "Event"("dealFrozenByHumanId");
