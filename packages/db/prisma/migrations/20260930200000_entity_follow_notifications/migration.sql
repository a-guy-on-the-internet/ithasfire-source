CREATE TABLE "EntityEventNotice" (
 "id" TEXT PRIMARY KEY, "entityPageId" TEXT NOT NULL, "eventId" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "audienceCursor" TEXT, "expanded" BOOLEAN NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX "EntityEventNotice_entityPageId_eventId_key" ON "EntityEventNotice"("entityPageId","eventId");
CREATE INDEX "EntityEventNotice_expanded_createdAt_idx" ON "EntityEventNotice"("expanded","createdAt");
CREATE TABLE "EntityEventDelivery" (
 "id" TEXT PRIMARY KEY, "noticeId" TEXT NOT NULL REFERENCES "EntityEventNotice"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "humanId" TEXT NOT NULL, "followId" TEXT NOT NULL,
 "inAppDone" BOOLEAN NOT NULL DEFAULT false, "emailDone" BOOLEAN NOT NULL DEFAULT false, "pushDone" BOOLEAN NOT NULL DEFAULT false,
 "leaseToken" TEXT, "leaseUntil" TIMESTAMP(3), "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "attempts" INTEGER NOT NULL DEFAULT 0, "finishedAt" TIMESTAMP(3)
);
CREATE UNIQUE INDEX "EntityEventDelivery_noticeId_humanId_key" ON "EntityEventDelivery"("noticeId","humanId");
CREATE INDEX "EntityEventDelivery_finishedAt_nextAttemptAt_idx" ON "EntityEventDelivery"("finishedAt","nextAttemptAt");
