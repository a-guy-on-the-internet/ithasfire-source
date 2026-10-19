import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { ClockPort } from "@th/ports/clock";
import type { Repos } from "@th/ports/repos";
import type { AuthZPort } from "@th/ports/authz";

import { parseInput } from "../../../lib/io";
import { requirePlatformStaff } from "../../../lib/rbac";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

const featuredItemTypeSchema = z.enum([
  "EVENT",
  "HUMAN",
  "ORGANIZATION",
  "PLACE",
]);

export const removeFeaturedItemInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    itemType: featuredItemTypeSchema,
    itemId: z.string().uuid(),
  })
  .strict();

export const removeFeaturedItemOutputSchema = z
  .object({
    success: z.literal(true),
  })
  .strict();

export type RemoveFeaturedItemInput = z.infer<
  typeof removeFeaturedItemInputSchema
>;
export type RemoveFeaturedItemOutput = z.infer<
  typeof removeFeaturedItemOutputSchema
>;

export type RemoveFeaturedItemDeps = {
  repos: Pick<Repos, "featuredItems" | "audit" | "tx">;
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

export async function removeFeaturedItem(
  deps: RemoveFeaturedItemDeps,
  rawInput: unknown,
): Promise<RemoveFeaturedItemOutput> {
  const input = parseInput(removeFeaturedItemInputSchema, rawInput);

  await requirePlatformStaff({
    authz: deps.authz,
    actorHumanId: input.actorHumanId,
    roles: ["ADMIN", "REVIEWER", "SUPPORT", "DEVELOPER"],
  });

  await deps.repos.tx(async (tx) => {
    await tx.featuredItems.remove({
      itemType: input.itemType,
      itemId: input.itemId,
    });

    await tx.audit.log({
      entity: "FeaturedItem",
      entityId: `${input.itemType}:${input.itemId}`,
      action: "featured_item.remove",
      data: {
        actorHumanId: input.actorHumanId,
        itemType: input.itemType,
        itemId: input.itemId,
      },
    });
  });

  deps.logger?.info("removeFeaturedItem.completed", {
    itemType: input.itemType,
    itemId: input.itemId,
  });

  return removeFeaturedItemOutputSchema.parse({ success: true });
}
