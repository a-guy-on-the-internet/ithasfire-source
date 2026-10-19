-- AlterTable
ALTER TABLE "EntityPage"
ADD COLUMN     "allowFollows" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "showFollowerCount" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "EntityFollow" (
    "id" TEXT NOT NULL,
    "followerHumanId" TEXT NOT NULL,
    "entityPageId" TEXT NOT NULL,
    "notifyNewEvents" BOOLEAN NOT NULL DEFAULT true,
    "notifyNearby" BOOLEAN NOT NULL DEFAULT false,
    "radiusKm" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EntityFollow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EntityFollow_followerHumanId_entityPageId_key" ON "EntityFollow"("followerHumanId", "entityPageId");
CREATE INDEX "EntityFollow_entityPageId_idx" ON "EntityFollow"("entityPageId");
CREATE INDEX "EntityFollow_followerHumanId_idx" ON "EntityFollow"("followerHumanId");

-- CreateTable
CREATE TABLE "human_stats" (
    "id" TEXT NOT NULL,
    "humanId" TEXT NOT NULL,
    "totalEventsPerformed" INTEGER NOT NULL DEFAULT 0,
    "totalTicketsAttributed" INTEGER NOT NULL DEFAULT 0,
    "avgDrawPerEvent" DOUBLE PRECISION,
    "topCities" JSONB,
    "topPlaceIds" JSONB,
    "topGenres" JSONB,
    "channelBreakdown" JSONB,
    "totalConsentedFans" INTEGER NOT NULL DEFAULT 0,
    "repeatFanCount" INTEGER NOT NULL DEFAULT 0,
    "followerCount" INTEGER NOT NULL DEFAULT 0,
    "last90DayTickets" INTEGER NOT NULL DEFAULT 0,
    "last90DayEvents" INTEGER NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "human_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_stats" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "totalEventsOrganized" INTEGER NOT NULL DEFAULT 0,
    "totalTicketsSold" INTEGER NOT NULL DEFAULT 0,
    "totalVenues" INTEGER NOT NULL DEFAULT 0,
    "avgTicketsPerEvent" DOUBLE PRECISION,
    "topPlaceIds" JSONB,
    "topArtistHumanIds" JSONB,
    "uniqueAttendees" INTEGER NOT NULL DEFAULT 0,
    "repeatAttendees" INTEGER NOT NULL DEFAULT 0,
    "attributionSummary" JSONB,
    "topGenres" JSONB,
    "followerCount" INTEGER NOT NULL DEFAULT 0,
    "last90DayTickets" INTEGER NOT NULL DEFAULT 0,
    "last90DayEvents" INTEGER NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_stats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "human_stats_humanId_key" ON "human_stats"("humanId");
CREATE INDEX "human_stats_humanId_idx" ON "human_stats"("humanId");
CREATE UNIQUE INDEX "org_stats_orgId_key" ON "org_stats"("orgId");
CREATE INDEX "org_stats_orgId_idx" ON "org_stats"("orgId");

-- AddForeignKey
ALTER TABLE "EntityFollow"
ADD CONSTRAINT "EntityFollow_followerHumanId_fkey" FOREIGN KEY ("followerHumanId") REFERENCES "Human"("id") ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "EntityFollow_entityPageId_fkey" FOREIGN KEY ("entityPageId") REFERENCES "EntityPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "human_stats"
ADD CONSTRAINT "human_stats_humanId_fkey" FOREIGN KEY ("humanId") REFERENCES "Human"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "org_stats"
ADD CONSTRAINT "org_stats_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
