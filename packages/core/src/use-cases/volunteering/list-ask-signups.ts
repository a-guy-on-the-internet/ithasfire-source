import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { OffsetPaginatedResult } from "@th/ports/pagination";
import type { Repos } from "@th/ports/repos";
import type { VolunteerSignupRecord } from "@th/ports/repos/volunteering";
import { fail, isAppError } from "@th/errors";

import { parseInput } from "../../lib/io";
import {
  ensureCoordinatorEmailVerified,
  OWNERSHIP_DENIAL_CODES,
} from "./_shared/require-coordinator-or-owner";
import { resolveAskOwnership } from "./_shared/resolve-ask-ownership";
import { listAskSignupsInputSchema } from "./schemas";

// ── Deps ────────────────────────────────────────────────────────────────────

export type ListAskSignupsDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

export type ListAskSignupsOutput = OffsetPaginatedResult<VolunteerSignupRecord>;

/** Default page size — the rosters' 200-cap convention. */
const SIGNUPS_PAGE_LIMIT = 200;

/**
 * Scoped signup listing for one ask — the flat query the roster
 * composites don't cover: the owner's PENDING review queue and per-group
 * member lists (FR-007 "owners see the whole ask"), and the coordinator's
 * view of the general pool for pool-pulls (FR-005 /
 * `coordinator_scope.may: pull from general pool`).
 *
 * Authorization (mirrors broadcast-to-roster's scope table):
 * - Ask OWNER (`resolveAskOwnership`): any scope + any filter. An
 *   owner-path GROUP target must belong to this ask; a foreign-ask group
 *   404s uniformly (assign-signup-to-group's convention — never confirm a
 *   foreign target exists).
 * - COORDINATOR (non-owner): ONLY
 *   (a) `GROUP` scope naming a group they coordinate on THIS ask,
 *       verified fresh in the same tx (NFR-002), or
 *   (b) `POOL` scope — the general pool they may pull from — provided
 *       they coordinate at least one group on this ask AND the effective
 *       status is APPROVED (pending/rejected unassigned signups are the
 *       owner's review queue, not the pool — reading them would exceed
 *       the coordinator grant).
 *   Everything else — ALL scope, another group, a foreign-ask group, a
 *   non-APPROVED pool read — rethrows the ORIGINAL ownership denial, so a
 *   cross-group coordinator is indistinguishable from a stranger (uniform
 *   `forbidden`, never a 404 — the anti-oracle rule from
 *   require-coordinator-or-owner).
 *
 * PII containment is structural (NFR-003): the single read goes through
 * `listSignupsByAsk` with the scope's own group filter (`groupId: <id>` /
 * `groupId: null`) — never a broad read filtered in memory. `roleId` is a
 * plain narrowing filter, not a trust boundary: a foreign roleId simply
 * matches nothing (the repo ANDs it with `askId`).
 *
 * `status` on POOL defaults to APPROVED — `{ groupId: null, status:
 * "APPROVED" }` IS the general pool per the repo contract. Owners may
 * override it (e.g. unassigned PENDING).
 */
export async function listAskSignups(
  deps: ListAskSignupsDeps,
  rawInput: unknown,
): Promise<ListAskSignupsOutput> {
  const input = parseInput(listAskSignupsInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    const ask = await tx.volunteering.getAsk(input.askId);
    if (!ask) {
      throw fail("NOT_FOUND", {
        message: "ask_not_found",
        meta: { entity: "volunteer_ask" },
      });
    }

    // Effective status: POOL without an explicit filter IS the general
    // pool (unassigned APPROVED — the repo contract's definition).
    const status =
      input.status ?? (input.scope.kind === "POOL" ? "APPROVED" : undefined);

    // ── Authorize ─────────────────────────────────────────────────────
    let via: "owner" | "coordinator";
    try {
      await resolveAskOwnership(tx, ask, input.actorHumanId);
      via = "owner";
    } catch (error) {
      if (!(isAppError(error) && OWNERSHIP_DENIAL_CODES.has(error.code))) {
        // Structural failure (subject row gone, …) — propagate; it is
        // not a "maybe coordinator" situation.
        throw error;
      }

      if (input.scope.kind === "GROUP") {
        const group = await tx.volunteering.getGroup(input.scope.groupId);
        if (
          !group ||
          group.askId !== ask.id ||
          group.coordinatorHumanId === null ||
          group.coordinatorHumanId !== input.actorHumanId
        ) {
          throw error;
        }
      } else if (input.scope.kind === "POOL") {
        // The pool grant exists so a coordinator can PULL approved
        // volunteers into their group — APPROVED rows only, and only
        // for someone holding a coordinator seat on this ask. The
        // groups read is metadata (names, counts, coordinators), not
        // volunteer PII — same seat-finding as list-coordinator-roster.
        if (status !== "APPROVED") {
          throw error;
        }
        const groups = await tx.volunteering.listGroupsByAsk(ask.id);
        const coordinatesHere = groups.some(
          (group) =>
            group.coordinatorHumanId !== null &&
            group.coordinatorHumanId === input.actorHumanId,
        );
        if (!coordinatesHere) {
          throw error;
        }
      } else {
        // ALL scope is owner-only — the whole ask is exactly what
        // coordinator scope must not see (other groups' rosters).
        throw error;
      }
      await ensureCoordinatorEmailVerified(tx, input.actorHumanId);
      via = "coordinator";
    }

    // Owner-path GROUP targets must belong to this ask (foreign targets
    // 404 uniformly — broadcast-to-roster's convention).
    if (via === "owner" && input.scope.kind === "GROUP") {
      const group = await tx.volunteering.getGroup(input.scope.groupId);
      if (!group || group.askId !== ask.id) {
        throw fail("NOT_FOUND", {
          message: "group_not_found",
          meta: { entity: "volunteer_group" },
        });
      }
    }

    // Single scoped read (NFR-003) — the group/pool filter rides the
    // repo query, never an in-memory narrowing.
    return tx.volunteering.listSignupsByAsk(ask.id, {
      ...(input.roleId ? { roleId: input.roleId } : {}),
      ...(status ? { status } : {}),
      ...(input.scope.kind === "GROUP"
        ? { groupId: input.scope.groupId }
        : input.scope.kind === "POOL"
          ? { groupId: null }
          : {}),
      limit: input.limit ?? SIGNUPS_PAGE_LIMIT,
      offset: input.offset ?? 0,
    });
  });
}
