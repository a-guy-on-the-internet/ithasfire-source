import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { linkablePageSlug } from "../../lib/entity-page-visibility";
import { parseInput } from "../../lib/io";

/**
 * Claimant-facing "my venue claims" query: a signed-in human sees the status
 * of every place-ownership claim + dispute THEY filed (all statuses), newest
 * first, each hydrated with the target place's name, directory slug, and
 * public entity-page slug (the one links are built from). Thin
 * wrapper over `placeVerificationRequests.listByClaimant` — no authz branch
 * beyond "you can only ever see your own rows" (the repo filters by the
 * actor's own humanId). Reviewer identity is never returned; the claimant
 * only sees the outcome (status, reviewedAt, reviewerNotes).
 */

export const listMyPlaceClaimsInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    cursor: z.string().min(1).nullable().optional(),
    // Ceiling matches the transport cursorPageInput (.max(100)) so a client
    // requesting 51–100 is clamped by the repo, not rejected here.
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict();

export const listMyPlaceClaimsOutputSchema = z
  .object({
    items: z.array(
      z
        .object({
          requestId: z.string(),
          placeId: z.string(),
          placeName: z.string(),
          /**
           * The venue's EntityPage slug — what `/p/[slug]` resolves on. Null
           * when the venue has no entity page, or when that page is PRIVATE
           * (it keeps its slug while the slug 404s for everyone). The UI must
           * then link to `/places/id/{placeId}` instead of a known 404.
           *
           * UNLISTED is deliberately KEPT: this is the claimant's own
           * authenticated list and IS the link that visibility level exists
           * for. See lib/entity-page-visibility.
           */
          placePageSlug: z.string().nullable(),
          source: z.enum(["OWNERSHIP_CLAIM", "OWNERSHIP_DISPUTE"]),
          // WITHDRAWN is included defensively: the DB enum allows it and a
          // claimant seeing their own withdrawn row must not 500 the list.
          status: z.enum([
            "PENDING",
            "IN_REVIEW",
            "APPROVED",
            "REJECTED",
            "WITHDRAWN",
          ]),
          ownerType: z.enum(["HUMAN", "ORGANIZATION"]),
          ownerId: z.string(),
          createdAt: z.date(),
          reviewedAt: z.date().nullable(),
          reviewerNotes: z.string().nullable(),
        })
        .strict(),
    ),
    nextCursor: z.string().nullable(),
  })
  .strict();

export type ListMyPlaceClaimsInput = z.infer<
  typeof listMyPlaceClaimsInputSchema
>;
export type ListMyPlaceClaimsOutput = z.infer<
  typeof listMyPlaceClaimsOutputSchema
>;

export type ListMyPlaceClaimsDeps = {
  repos: Pick<Repos, "placeVerificationRequests">;
  logger?: LoggerPort;
};

export async function listMyPlaceClaims(
  deps: ListMyPlaceClaimsDeps,
  rawInput: unknown,
): Promise<ListMyPlaceClaimsOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "listMyPlaceClaims" });

  const execute = async (): Promise<ListMyPlaceClaimsOutput> => {
    const input = parseInput(listMyPlaceClaimsInputSchema, rawInput);

    const page = await deps.repos.placeVerificationRequests.listByClaimant({
      claimantHumanId: input.actorHumanId,
      cursor: input.cursor ?? null,
      limit: input.limit,
    });

    const items = page.items.map((claim) => ({
      requestId: claim.requestId,
      placeId: claim.placeId,
      placeName: claim.placeName,
      placePageSlug: linkablePageSlug(
        claim.placePageSlug && claim.placePageVisibility
          ? {
              slug: claim.placePageSlug,
              visibility: claim.placePageVisibility,
            }
          : null,
      ),
      source: claim.source,
      status: claim.status,
      ownerType: claim.ownerType,
      ownerId: claim.ownerId,
      createdAt: claim.createdAt,
      reviewedAt: claim.reviewedAt,
      reviewerNotes: claim.reviewerNotes,
    }));

    return listMyPlaceClaimsOutputSchema.parse({
      items,
      nextCursor: page.nextCursor,
    });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("listMyPlaceClaims", execute);
  }

  return execute();
}
