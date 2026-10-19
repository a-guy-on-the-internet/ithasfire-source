import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { resolveAskOwnership } from "./_shared/resolve-ask-ownership";
import { createVolunteerGroupInputSchema } from "./schemas";

// ── Deps ────────────────────────────────────────────────────────────────────

export type CreateVolunteerGroupDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

export type CreateVolunteerGroupOutput = { groupId: string };

// ── Use case ────────────────────────────────────────────────────────────────

/**
 * Create a volunteer group under an ask (FR-004). Groups are owner-only —
 * coordinators can never create groups (spec `coordinator_scope.may_not`),
 * which `resolveAskOwnership` enforces by construction.
 *
 * Group names are unique per ask; the adapter's
 * `{ code: "duplicate_group_name" }` conflict propagates untouched (same
 * convention as duplicate_role_name / duplicate_event_ask).
 */
export async function createVolunteerGroup(
  deps: CreateVolunteerGroupDeps,
  rawInput: unknown,
): Promise<CreateVolunteerGroupOutput> {
  const input = parseInput(createVolunteerGroupInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    const ask = await tx.volunteering.getAsk(input.askId);
    if (!ask) {
      throw fail("NOT_FOUND", {
        message: "ask_not_found",
        meta: { entity: "volunteer_ask" },
      });
    }

    await resolveAskOwnership(tx, ask, input.actorHumanId);

    if (ask.status === "ARCHIVED") {
      throw fail("CONFLICT", {
        message: "ask_archived",
        meta: { reason: "ask_archived" },
      });
    }

    const group = await tx.volunteering.createGroup({
      askId: input.askId,
      name: input.name,
      description: input.description ?? null,
      capacity: input.capacity ?? null,
    });

    await tx.audit.log({
      entity: "volunteer_group",
      entityId: group.id,
      action: "created",
      data: {
        askId: input.askId,
        name: input.name,
        actorHumanId: input.actorHumanId,
      },
      at: deps.clock.now(),
    });

    return { groupId: group.id };
  });
}
