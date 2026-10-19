import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput, describeError } from "../../lib/io";
import { requireOwnerAccess, ORG_EDIT_ROLES } from "../../lib/rbac";
import { ensureEmailVerified } from "../_helpers/ensure-email-verified";
import {
  assertAudienceOwnedBy,
  MAX_AUDIENCE_FILTER_IDS,
} from "./audience-ownership";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

const audienceTypeSchema = z.enum([
  "ALL_TICKET_HOLDERS",
  "EVENT_TICKET_HOLDERS",
  "MULTIPLE_EVENTS",
  "EVENT_TICKET_TIER",
  "CONTACT_LIST",
  "WAITLIST_SUBSCRIBERS",
]);

const audienceFilterSchema = z
  .union([
    z.object({
      eventIds: z
        .array(z.string().uuid())
        .min(1)
        .max(MAX_AUDIENCE_FILTER_IDS),
    }),
    z.object({
      eventId: z.string().uuid(),
      tierIds: z.array(z.string().uuid()).min(1).max(MAX_AUDIENCE_FILTER_IDS),
    }),
  ])
  .optional()
  .nullable();

export const previewAudienceCountInputSchema = z
  .object({
    ownerType: z.enum(["HUMAN", "ORGANIZATION"]),
    ownerId: z.string().uuid(),
    actorHumanId: z.string().uuid(),
    audienceType: audienceTypeSchema,
    audienceRef: z.string().uuid().optional().nullable(),
    audienceFilter: audienceFilterSchema,
    excludedContactListId: z.string().uuid().optional().nullable(),
  })
  .strict();

export const previewAudienceCountOutputSchema = z.object({
  count: z.number().int().min(0),
});

export type PreviewAudienceCountInput = z.infer<
  typeof previewAudienceCountInputSchema
>;
export type PreviewAudienceCountOutput = z.infer<
  typeof previewAudienceCountOutputSchema
>;

export type PreviewAudienceCountDeps = {
  repos: Repos;
  logger: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

export async function previewAudienceCount(
  deps: PreviewAudienceCountDeps,
  rawInput: unknown,
): Promise<PreviewAudienceCountOutput> {
  const input = parseInput(previewAudienceCountInputSchema, rawInput);

  // Verified-email gate (security review F8): every announcements.* path
  // mails caller-written content, so an unverified account must not reach it.
  await ensureEmailVerified(deps.repos, input.actorHumanId);

  // ── RBAC: authorize based on owner type ───────────────────────────────
  await requireOwnerAccess({
    repos: deps.repos,
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    actorHumanId: input.actorHumanId,
    roles: ORG_EDIT_ROLES,
  });

  // Every referenced event / tier / list must belong to the owner, or the
  // count leaks another owner's audience size (security review F4).
  await assertAudienceOwnedBy(
    deps.repos,
    { ownerType: input.ownerType, ownerId: input.ownerId },
    {
      audienceType: input.audienceType,
      audienceRef: input.audienceRef,
      audienceFilter: input.audienceFilter,
      excludedContactListId: input.excludedContactListId,
    },
  );

  try {
    const count = await deps.repos.announcements.countAudienceRecipients({
      ownerType: input.ownerType,
      orgId: input.ownerId,
      audienceType: input.audienceType,
      audienceRef: input.audienceRef ?? undefined,
      audienceFilter: input.audienceFilter ?? undefined,
      excludedContactListId: input.excludedContactListId ?? undefined,
    });

    return { count };
  } catch (error) {
    deps.logger.error("preview_audience_count_failed", {
      ownerId: input.ownerId,
      audienceType: input.audienceType,
      error: describeError(error),
    });
    throw error;
  }
}
