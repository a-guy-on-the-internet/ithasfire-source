import type { PrismaClient } from "@prisma/client";

import { DEMO_IDS } from "./ids.js";

/**
 * Seeds a few EntityFollow rows so the consumer mobile app and web entity
 * pages have non-zero follower counts and the dev user has a populated
 * "following" feed.
 *
 * Specifically:
 *   - dev-login user follows: Bay Area Festivals (org), Austin Live Events
 *     (org), The Fillmore (place), Alex Rivera (human)
 *   - human2 (Alex Rivera) follows: Ithas Fire Demo Org, The Paramount
 *
 * Idempotent: upserts on the (followerHumanId, entityPageId) unique tuple.
 */
export const seedEntityFollows = async (prisma: PrismaClient) => {
  console.log("Seeding entity follows...");

  // Resolve entity pages by ownerType+ownerId (the unique key we know).
  const findPageId = async (
    ownerType: "ORGANIZATION" | "PLACE" | "HUMAN",
    ownerId: string,
  ): Promise<string | null> => {
    const page = await prisma.entityPage.findUnique({
      where: { ownerType_ownerId: { ownerType, ownerId } },
      select: { id: true },
    });
    return page?.id ?? null;
  };

  const targets: Array<{
    follower: string;
    ownerType: "ORGANIZATION" | "PLACE" | "HUMAN";
    ownerId: string;
    notifyNewEvents?: boolean;
    notifyNearby?: boolean;
  }> = [
    {
      follower: DEMO_IDS.devUser,
      ownerType: "ORGANIZATION",
      ownerId: DEMO_IDS.org3,
      notifyNewEvents: true,
    },
    {
      follower: DEMO_IDS.devUser,
      ownerType: "ORGANIZATION",
      ownerId: DEMO_IDS.org2,
      notifyNewEvents: true,
    },
    {
      follower: DEMO_IDS.devUser,
      ownerType: "ORGANIZATION",
      ownerId: DEMO_IDS.org4,
      notifyNewEvents: true,
    },
    {
      follower: DEMO_IDS.devUser,
      ownerType: "PLACE",
      ownerId: DEMO_IDS.place3,
      notifyNearby: true,
    },
    {
      follower: DEMO_IDS.devUser,
      ownerType: "HUMAN",
      ownerId: DEMO_IDS.human2,
    },
    {
      follower: DEMO_IDS.human2,
      ownerType: "ORGANIZATION",
      ownerId: DEMO_IDS.org,
      notifyNewEvents: true,
    },
    { follower: DEMO_IDS.human2, ownerType: "PLACE", ownerId: DEMO_IDS.place1 },
    { follower: DEMO_IDS.human3, ownerType: "PLACE", ownerId: DEMO_IDS.place4 },
    {
      follower: DEMO_IDS.human6,
      ownerType: "ORGANIZATION",
      ownerId: DEMO_IDS.org3,
    },
  ];

  let created = 0;
  for (const t of targets) {
    const pageId = await findPageId(t.ownerType, t.ownerId);
    if (!pageId) continue;

    await prisma.entityFollow.upsert({
      where: {
        followerHumanId_entityPageId: {
          followerHumanId: t.follower,
          entityPageId: pageId,
        },
      },
      update: {},
      create: {
        followerHumanId: t.follower,
        entityPageId: pageId,
        notifyNewEvents: t.notifyNewEvents ?? true,
        notifyNearby: t.notifyNearby ?? false,
      },
    });
    created++;
  }

  console.log(`  Seeded ${created} entity follows`);
};
