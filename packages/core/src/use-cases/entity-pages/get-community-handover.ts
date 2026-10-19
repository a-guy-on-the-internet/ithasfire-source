/**
 * The owner's handover notice: what community moderators wrote on this
 * PLACE's page that the owner has not yet kept or cleared (moderator place
 * page spec docs/specs/2026-10-14/moderator-place-page.spec.yaml, D6,
 * FR-007a). Read from the `entity_page.community_updated` audit rows newer
 * than the page's latest `entity_page.community_handover` row
 * (community-handover-state.ts); `pending: null` when there are none.
 *
 * OWNER ONLY: `authz.canManagePlace` (a verified human owner, or an editor
 * of an owning org). A moderator, an ADMIN who is not an owner, and anyone
 * else are refused NOT_RESOURCE_OWNER: the decision is the owner's
 * (pro-social principle 4, D6), and the notice names the moderators.
 *
 * Lists ops and field names, never the written values: the owner sees the
 * page itself, and the values in the audit row are bounded evidence, not
 * content.
 */

import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { findPendingCommunityHandover } from "./community-handover-state";

export const getCommunityHandoverInputSchema = z
  .object({
    actorHumanId: z.string().min(1).max(200),
    placeId: z.string().uuid(),
  })
  .strict();

// Each change is tied to the moderator's account id (owner ruling
// 2026-10-16, spec R4, docs/specs/2026-10-14/moderator-place-page.spec.yaml).
// Only the place owner reads this (requirePlaceOwner, before any read).
const writerSchema = z
  .object({
    /** The moderator's account id (null-actor rows never become writers). */
    humanId: z.string(),
    /** Null when the human is gone or has no name. */
    name: z.string().nullable(),
    updateCount: z.number().int().positive(),
    firstUpdatedAt: z.string().datetime(),
    lastUpdatedAt: z.string().datetime(),
  })
  .strict();

const updateSchema = z
  .object({
    /** The writer's account id; null only for a malformed row (reported). */
    humanId: z.string().nullable(),
    /** The writer's name; null when unknown (or a malformed row, reported). */
    name: z.string().nullable(),
    op: z.string(),
    fields: z.array(z.string()),
    at: z.string().datetime(),
  })
  .strict();

export const getCommunityHandoverOutputSchema = z
  .object({
    placeId: z.string(),
    pageId: z.string().nullable(),
    pending: z
      .object({
        /** The previous Keep / Clear, if any. */
        sinceHandoverAt: z.string().datetime().nullable(),
        /** The oldest LISTED write (older ones exist when `truncated`). */
        firstUpdatedAt: z.string().datetime(),
        lastUpdatedAt: z.string().datetime(),
        /** Most recent writer first. */
        writers: z.array(writerSchema),
        /** Newest first, bounded (`truncated` says more exist). */
        updates: z.array(updateSchema),
        truncated: z.boolean(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type GetCommunityHandoverInput = z.infer<
  typeof getCommunityHandoverInputSchema
>;
export type GetCommunityHandoverOutput = z.infer<
  typeof getCommunityHandoverOutputSchema
>;

export type GetCommunityHandoverDeps = {
  authz: Pick<AuthZPort, "canManagePlace">;
  repos: Pick<Repos, "entityPages" | "audit" | "humans">;
  logger?: LoggerPort;
  /** Reports a malformed audit row (listed anyway; see the state module). */
  reportError?: ReporterPort;
};

/** The owner check shared by the read and the Keep / Clear action. */
export async function requirePlaceOwner(
  authz: Pick<AuthZPort, "canManagePlace">,
  actorHumanId: string,
  placeId: string,
): Promise<void> {
  const access = await authz.canManagePlace({ actorHumanId, placeId });
  if (!access.allowed) {
    throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "place" } });
  }
}

export async function getCommunityHandover(
  deps: GetCommunityHandoverDeps,
  rawInput: unknown,
): Promise<GetCommunityHandoverOutput> {
  const logger = deps.logger?.child({ useCase: "getCommunityHandover" });

  const execute = async (): Promise<GetCommunityHandoverOutput> => {
    const input = parseInput(getCommunityHandoverInputSchema, rawInput);
    await requirePlaceOwner(deps.authz, input.actorHumanId, input.placeId);

    const page = await deps.repos.entityPages.getByOwner("PLACE", input.placeId);
    if (!page) {
      // No page, so nobody wrote one.
      return { placeId: input.placeId, pageId: null, pending: null };
    }

    const pending = await findPendingCommunityHandover(
      deps.repos,
      page.id,
      deps.reportError,
    );
    if (!pending) {
      return getCommunityHandoverOutputSchema.parse({
        placeId: input.placeId,
        pageId: page.id,
        pending: null,
      });
    }

    // Writers in first-seen order of the newest-first list = most recent
    // writer first.
    const byWriter = new Map<
      string,
      { count: number; first: Date; last: Date }
    >();
    for (const update of pending.updates) {
      if (update.humanId === null) continue;
      const seen = byWriter.get(update.humanId);
      if (seen) {
        seen.count += 1;
        if (update.at < seen.first) seen.first = update.at;
        if (update.at > seen.last) seen.last = update.at;
      } else {
        byWriter.set(update.humanId, {
          count: 1,
          first: update.at,
          last: update.at,
        });
      }
    }
    const writerIds = [...byWriter.keys()];
    // Plain ids, no FK: a human deleted since shows without a name.
    const humans =
      writerIds.length > 0 ? await deps.repos.humans.getByIds(writerIds) : [];
    const names = new Map(humans.map((human) => [human.id, human.name]));

    // Newest first and never empty (a pending handover has a write).
    const updates = pending.updates;
    const newest = updates[0];
    const oldest = updates[updates.length - 1];
    return getCommunityHandoverOutputSchema.parse({
      placeId: input.placeId,
      pageId: page.id,
      pending: {
        sinceHandoverAt: pending.sinceHandoverAt?.toISOString() ?? null,
        firstUpdatedAt: oldest?.at.toISOString(),
        lastUpdatedAt: newest?.at.toISOString(),
        writers: [...byWriter.entries()].map(([humanId, seen]) => ({
          humanId,
          name: names.get(humanId) ?? null,
          updateCount: seen.count,
          firstUpdatedAt: seen.first.toISOString(),
          lastUpdatedAt: seen.last.toISOString(),
        })),
        updates: updates.map((update) => ({
          humanId: update.humanId,
          name:
            update.humanId === null ? null : (names.get(update.humanId) ?? null),
          op: update.op,
          fields: update.fields,
          at: update.at.toISOString(),
        })),
        truncated: pending.truncated,
      },
    });
  };

  if (logger) return logger.withTime("getCommunityHandover", execute);
  return execute();
}
