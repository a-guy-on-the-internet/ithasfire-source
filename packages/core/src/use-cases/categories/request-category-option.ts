import { z } from "zod";

import {
  eventCategoryRequestKindSchema,
  eventCategoryRequestRecordSchema,
} from "@th/schema";
import type { ClockPort } from "@th/ports/clock";
import type { ContentFilterPort } from "@th/ports/content-filter";
import type { LoggerPort } from "@th/ports/logger";
import type { CategoryRecord } from "@th/ports/repos/categories";
import type { EventRecord } from "@th/ports/repos/events";
import type { Repos, TxRepos } from "@th/ports/repos";
import {
  CATEGORY_NAME_LOCALES,
  isCategoryTranslationLocale,
} from "@th/types";

import { parseInput } from "../../lib/io";
import { ORG_EDIT_ROLES, requireOrgMembership } from "../../lib/rbac";
import { fail } from "@th/errors";
import { plainTextMultilineOptional } from "../../lib/sanitize-plain-text";
import { ensureActorHoldsHumanEventRole } from "../../lib/event-edit-rights";
import {
  assertCategoryNameFree,
  findCategoryByTranslatedName,
  CATEGORY_SLUG_REGEX,
  categoryNameInputSchema,
  normalizeAndValidateCategoryName,
  slugifyCategoryName,
} from "./_shared/category-naming";

export const requestCategoryOptionInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    eventId: z.uuid(),
    kind: eventCategoryRequestKindSchema,
    name: categoryNameInputSchema,
    categorySlug: z
      .string()
      .trim()
      .min(2)
      .max(40)
      .regex(CATEGORY_SLUG_REGEX)
      .optional(),
    note: plainTextMultilineOptional(1000).optional(),
    // The organiser's UI locale, so the approval form can put `name` under
    // that language (category-translations FR-007). Omitted = English.
    locale: z.enum(CATEGORY_NAME_LOCALES).optional(),
  })
  .strict();

export const requestCategoryOptionOutputSchema = z
  .object({
    request: eventCategoryRequestRecordSchema,
  })
  .strict();

export type RequestCategoryOptionInput = z.infer<
  typeof requestCategoryOptionInputSchema
>;
export type RequestCategoryOptionOutput = z.infer<
  typeof requestCategoryOptionOutputSchema
>;

export type RequestCategoryOptionDeps = {
  repos: Repos;
  clock: ClockPort;
  contentFilter: ContentFilterPort;
  logger?: LoggerPort;
};

export async function requestCategoryOption(
  deps: RequestCategoryOptionDeps,
  rawInput: unknown,
): Promise<RequestCategoryOptionOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "requestCategoryOption" });

  const execute = async (): Promise<RequestCategoryOptionOutput> => {
    const input = parseInput(requestCategoryOptionInputSchema, rawInput);
    const name = normalizeAndValidateCategoryName(input.name);
    const slug = slugifyCategoryName(name);
    const note = normalizeOptionalNote(input.note);
    await ensureRequestNamePassesContentFilter(deps.contentFilter, name);
    await ensureOptionalTextPassesContentFilter(deps.contentFilter, note);

    const request = await deps.repos.tx(async (tx) => {
      const event = await ensureEventAccessible(
        tx,
        input.eventId,
        input.actorHumanId,
      );
      ensureEventAllowsCategoryRequest(event);

      const categoryScope = await ensureCategoryRequestAvailable(
        tx,
        slug,
        name,
        input.locale ?? null,
      );

      const pending = await tx.categoryRequests.findPending({
        kind: input.kind,
        slug,
        categoryId: categoryScope?.id ?? null,
      });
      if (pending) {
        return pending;
      }

      const created = await tx.categoryRequests.create({
        kind: input.kind,
        name,
        slug,
        categoryId: categoryScope?.id ?? null,
        categorySlug: categoryScope?.slug ?? null,
        categoryName: categoryScope?.name ?? null,
        eventId: event.id,
        requesterHumanId: input.actorHumanId,
        reviewNote: note,
        locale: input.locale ?? null,
      });

      await tx.audit.log({
        entity: "event_category_request",
        entityId: created.id,
        action: "category_request.created",
        data: {
          actorHumanId: input.actorHumanId,
          eventId: event.id,
          kind: input.kind,
          slug,
          categoryId: categoryScope?.id ?? null,
          categorySlug: categoryScope?.slug ?? null,
          note,
          locale: input.locale ?? null,
        },
        at: deps.clock.now(),
      });

      return created;
    });

    return requestCategoryOptionOutputSchema.parse({ request });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("requestCategoryOption", execute);
  }

  return execute();
}

async function ensureRequestNamePassesContentFilter(
  contentFilter: ContentFilterPort,
  name: string,
): Promise<void> {
  if (await contentFilter.hasBlockedContent({ text: name })) {
    throw fail("INVALID_CATEGORY_REQUEST_NAME");
  }
}

async function ensureOptionalTextPassesContentFilter(
  contentFilter: ContentFilterPort,
  text: string | null,
): Promise<void> {
  if (!text) return;

  if (await contentFilter.hasBlockedContent({ text })) {
    throw fail("INVALID_CATEGORY_REQUEST_NAME");
  }
}

function normalizeOptionalNote(note: string | undefined): string | null {
  if (!note) return null;

  const normalized = note.normalize("NFKC").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

async function ensureCategoryRequestAvailable(
  tx: TxRepos,
  slug: string,
  name: string,
  locale: string | null,
): Promise<CategoryRecord | null> {
  const existing = await tx.categories.getBySlug(slug);
  if (existing) {
    throw fail("CATEGORY_ALREADY_EXISTS");
  }

  // A category can own this name under a different slug (its slug need not be
  // derived from its name). Approval would always refuse such a request, so
  // refuse it now, while the organiser is still looking at the form.
  const categories = await tx.categories.listAll();
  assertCategoryNameFree(categories, name);

  // Asked in another language: a category that already carries this name in
  // that language is the one they want (approval would resolve onto it), so
  // say so now instead of queueing a request.
  if (
    locale &&
    isCategoryTranslationLocale(locale) &&
    findCategoryByTranslatedName(categories, locale, name)
  ) {
    throw fail("CATEGORY_ALREADY_EXISTS", {
      meta: { field: "nameTranslations", locale },
    });
  }

  return null;
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

function ensureEventAllowsCategoryRequest(event: EventRecord): void {
  if (
    event.status === "ARCHIVED" ||
    event.status === "CANCELLED" ||
    event.status === "COMPLETED"
  ) {
    throw fail("EVENT_NOT_EDITABLE");
  }
}
