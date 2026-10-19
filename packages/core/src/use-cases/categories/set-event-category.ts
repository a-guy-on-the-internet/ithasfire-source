import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { CategoryRecord } from "@th/ports/repos/categories";
import type { EventRecord } from "@th/ports/repos/events";
import type { Repos, TxRepos } from "@th/ports/repos";
import { categoryNames } from "@th/types";

import { parseInput } from "../../lib/io";
import { requireOrgMembership, ORG_EDIT_ROLES } from "../../lib/rbac";
import { fail } from "@th/errors";
import { ensureActorHoldsHumanEventRole } from "../../lib/event-edit-rights";
import { markForSearchReindex } from "../search/search-reindex-marks";
import { categoryNamesSchema } from "./_shared/category-output";

const SLUG_REGEX = /^[a-z0-9-]{2,32}$/;

export const setEventCategoryInput = z.object({
  actorHumanId: z.uuid(),
  eventId: z.uuid(),
  categorySlug: z.string().min(2).max(32).regex(SLUG_REGEX),
});

export const setEventCategoryOutput = z.object({
  eventId: z.uuid(),
  category: z.object({
    id: z.uuid(),
    slug: z.string().regex(SLUG_REGEX),
    name: z.string().min(2),
    names: categoryNamesSchema,
    sortOrder: z.number().int().min(0),
  }),
});

export type SetEventCategoryInput = z.infer<typeof setEventCategoryInput>;
export type SetEventCategoryOutput = z.infer<typeof setEventCategoryOutput>;

export type SetEventCategoryDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function setEventCategory(
  deps: SetEventCategoryDeps,
  rawInput: unknown,
): Promise<SetEventCategoryOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "setEventCategory" });

  const execute = async () => {
    const input = parseInput(setEventCategoryInput, rawInput);

    const { updatedEvent, category } = await deps.repos.tx(async (tx) => {
      const category = await ensureActiveCategory(tx, input.categorySlug);
      const event = await ensureEventAccessible(
        tx,
        input.eventId,
        input.actorHumanId,
      );
      ensureEventAllowsCategoryMutation(event);

      const updated = await tx.events.setCategory({
        eventId: event.id,
        categoryId: category.id,
      });

      const now = deps.clock.now();
      await tx.audit.log({
        entity: "event",
        entityId: event.id,
        action: "category_set",
        data: {
          actorHumanId: input.actorHumanId,
          categoryId: category.id,
          categorySlug: category.slug,
          previousCategoryId: event.categoryId,
        },
        at: now,
      });

      // The event document carries the category slug as a searchable tag.
      if (event.status === "PUBLISHED") {
        await markForSearchReindex(tx, [{ kind: "event", id: event.id }], now);
      }

      return { updatedEvent: updated, category };
    });

    return setEventCategoryOutput.parse({
      eventId: updatedEvent.id,
      category: {
        id: category.id,
        slug: category.slug,
        name: category.name,
        names: categoryNames(category),
        sortOrder: category.sortOrder,
      },
    });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("setEventCategory", execute);
  }

  return execute();
}

async function ensureActiveCategory(
  tx: TxRepos,
  slug: string,
): Promise<CategoryRecord> {
  const category = await tx.categories.getBySlug(slug);
  if (!category) {
    throw fail("CATEGORY_NOT_FOUND", { category: "INVALID_INPUT" });
  }
  if (!category.active) {
    throw fail("CATEGORY_INACTIVE");
  }
  return category;
}

async function ensureEventAccessible(
  tx: TxRepos,
  eventId: string,
  actorHumanId: string,
): Promise<EventRecord> {
  const event = await tx.events.getById(eventId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }

  if (event.orgId) {
    await requireOrgMembership({
      repos: tx,
      orgId: event.orgId,
      actorHumanId,
      roles: ORG_EDIT_ROLES,
      errorCode: "INSUFFICIENT_ROLE",
    });
  } else {
    await ensureActorHoldsHumanEventRole(tx.authz, event.humanId, actorHumanId);
  }

  return event;
}

function ensureEventAllowsCategoryMutation(event: EventRecord): void {
  if (event.status === "ARCHIVED") {
    throw fail("EVENT_ARCHIVED");
  }
  if (event.status === "CANCELLED" || event.status === "COMPLETED") {
    throw fail("EVENT_NOT_EDITABLE");
  }
}
