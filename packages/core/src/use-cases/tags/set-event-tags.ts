import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { EventRecord } from "@th/ports/repos/events";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { ensureOwnerOrCommunityModerator } from "../events/_shared/ensure-owner-or-community-moderator";
import { fail } from "@th/errors";

/**
 * Canonical slug form: lowercase, alphanumeric + hyphens, 2-48 chars.
 * We normalise display names to this form automatically.
 */
const TAG_SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,46}[a-z0-9]$/;

const tagItemSchema = z.object({
  slug: z.string().min(2).max(48).regex(TAG_SLUG_REGEX),
  name: z.string().min(1).max(64),
});

export const setEventTagsInput = z.object({
  actorHumanId: z.string().uuid(),
  eventId: z.string().uuid(),
  tags: z.array(tagItemSchema).max(10),
});

const tagRecordSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
});

export const setEventTagsOutput = z.object({
  eventId: z.string().uuid(),
  tags: z.array(tagRecordSchema),
});

export type SetEventTagsInput = z.infer<typeof setEventTagsInput>;
export type SetEventTagsOutput = z.infer<typeof setEventTagsOutput>;

export type SetEventTagsDeps = {
  repos: Repos;
  /**
   * Admits a community moderator to an ownerless listing's tags — see
   * {@link ensureOwnerOrCommunityModerator}. Required, not optional: an
   * omitted probe would fail closed and silently refuse every tag write on a
   * community listing.
   */
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function setEventTags(
  deps: SetEventTagsDeps,
  rawInput: unknown,
): Promise<SetEventTagsOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "setEventTags" });

  const execute = async () => {
    const input = parseInput(setEventTagsInput, rawInput);

    const result = await deps.repos.tx(async (tx) => {
      const event = await tx.events.getById(input.eventId);
      if (!event) {
        throw fail("EVENT_NOT_FOUND");
      }
      await ensureOwnerOrCommunityModerator(
        { repos: tx, authz: deps.authz },
        event,
        input.actorHumanId,
      );
      // Applies to EVERY actor, moderator included: the community arm above
      // opens WHO may set tags, never on WHAT. A dead listing stays frozen.
      ensureEventAllowsTagMutation(event);

      // Normalise: deduplicate by slug, assign sortOrder
      const seen = new Set<string>();
      const deduped: Array<{ slug: string; name: string; sortOrder: number }> =
        [];
      for (const tag of input.tags) {
        if (!seen.has(tag.slug)) {
          seen.add(tag.slug);
          deduped.push({
            slug: tag.slug,
            name: tag.name,
            sortOrder: deduped.length,
          });
        }
      }

      const eventTags = await tx.tags.setEventTags(event.id, deduped);

      const now = deps.clock.now();
      await tx.audit.log({
        entity: "event",
        entityId: event.id,
        action: "tags_set",
        data: {
          actorHumanId: input.actorHumanId,
          tags: deduped.map((t) => t.slug),
        },
        at: now,
      });

      return eventTags;
    });

    return setEventTagsOutput.parse({
      eventId: input.eventId,
      tags: result.map((et) => ({
        id: et.tag.id,
        slug: et.tag.slug,
        name: et.tag.name,
      })),
    });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("setEventTags", execute);
  }

  return execute();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureEventAllowsTagMutation(event: EventRecord): void {
  if (event.status === "ARCHIVED") {
    throw fail("EVENT_ARCHIVED");
  }
  if (event.status === "CANCELLED" || event.status === "COMPLETED") {
    throw fail("EVENT_NOT_EDITABLE");
  }
}
