import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { ListPendingEventEditSuggestionsScope } from "@th/ports/repos/event-edit-suggestions";
import { eventEditSuggestionRecordSchema, eventStatusSchema } from "@th/schema";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { ORG_EDIT_ROLES, requireOrgMembership } from "../../lib/rbac";
import { COMMUNITY_MODERATION_ROLES } from "./_shared/suggestion-validation";
import { ensureActorHoldsHumanEventRole } from "../../lib/event-edit-rights";

/**
 * FR-016 + the moderator queue (community-managed-event-listings spec): one
 * query, three scopes.
 *  - community        → all PENDING suggestions on COMMUNITY listings
 *                       (moderator queue: COMMUNITY_MODERATOR or ADMIN)
 *  - org:orgId        → PENDING across that org's events (owner-side inbox,
 *                       ORG_EDIT_ROLES)
 *  - event:eventId    → PENDING for one event; authz branches on the event's
 *                       approver side (COMMUNITY → moderator, org-owned →
 *                       org editor, personal → the humanId owner)
 *
 * Each row is hydrated with just enough event context for the queue UI
 * (id / title / slug / status) via the events bulk accessor. `status` lets
 * the queue mark a listing that is over (CANCELLED, ARCHIVED, COMPLETED):
 * APPROVE refuses there (`reviewEventEditSuggestion`), REJECT closes it out.
 */

const scopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("community") }).strict(),
  z.object({ kind: z.literal("org"), orgId: z.uuid() }).strict(),
  z.object({ kind: z.literal("event"), eventId: z.uuid() }).strict(),
]);

export const listPendingEditSuggestionsInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    scope: scopeSchema,
    cursor: z.string().min(1).nullable().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

const suggestionEventContextSchema = z
  .object({
    id: z.uuid(),
    title: z.string(),
    slug: z.string().nullable(),
    status: eventStatusSchema,
  })
  .strict();

export const listPendingEditSuggestionsOutputSchema = z
  .object({
    items: z.array(
      z
        .object({
          suggestion: eventEditSuggestionRecordSchema,
          event: suggestionEventContextSchema.nullable(),
          // Display name of a signed-in submitter (null for anonymous, or when
          // the human has no name set) so reviewers see a person, not a raw
          // UUID prefix. The IP/humanId itself is never exposed to the client.
          submitterName: z.string().nullable(),
        })
        .strict(),
    ),
    nextCursor: z.string().nullable(),
  })
  .strict();

export type ListPendingEditSuggestionsInput = z.infer<
  typeof listPendingEditSuggestionsInputSchema
>;
export type ListPendingEditSuggestionsOutput = z.infer<
  typeof listPendingEditSuggestionsOutputSchema
>;

export type ListPendingEditSuggestionsDeps = {
  repos: Repos;
  authz: Pick<AuthZPort, "hasStaffRole">;
  logger?: LoggerPort;
};

export async function listPendingEditSuggestions(
  deps: ListPendingEditSuggestionsDeps,
  rawInput: unknown,
): Promise<ListPendingEditSuggestionsOutput> {
  const scopedLogger = deps.logger?.child({
    useCase: "listPendingEditSuggestions",
  });

  const execute = async (): Promise<ListPendingEditSuggestionsOutput> => {
    const input = parseInput(listPendingEditSuggestionsInputSchema, rawInput);

    await ensureActorCanListScope(deps, input.scope, input.actorHumanId);

    const page = await deps.repos.eventEditSuggestions.listPending({
      scope: input.scope,
      cursor: input.cursor ?? null,
      limit: input.limit,
    });

    const eventIds = [
      ...new Set(page.items.map((suggestion) => suggestion.eventId)),
    ];
    const events =
      eventIds.length > 0
        ? await deps.repos.events.findManyByIds(eventIds)
        : [];
    const eventsById = new Map(events.map((event) => [event.id, event]));

    // Resolve signed-in submitters' display names in one batch so reviewers
    // see a person instead of a raw UUID prefix. Anonymous submitters
    // (no humanId) stay unnamed.
    const submitterIds = [
      ...new Set(
        page.items
          .map((suggestion) => suggestion.submitterHumanId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const submitters =
      submitterIds.length > 0
        ? await deps.repos.humans.getByIds(submitterIds)
        : [];
    const nameByHumanId = new Map(
      submitters.map((human) => [human.id, human.name]),
    );

    const items = page.items.map((suggestion) => {
      const event = eventsById.get(suggestion.eventId) ?? null;
      return {
        suggestion,
        event: event
          ? {
              id: event.id,
              title: event.title,
              slug: event.slug,
              status: event.status,
            }
          : null,
        submitterName: suggestion.submitterHumanId
          ? nameByHumanId.get(suggestion.submitterHumanId) ?? null
          : null,
      };
    });

    return listPendingEditSuggestionsOutputSchema.parse({
      items,
      nextCursor: page.nextCursor,
    });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("listPendingEditSuggestions", execute);
  }

  return execute();
}

async function ensureActorCanListScope(
  deps: ListPendingEditSuggestionsDeps,
  scope: ListPendingEventEditSuggestionsScope,
  actorHumanId: string,
): Promise<void> {
  if (scope.kind === "community") {
    const staff = await deps.authz.hasStaffRole({
      actorHumanId,
      requiredRoles: [...COMMUNITY_MODERATION_ROLES],
    });
    if (!staff.allowed) {
      throw fail("STAFF_ONLY");
    }
    return;
  }

  if (scope.kind === "org") {
    await requireOrgMembership({
      repos: deps.repos,
      orgId: scope.orgId,
      actorHumanId,
      roles: ORG_EDIT_ROLES,
      errorCode: "INSUFFICIENT_ROLE",
    });
    return;
  }

  // scope.kind === "event": authz follows the event's approver side (FR-008).
  const event = await deps.repos.events.getById(scope.eventId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }

  if (event.stewardship === "COMMUNITY") {
    const staff = await deps.authz.hasStaffRole({
      actorHumanId,
      requiredRoles: [...COMMUNITY_MODERATION_ROLES],
    });
    if (!staff.allowed) {
      throw fail("STAFF_ONLY");
    }
    return;
  }

  if (event.orgId) {
    await requireOrgMembership({
      repos: deps.repos,
      orgId: event.orgId,
      actorHumanId,
      roles: ORG_EDIT_ROLES,
      errorCode: "INSUFFICIENT_ROLE",
    });
    return;
  }

  await ensureActorHoldsHumanEventRole(
    deps.repos.authz,
    event.humanId,
    actorHumanId,
  );
}
