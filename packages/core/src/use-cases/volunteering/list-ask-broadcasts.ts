import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { VolunteerBroadcastRecord } from "@th/ports/repos/volunteering";
import { fail, isAppError } from "@th/errors";

import { parseInput } from "../../lib/io";
import {
  ensureCoordinatorEmailVerified,
  OWNERSHIP_DENIAL_CODES,
} from "./_shared/require-coordinator-or-owner";
import { resolveAskOwnership } from "./_shared/resolve-ask-ownership";
import { listAskBroadcastsInputSchema } from "./schemas";

// ── Deps ────────────────────────────────────────────────────────────────────

export type ListAskBroadcastsDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

export type ListAskBroadcastsOutput = {
  broadcasts: VolunteerBroadcastRecord[];
};

/**
 * Broadcast ledger read (FR-009's "recorded as a VolunteerBroadcast").
 *
 * - OWNER: every broadcast on the ask, newest first.
 * - COORDINATOR: only the slice they could have produced or received as a
 *   coordinator — broadcasts THEY sent, plus GROUP-scoped broadcasts
 *   targeting a group they currently coordinate. This is what the
 *   coordinator's composer history needs without leaking the owner's
 *   ALL/ROLE/POOL announcements or other groups' traffic (the roster
 *   PII-containment posture of NFR-003 applied to the ledger).
 * - Anyone else: the uniform ownership denial (`forbidden`, never an empty
 *   list — an empty 200 would double as an ask-existence probe; same rule
 *   as list-coordinator-roster).
 */
export async function listAskBroadcasts(
  deps: ListAskBroadcastsDeps,
  rawInput: unknown,
): Promise<ListAskBroadcastsOutput> {
  const input = parseInput(listAskBroadcastsInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    const ask = await tx.volunteering.getAsk(input.askId);
    if (!ask) {
      throw fail("NOT_FOUND", {
        message: "ask_not_found",
        meta: { entity: "volunteer_ask" },
      });
    }

    let ownGroupIds: Set<string> | null = null; // null = owner (unfiltered)
    try {
      await resolveAskOwnership(tx, ask, input.actorHumanId);
    } catch (error) {
      if (!(isAppError(error) && OWNERSHIP_DENIAL_CODES.has(error.code))) {
        throw error;
      }
      // Coordinator leg — group METADATA read only (no volunteer PII),
      // same primitive list-coordinator-roster uses to find the seat.
      const groups = await tx.volunteering.listGroupsByAsk(ask.id);
      const coordinated = groups.filter(
        (group) => group.coordinatorHumanId === input.actorHumanId,
      );
      if (coordinated.length === 0) {
        throw error;
      }
      await ensureCoordinatorEmailVerified(tx, input.actorHumanId);
      ownGroupIds = new Set(coordinated.map((group) => group.id));
    }

    const all = await tx.volunteering.listBroadcastsByAsk(ask.id);
    const broadcasts =
      ownGroupIds === null
        ? all
        : all.filter(
            (b) =>
              b.senderHumanId === input.actorHumanId ||
              (b.scopeType === "GROUP" &&
                b.scopeId !== null &&
                ownGroupIds.has(b.scopeId)),
          );

    return { broadcasts };
  });
}
