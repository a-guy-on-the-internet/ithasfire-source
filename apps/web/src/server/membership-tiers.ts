import "server-only";

import { cache } from "react";
import type { ListPublicTiersOutput } from "@th/core/use-cases/memberships";

import { getServerTrpcClient } from "@/server/trpc-client";

export type PublicMembershipTier = ListPublicTiersOutput["items"][number];

/**
 * Public ACTIVE membership tiers for an entity page's owner (HUMAN or
 * ORGANIZATION — PLACEs cannot own tiers). Drives the Membership tab on
 * /p/[slug]: a non-empty list renders the tab, an empty list hides it
 * (suspended owners return an empty list server-side, so the tab disappears
 * automatically).
 *
 * Failure-tolerant BY DESIGN: an entity page must never 500 because the
 * memberships router is down or unconfigured — errors degrade to "no tab".
 */
export const loadPublicMembershipTiers = cache(
  async (
    ownerType: "HUMAN" | "ORGANIZATION",
    ownerId: string,
  ): Promise<PublicMembershipTier[]> => {
    const client = getServerTrpcClient();
    try {
      const result = await client.memberships.tiers.listPublic.query({
        ownerType,
        ownerId,
      });
      return result.items;
    } catch (err) {
      console.error("loadPublicMembershipTiers failed", err);
      return [];
    }
  },
);
