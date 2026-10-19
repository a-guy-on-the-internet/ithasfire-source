import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type {
  EventVolunteerRoleWithShiftsRecord,
  VolunteerAskRecord,
  VolunteerGroupWithRosterInfoRecord,
  VolunteerSignupRecord,
} from "@th/ports/repos/volunteering";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { resolveAskOwnership } from "./_shared/resolve-ask-ownership";
import { listAskRosterInputSchema } from "./schemas";

// ── Deps ────────────────────────────────────────────────────────────────────

export type ListAskRosterDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

/** Role + acceptance/waitlist fill counts for the owner roster. */
export type AskRosterRole = EventVolunteerRoleWithShiftsRecord & {
  /** Accepted signups (APPROVED | CHECKED_IN) on the role. */
  acceptedCount: number;
  /** Waitlist depth (PENDING) on the role. */
  pendingCount: number;
};

export type ListAskRosterOutput = {
  ask: VolunteerAskRecord;
  roles: AskRosterRole[];
  /** Groups with coordinator display info + accepted member counts. */
  groups: VolunteerGroupWithRosterInfoRecord[];
  /** Unassigned APPROVED signups — one page of the ask's general pool. */
  generalPool: VolunteerSignupRecord[];
  /**
   * Opaque continuation cursor for the general pool. Null = exhausted.
   * `ask` / `roles` / `groups` are repeated on every page — clients use
   * page 1's metadata and concatenate `generalPool` across pages.
   */
  nextCursor: string | null;
};

/**
 * Owner view of a whole ask (FR-007): every role with fill counts, every
 * group with its coordinator + accepted member count, and one cursor page
 * of the general pool of unassigned approved signups. OWNER-ONLY —
 * coordinators use `listCoordinatorRoster`, which scopes reads to their
 * group (NFR-003).
 *
 * Composed from A2 primitives inside one tx. Per-role fill counts come
 * from `listSignupsByAsk` totals (3 count queries per role) because no
 * ask-scoped aggregate primitive exists yet — fine for an owner dashboard
 * with a handful of roles; an aggregate is a tracked follow-up if role
 * counts grow.
 */
export async function listAskRoster(
  deps: ListAskRosterDeps,
  rawInput: unknown,
): Promise<ListAskRosterOutput> {
  const input = parseInput(listAskRosterInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    const ask = await tx.volunteering.getAsk(input.askId);
    if (!ask) {
      throw fail("NOT_FOUND", {
        message: "ask_not_found",
        meta: { entity: "volunteer_ask" },
      });
    }

    await resolveAskOwnership(tx, ask, input.actorHumanId);

    const [rawRoles, groups, pool] = await Promise.all([
      tx.volunteering.listRolesByAsk(ask.id),
      tx.volunteering.listGroupsByAsk(ask.id),
      // Keyset page of the general pool — the cursor is the adapter's
      // opaque value-based (createdAt, id) keyset, passed through untouched.
      tx.volunteering.listSignupsByAskCursor(ask.id, {
        groupId: null,
        status: "APPROVED",
        cursor: input.cursor ?? null,
        limit: input.limit,
      }),
    ]);

    const roles: AskRosterRole[] = [];
    for (const role of rawRoles) {
      const [approved, checkedIn, pending] = await Promise.all([
        tx.volunteering.listSignupsByAsk(ask.id, {
          roleId: role.id,
          status: "APPROVED",
          limit: 1,
        }),
        tx.volunteering.listSignupsByAsk(ask.id, {
          roleId: role.id,
          status: "CHECKED_IN",
          limit: 1,
        }),
        tx.volunteering.listSignupsByAsk(ask.id, {
          roleId: role.id,
          status: "PENDING",
          limit: 1,
        }),
      ]);
      roles.push({
        ...role,
        acceptedCount: approved.pageInfo.total + checkedIn.pageInfo.total,
        pendingCount: pending.pageInfo.total,
      });
    }

    return {
      ask,
      roles,
      groups,
      generalPool: pool.items,
      nextCursor: pool.nextCursor,
    };
  });
}
